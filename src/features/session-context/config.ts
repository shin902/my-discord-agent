import { z } from "zod";

/** Queue input context policy; omission preserves full history. */
export const SessionContextSchema = z.literal("final-only");

export type SessionContext = z.infer<typeof SessionContextSchema>;
