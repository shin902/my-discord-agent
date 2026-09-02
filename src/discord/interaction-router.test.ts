import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.hoisted(() => vi.fn());
const mockGetDiscordCommand = vi.hoisted(() => vi.fn());
vi.mock("./command-registry.js", () => ({
  getDiscordCommand: mockGetDiscordCommand,
}));

const { createDiscordInteractionRouter, routeDiscordInteraction } =
  await import("./interaction-router.js");

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue(undefined);
  mockGetDiscordCommand.mockReset();
});

describe("routeDiscordInteraction", () => {
  it("looks up a command and passes the adapter context to execute", async () => {
    mockGetDiscordCommand.mockReturnValue({ execute: mockExecute });
    const interaction = { commandName: "example" };
    const context = { discordBotId: "secondary" };

    await routeDiscordInteraction(interaction as never, context);

    expect(mockGetDiscordCommand).toHaveBeenCalledWith("example");
    expect(mockExecute).toHaveBeenCalledWith(interaction, context);
  });

  it("ignores unknown chat-input commands", async () => {
    mockGetDiscordCommand.mockReturnValue(undefined);

    await routeDiscordInteraction({ commandName: "unknown" } as never, {
      discordBotId: "personal",
    });

    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("createDiscordInteractionRouter", () => {
  it("replies ephemerally when an unexpected error occurs before acknowledgement", async () => {
    const error = new Error("unexpected");
    mockGetDiscordCommand.mockReturnValue({
      execute: vi.fn().mockRejectedValue(error),
    });
    const interaction = {
      commandName: "example",
      deferred: false,
      replied: false,
      reply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    createDiscordInteractionRouter("personal")(interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalled());

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "コマンドの処理中に予期しないエラーが発生しました。",
      ephemeral: true,
    });
    vi.restoreAllMocks();
  });

  it("edits a deferred interaction for an unexpected error", async () => {
    const error = new Error("unexpected");
    mockGetDiscordCommand.mockReturnValue({
      execute: vi.fn().mockRejectedValue(error),
    });
    const interaction = {
      commandName: "example",
      deferred: true,
      replied: false,
      reply: vi.fn(),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    createDiscordInteractionRouter("personal")(interaction as never);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "コマンドの処理中に予期しないエラーが発生しました。",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("logs unexpected command failures without constructing runtime services", async () => {
    const error = new Error("unexpected");
    mockGetDiscordCommand.mockReturnValue({
      execute: vi.fn().mockRejectedValue(error),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    createDiscordInteractionRouter("personal")({
      commandName: "example",
    } as never);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

    expect(errorSpy).toHaveBeenCalledWith(
      "[handler] /example コマンドの処理に失敗しました:",
      error,
    );
    errorSpy.mockRestore();
  });
});
