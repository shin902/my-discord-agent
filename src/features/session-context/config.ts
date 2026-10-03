import { z } from "zod";

/** Channel-only context policy; omission preserves full history. */
export const SessionContextSchema = z.literal("final-only");
