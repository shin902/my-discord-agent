import type { Agent, CustomMessage } from "@earendil-works/pi-agent-core";
import { appendMessage } from "../agent/session.js";

export const STEERING_INSTRUCTION_TYPE = "steering-instruction";

type SteeringAgent = Pick<Agent, "steer">;

export interface SteeringController {
  /**
   * Persist and hand off a steering instruction to the currently attached
   * Agent. A successful result means the request was accepted by this run;
   * it does not claim that the model consumed the instruction.
   */
  receive(instruction: string): Promise<boolean>;
  attach(agent: SteeringAgent): void;
  close(): void;
  waitForPersistence(): Promise<void>;
}

/** Keep canonical persistence before the captured Agent.steer handoff. */
export function createSteeringController(
  groupName: string,
  sessionId: string,
): SteeringController {
  let agent: SteeringAgent | undefined;
  let closed = false;
  const persistence = new Set<Promise<void>>();

  return {
    receive(instruction) {
      const target = agent;
      if (closed || !target) return Promise.resolve(false);

      const message: CustomMessage = {
        role: "custom",
        customType: STEERING_INSTRUCTION_TYPE,
        content: instruction,
        display: false,
        timestamp: Date.now(),
      };
      const operation = (async () => {
        try {
          await appendMessage(groupName, sessionId, message);
          target.steer(message);
          return true;
        } catch {
          return false;
        }
      })();
      const tracked = operation.then(
        () => undefined,
        () => undefined,
      );
      persistence.add(tracked);
      void tracked.then(() => persistence.delete(tracked));
      return operation;
    },
    attach(nextAgent) {
      if (!closed) agent = nextAgent;
    },
    close() {
      closed = true;
      agent = undefined;
    },
    async waitForPersistence() {
      await Promise.all(persistence);
    },
  };
}
