import { z } from "zod";
import { fetchFxTwitter } from "./archive.js";

const Id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const Author = z.object({
  id: Id,
  screen_name: z.string().min(1),
  name: z.string(),
  avatar_url: z.string().nullable(),
  url: z.string().optional(),
});
const Facet = z.looseObject({
  type: z.string(),
  indices: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  original: z.string().optional(),
  replacement: z.string().optional(),
});
const Status = z.object({
  type: z.literal("status"),
  provider: z.literal("twitter"),
  id: Id,
  url: z.string(),
  text: z.string(),
  created_at: z.string(),
  author: Author,
  raw_text: z.object({
    text: z.string(),
    facets: z.array(Facet),
  }),
  // Preserve the full provider document, including blocks, entityMap and media.
  // The HTTP byte limit rejects oversized responses rather than truncating them.
  article: z
    .looseObject({
      id: z.string(),
      title: z.string(),
      content: z.record(z.string(), z.unknown()),
    })
    .nullish(),
});
const Tombstone = z.object({
  type: z.literal("tombstone"),
  provider: z.literal("twitter"),
  id: Id.optional(),
  reason: z.string(),
  message: z.string(),
  url: z.string().optional(),
  author: Author.partial().optional(),
});
// One quote level only: Status deliberately strips any nested quote.
const QuotedStatus = Status.extend({
  quote: z.union([Status, Tombstone]).nullish(),
});
export const XSavedThreadSchema = z.array(z.union([QuotedStatus, Tombstone]));
const ResponseSchema = z.object({
  code: z.literal(200),
  status: QuotedStatus,
  thread: XSavedThreadSchema.nullable(),
});

function snapshot(status: z.infer<typeof QuotedStatus>) {
  const external_urls = [
    ...new Set(
      status.raw_text.facets
        .filter((facet) => facet.type === "url")
        .map((facet) => facet.replacement ?? facet.original)
        .filter((url): url is string => url !== undefined),
    ),
  ];
  return {
    ...status,
    article: status.article ?? null,
    quote: status.quote
      ? {
          ...status.quote,
          ...(status.quote.type === "status"
            ? {
                article: status.quote.article ?? null,
              }
            : {}),
        }
      : null,
    external_urls,
  };
}

export function parseXSavedEnrichment(raw: unknown, tweetId: string) {
  const response = ResponseSchema.parse(raw);
  if (response.status.id !== Id.parse(tweetId))
    throw new Error("FxTwitter Tweet ID mismatch");
  const status = snapshot(response.status);
  const thread = (response.thread ?? [])
    .filter(
      (entry) =>
        entry.type === "tombstone" || entry.author.id === status.author.id,
    )
    .map((entry) => (entry.type === "status" ? snapshot(entry) : entry));
  // The API normally includes the focal status. Preserve its order and gaps.
  const focal = thread.findIndex((entry) => entry.id === tweetId);
  if (focal >= 0) thread[focal] = status;
  else {
    const next = thread.findIndex(
      (entry) => entry.id && BigInt(entry.id) > BigInt(tweetId),
    );
    thread.splice(next < 0 ? thread.length : next, 0, status);
  }
  return { status, thread };
}

export type XSavedEnrichment = ReturnType<typeof parseXSavedEnrichment>;

export async function lookupXSavedEnrichment(
  tweetId: string,
): Promise<XSavedEnrichment> {
  return parseXSavedEnrichment(
    await fetchFxTwitter("thread", tweetId),
    tweetId,
  );
}
