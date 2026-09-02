import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { appendMessage } from "../agent/session.js";

export const STEERING_INSTRUCTION_TYPE = "steering-instruction";

type SteeringAgent = Pick<Agent, "steer">;

export interface SteeringController {
  receive(instruction: string): void;
  attach(agent: SteeringAgent): void;
  waitForPersistence(): Promise<void>;
}

/** Keep control transport, Agent.steer, and canonical trajectory in lockstep. */
export function createSteeringController(
  groupName: string,
  sessionId: string,
): SteeringController {
  let agent: SteeringAgent | undefined;
  const pending: AgentMessage[] = [];
  const persistence: Promise<void>[] = [];

  return {
    receive(instruction) {
      const timestamp = Date.now();
      const message: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: instruction }],
        timestamp,
      };
      persistence.push(
        appendMessage(groupName, sessionId, {
          role: "custom",
          customType: STEERING_INSTRUCTION_TYPE,
          content: instruction,
          display: false,
          timestamp,
        }),
      );
      if (agent) agent.steer(message);
      else pending.push(message);
    },
    attach(nextAgent) {
      agent = nextAgent;
      for (const message of pending.splice(0)) agent.steer(message);
    },
    async waitForPersistence() {
      await Promise.all(persistence);
    },
  };
}
