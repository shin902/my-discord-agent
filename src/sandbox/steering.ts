import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { appendMessage } from "../agent/session.js";

export const STEERING_INSTRUCTION_TYPE = "steering-instruction";

type SteeringAgent = Pick<Agent, "steer">;
type SteeringRequest = {
  message: AgentMessage;
  instruction: string;
  resolve: (accepted: boolean) => void;
  settled: boolean;
  cancelled: boolean;
};

export interface SteeringController {
  /**
   * Accept a steer only after canonical persistence and Agent.steer handoff.
   * pi-agent-core exposes no event for the later point at which its queue is
   * consumed, so this does not claim that the model has seen the message.
   */
  receive(instruction: string): Promise<boolean>;
  attach(agent: SteeringAgent): void;
  close(): void;
  waitForPersistence(): Promise<void>;
}

/** Keep control transport, Agent.steer, and canonical trajectory in lockstep. */
export function createSteeringController(
  groupName: string,
  sessionId: string,
): SteeringController {
  let agent: SteeringAgent | undefined;
  let closed = false;
  const pending: SteeringRequest[] = [];
  const inFlight = new Set<SteeringRequest>();
  const persistence: Promise<void>[] = [];

  const settle = (request: SteeringRequest, accepted: boolean): void => {
    if (request.settled) return;
    request.settled = true;
    request.resolve(accepted);
  };

  const deliver = (
    request: SteeringRequest,
    nextAgent: SteeringAgent,
  ): void => {
    inFlight.add(request);
    const delivery = (async () => {
      try {
        // Persist first. Agent.steer is synchronous, but cannot be rolled back;
        // this ordering prevents an acknowledged steer from lacking a matching
        // canonical record. The tiny append/steer window is the unavoidable
        // atomicity boundary of the two APIs.
        await appendMessage(groupName, sessionId, {
          role: "custom",
          customType: STEERING_INSTRUCTION_TYPE,
          content: request.instruction,
          display: false,
          timestamp: request.message.timestamp,
        });
        if (request.cancelled || closed) {
          settle(request, false);
          return;
        }
        nextAgent.steer(request.message);
        settle(request, true);
      } catch {
        settle(request, false);
      }
    })();
    persistence.push(delivery);
    void delivery.finally(() => inFlight.delete(request));
  };

  return {
    receive(instruction) {
      if (closed) return Promise.resolve(false);
      const timestamp = Date.now();
      const message: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: instruction }],
        timestamp,
      };
      let resolve!: (accepted: boolean) => void;
      const delivery = new Promise<boolean>((promiseResolve) => {
        resolve = promiseResolve;
      });
      const request: SteeringRequest = {
        message,
        instruction,
        resolve,
        settled: false,
        cancelled: false,
      };
      if (agent) deliver(request, agent);
      else pending.push(request);
      return delivery;
    },
    attach(nextAgent) {
      if (closed) return;
      agent = nextAgent;
      for (const request of pending.splice(0)) deliver(request, nextAgent);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of pending.splice(0)) settle(request, false);
      for (const request of inFlight) {
        // Mark in-flight requests before their append continuation runs, so a
        // run that has ended cannot inject a message after close.
        request.cancelled = true;
        settle(request, false);
      }
    },
    async waitForPersistence() {
      await Promise.all(persistence);
    },
  };
}
