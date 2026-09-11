import { z } from "zod";

/** Origin of a canonical user entry; independent of any downstream projection. */
export const SessionSourceSchema = z.object({
  kind: z.literal("discord"),
  sourceId: z.string().min(1),
  actorId: z.string().min(1),
  messageType: z.union([z.literal(0), z.literal(19)]),
  /** Original source event time, absent in older provenance records. */
  createdAt: z.iso.datetime().optional(),
});

export type SessionSource = z.infer<typeof SessionSourceSchema>;

/** Runtime attempt that produced an entry; not itself proof of committed success. */
export const SessionExecutionSchema = z.object({
  jobId: z.string().min(1),
  fencingToken: z.number().int().positive(),
});

export type SessionExecution = z.infer<typeof SessionExecutionSchema>;
