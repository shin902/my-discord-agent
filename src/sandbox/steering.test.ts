import { describe, expect, it, vi } from "vitest";
import { appendMessage } from "../agent/session.js";
import {
  createSteeringController,
  STEERING_INSTRUCTION_TYPE,
} from "./steering.js";

vi.mock("../agent/session.js", () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
}));

describe("steering controller", () => {
  it("calls Agent.steer and persists the exact distinguishable instruction", async () => {
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    controller.receive("API層は触らずUIだけ修正して");
    await controller.waitForPersistence();

    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "API層は触らずUIだけ修正して" }],
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "group",
      "session",
      expect.objectContaining({
        role: "custom",
        customType: STEERING_INSTRUCTION_TYPE,
        content: "API層は触らずUIだけ修正して",
        display: false,
      }),
    );
  });

  it("queues a steering instruction until the Agent is created", () => {
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.receive("queued");
    expect(steer).not.toHaveBeenCalled();
    controller.attach({ steer });
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "queued" }],
      }),
    );
  });
});
