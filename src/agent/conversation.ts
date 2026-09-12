import { z } from "zod";

/** Stable entry IDs within one group's canonical session database. */
export const ConversationEntriesSchema = z
  .object({
    userEntryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    assistantEntryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((entries) => entries.assistantEntryId > entries.userEntryId, {
    message: "assistant entry must follow the input user entry",
  });

export type ConversationEntries = z.infer<typeof ConversationEntriesSchema>;

/** Runner output metadata, not a success marker until the host commits it. */
export const CONVERSATION_ENTRIES_PREFIX = "__CONVERSATION_ENTRIES__:";
