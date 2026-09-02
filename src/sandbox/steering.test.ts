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
  vi.mocked(appendMessage).mockClear();
});

describe("steering controller", () => {
  it("calls Agent.steer and persists the exact distinguishable instruction", async () => {
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    await expect(
      controller.receive("API層は触らずUIだけ修正して"),
    ).resolves.toBe(true);
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

  it("does not persist or ACK before a pre-attach steer is handed to Agent", async () => {
    const order: string[] = [];
    vi.mocked(appendMessage).mockImplementation(async () => {
      order.push("persist");
    });
    const steer = vi.fn(() => {
      order.push("steer");
    });
    const controller = createSteeringController("group", "session");
    const delivery = controller.receive("queued");

    expect(steer).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    controller.attach({ steer });

    await expect(delivery).resolves.toBe(true);
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "queued" }],
      }),
    );
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["persist", "steer"]);
  });

  it("settles an in-flight steer false on close without injecting it", async () => {
    let resolveAppend!: () => void;
    vi.mocked(appendMessage).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveAppend = resolve;
      }),
    );
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    const delivery = controller.receive("closing");
    controller.attach({ steer });
    controller.close();

    await expect(delivery).resolves.toBe(false);
    resolveAppend();
    await controller.waitForPersistence();
    expect(steer).not.toHaveBeenCalled();
  });

  it("does not inject a steer when canonical persistence fails", async () => {
    vi.mocked(appendMessage).mockRejectedValueOnce(new Error("disk full"));
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });

    await expect(controller.receive("unpersisted")).resolves.toBe(false);
    expect(steer).not.toHaveBeenCalled();
  });

  it("settles a pre-attach request false when the run closes", async () => {
    const controller = createSteeringController("group", "session");
    const delivery = controller.receive("never attached");
    controller.close();

    await expect(delivery).resolves.toBe(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects steering received after the Agent run is closed", async () => {
    const steer = vi.fn();
    const controller = createSteeringController("group", "session");
    controller.attach({ steer });
    controller.close();
    await expect(controller.receive("too late")).resolves.toBe(false);
    await controller.waitForPersistence();

    expect(steer).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
