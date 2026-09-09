import { MessageFlags } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  setDiscordSuppressEmbeds,
  withDiscordSendOptions,
} from "./send-options.js";

afterEach(() => {
  setDiscordSuppressEmbeds(true);
});

describe("Discord send options", () => {
  it("adds SuppressEmbeds to text payloads by default", () => {
    expect(withDiscordSendOptions("https://example.com/article")).toEqual({
      content: "https://example.com/article",
      flags: MessageFlags.SuppressEmbeds,
    });

    expect(
      withDiscordSendOptions({
        content: "https://example.com/article",
        allowedMentions: { parse: [], repliedUser: false },
      }),
    ).toEqual({
      content: "https://example.com/article",
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
    });
  });

  it("leaves payloads unchanged when embed suppression is disabled", () => {
    setDiscordSuppressEmbeds(false);
    const payload = {
      content: "https://example.com/article",
      allowedMentions: { parse: [], repliedUser: false },
    };

    expect(withDiscordSendOptions(payload)).toBe(payload);
    expect(withDiscordSendOptions("https://example.com/article")).toBe(
      "https://example.com/article",
    );
  });
});
