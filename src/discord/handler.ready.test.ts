import { Events } from "discord.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("./intake.js", () => ({
  handleLiveDiscordMessage: vi.fn(),
}));
vi.mock("./interaction-router.js", () => ({
  createDiscordInteractionRouter: vi.fn(() => vi.fn()),
}));

const { registerHandlers } = await import("./handler.js");

describe("registerHandlers ready lifecycle", () => {
  it("初回ready後も再readyでonReadyを再実行する", async () => {
    const onReady = vi.fn().mockResolvedValue(undefined);
    const client = { once: vi.fn(), on: vi.fn() };

    registerHandlers(client as never, onReady);

    const initialReady = client.once.mock.calls.find(
      ([event]) => event === Events.ClientReady,
    )?.[1] as
      | ((client: { user: { tag: string } }) => void)
      | undefined;
    if (!initialReady)
      throw new Error("ClientReady once handler was not registered");

    initialReady({ user: { tag: "test-bot" } });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

    const reconnectReady = client.on.mock.calls.find(
      ([event]) => event === Events.ClientReady,
    )?.[1] as
      | ((client: { user: { tag: string } }) => void)
      | undefined;
    if (!reconnectReady)
      throw new Error("ClientReady reconnect handler was not registered");

    reconnectReady({ user: { tag: "test-bot" } });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
  });
});
