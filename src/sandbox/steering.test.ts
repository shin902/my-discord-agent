import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendMessage } from "../agent/session.js";
import {
  createSteeringController,
  STEERING_INSTRUCTION_TYPE,
} from "./steering.js";

vi.mock("../agent/session.js", () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.mocked(appendMessage).mockReset();
  vi.mocked(appendMessage).mockResolvedValue(undefined);
});

describe("steering controller", () => {
  it("persists before handing the exact instruction to Agent.steer", async () => {
    const order: string[] = [];
    vi.mocked(appendMessage).mockImplementation(async () => {
      order.push("persist");
    });
    const steer = vi.fn(() => {
      order.push("steer");
    });
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    await expect(
      controller.receive("API層は触らずUIだけ修正して"),
    ).resolves.toBe(true);
    await controller.waitForPersistence();

    expect(order).toEqual(["persist", "steer"]);
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "custom",
        customType: STEERING_INSTRUCTION_TYPE,
        content: "API層は触らずUIだけ修正して",
      }),
    );
    expect(appendMessage).toHaveBeenCalledTimes(1);
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

  it("rejects without an attached active Agent and persists nothing", async () => {
    const controller = createSteeringController("group", "session");

    await expect(controller.receive("no active run")).resolves.toBe(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("does not hand off when canonical persistence fails", async () => {
    vi.mocked(appendMessage).mockRejectedValueOnce(new Error("disk full"));
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    await expect(controller.receive("unpersisted")).resolves.toBe(false);
    expect(steer).not.toHaveBeenCalled();
  });

  it("accepts the documented end race after persistence", async () => {
    let resolveAppend!: () => void;
    vi.mocked(appendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAppend = resolve;
      }),
    );
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    const delivery = controller.receive("finish now");
    controller.close();
    resolveAppend();

    await expect(delivery).resolves.toBe(true);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});
