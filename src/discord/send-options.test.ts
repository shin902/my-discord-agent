import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";
import { withDiscordSendOptions } from "./send-options.js";

describe("Discord send options", () => {
  it("adds SuppressEmbeds only to intermediate text chunks", () => {
    expect(withDiscordSendOptions("https://example.com/article", true)).toEqual(
      {
        content: "https://example.com/article",
        flags: MessageFlags.SuppressEmbeds,
      },
    );

    expect(
      withDiscordSendOptions(
        {
          content: "https://example.com/article",
          allowedMentions: { parse: [], repliedUser: false },
        },
        true,
      ),
    ).toEqual({
      content: "https://example.com/article",
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
    });
  });

  it("leaves the final and single-message payloads unchanged", () => {
    const payload = {
      content: "https://example.com/article",
      allowedMentions: { parse: [], repliedUser: false },
    };

    expect(withDiscordSendOptions(payload, false)).toBe(payload);
    expect(withDiscordSendOptions("https://example.com/article", false)).toBe(
      "https://example.com/article",
    );
  });
});
