import type Database from "better-sqlite3";
import { z } from "zod";

export const GALLERY_PAGE_SIZE = 60;
export const ITEM_STATUSES = [
  "inbox",
  "reviewed",
  "keep",
  "try",
  "done",
  "ignore",
] as const;
export const LABEL_KINDS = ["series", "character", "tag"] as const;
const Labels = z
  .string()
  .max(10_000)
  .transform((text, ctx) => {
    if (text.trimStart().startsWith("[")) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid label JSON array" });
        return z.NEVER;
      }
    }
    return text
      .split(/[\r\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  })
  .pipe(z.array(z.string().min(1).max(100)))
  .transform((values) => [...new Set(values)])
  .refine((values) => values.length <= 50, "At most 50 labels");

/** Plain lines for ordinary labels; JSON avoids HTML/form whitespace normalization. */
export function formatLabels(values: string[]): string {
  const text = values.join("\n");
  return text.startsWith("[") ||
    values.some((v) => /[\r\n]/.test(v) || v.includes("\0") || v !== v.trim())
    ? JSON.stringify(values)
    : text;
}

export const ClassificationSchema = z.strictObject({
  series: Labels,
  character: Labels,
  tag: Labels,
  status: z.enum(ITEM_STATUSES),
});
const DateFilter = z.union([z.literal(""), z.iso.date()]).default("");
const LabelFilter = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, "\n"))
  .pipe(z.string().max(5_000))
  .default("");
export const GalleryFilterSchema = z
  .strictObject({
    q: z.string().trim().max(500).default(""),
    media: z.enum(["", "image", "video"]).default(""),
    source: z.enum(["", "like", "bookmark"]).default(""),
    series: LabelFilter,
    character: LabelFilter,
    tag: LabelFilter,
    status: z.enum(["", ...ITEM_STATUSES]).default(""),
    review: z.enum(["", "unknown", "needs-review"]).default(""),
    author: z.string().trim().max(100).default(""),
    from: DateFilter,
    to: DateFilter,
    sort: z.enum(["saved", "newest", "oldest", "author"]).default("saved"),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, "Date range is reversed")
  .refine(
    (f) => LABEL_KINDS.every((kind) => Labels.safeParse(f[kind]).success),
    "Invalid labels",
  );
export type GalleryFilters = z.infer<typeof GalleryFilterSchema>;
export interface GalleryLabel {
  kind: (typeof LABEL_KINDS)[number];
  value: string;
}
export interface GalleryItem {
  tweet_id: string;
  text: string;
  author_handle: string;
  tweet_created_at: string | null;
  first_seen_at: string;
  seen_liked: number;
  seen_bookmarked: number;
  status: (typeof ITEM_STATUSES)[number];
  note: string | null;
  labels: GalleryLabel[];
}
export interface GalleryMedia {
  kind: "image" | "video";
  position: number;
  media_status: "pending" | "done" | "failed";
  alt_text: string | null;
}
export type GalleryCard = GalleryItem & GalleryMedia;

const ITEM_SELECT = `i.tweet_id, i.text, i.author_handle, i.tweet_created_at,
  i.first_seen_at, i.seen_liked, i.seen_bookmarked, s.status, s.note,
  (SELECT json_group_array(json_object('kind', kind, 'value', value))
    FROM x_item_labels WHERE tweet_id = i.tweet_id) AS labels_json`;
const MEDIA_SELECT = "m.kind, m.position, m.status AS media_status, m.alt_text";
const ITEM_JOIN = "JOIN x_item_state s ON s.tweet_id = i.tweet_id";
const POST_DATE = "julianday(COALESCE(i.tweet_created_at, i.first_seen_at))";
const SORTS = {
  saved: "julianday(i.first_seen_at) DESC",
  newest: `${POST_DATE} DESC`,
  oldest: `${POST_DATE} ASC`,
  author: "i.author_handle COLLATE NOCASE ASC",
};

function withLabels<T extends { labels_json: string }>(row: T) {
  const { labels_json, ...rest } = row;
  return { ...rest, labels: JSON.parse(labels_json) as GalleryLabel[] };
}

export function listGallery(db: Database.Database, filters: GalleryFilters) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]) => {
    where.push(sql);
    args.push(...values);
  };
  if (filters.q) add("instr(lower(i.text), lower(?)) > 0", filters.q);
  if (filters.media) add("m.kind = ?", filters.media);
  if (filters.source)
    add(
      filters.source === "like" ? "i.seen_liked = 1" : "i.seen_bookmarked = 1",
    );
  if (filters.status) add("s.status = ?", filters.status);
  if (filters.author)
    add("i.author_handle = ? COLLATE NOCASE", filters.author.replace(/^@/, ""));
  if (filters.from) add(`${POST_DATE} >= julianday(?)`, filters.from);
  if (filters.to) add(`${POST_DATE} < julianday(?, '+1 day')`, filters.to);
  for (const kind of LABEL_KINDS) {
    for (const value of Labels.parse(filters[kind])) {
      add(
        `EXISTS (SELECT 1 FROM x_item_labels l WHERE l.tweet_id = i.tweet_id AND l.kind = ? AND l.value = ?)`,
        kind,
        value,
      );
    }
  }
  if (filters.review === "needs-review") add("s.status = 'inbox'");
  if (filters.review === "unknown")
    add(`(
    NOT EXISTS (SELECT 1 FROM x_item_labels l WHERE l.tweet_id = i.tweet_id AND l.kind = 'series') OR
    NOT EXISTS (SELECT 1 FROM x_item_labels l WHERE l.tweet_id = i.tweet_id AND l.kind = 'character') OR
    EXISTS (SELECT 1 FROM x_item_labels l WHERE l.tweet_id = i.tweet_id AND lower(l.value) = 'unknown')
  )`);
  const from = `FROM x_media m JOIN x_items i ON i.tweet_id = m.tweet_id ${ITEM_JOIN}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  // ponytail: bounded OFFSET pages are enough for thousands; use keyset pagination if this archive outgrows that.
  return db.transaction(() => {
    const { total } = db
      .prepare(`SELECT count(*) AS total ${from}`)
      .get(...args) as { total: number };
    const pages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
    const page = Math.min(filters.page, pages);
    const rows = db
      .prepare(`SELECT ${ITEM_SELECT}, ${MEDIA_SELECT} ${from}
      ORDER BY ${SORTS[filters.sort]}, i.tweet_id DESC, m.position, m.kind
      LIMIT ? OFFSET ?`)
      .all(...args, GALLERY_PAGE_SIZE, (page - 1) * GALLERY_PAGE_SIZE) as (Omit<
      GalleryCard,
      "labels"
    > & { labels_json: string })[];
    return { total, pages, page, items: rows.map(withLabels) };
  })();
}

export function getGalleryItem(db: Database.Database, tweetId: string) {
  const row = db
    .prepare(
      `SELECT ${ITEM_SELECT} FROM x_items i ${ITEM_JOIN} WHERE i.tweet_id = ?`,
    )
    .get(tweetId) as
    | (Omit<GalleryItem, "labels"> & { labels_json: string })
    | undefined;
  if (!row) return undefined;
  const media = db
    .prepare(
      `SELECT ${MEDIA_SELECT} FROM x_media m WHERE m.tweet_id = ? ORDER BY m.position, m.kind`,
    )
    .all(tweetId) as GalleryMedia[];
  return { ...withLabels(row), media };
}

export function updateGalleryItem(
  db: Database.Database,
  tweetId: string,
  input: unknown,
): boolean {
  const fields = ClassificationSchema.parse(input);
  return db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE x_item_state SET status = ?, updated_at = ? WHERE tweet_id = ?",
      )
      .run(fields.status, new Date().toISOString(), tweetId);
    if (!result.changes) return false;
    db.prepare("DELETE FROM x_item_labels WHERE tweet_id = ?").run(tweetId);
    const insert = db.prepare(
      "INSERT INTO x_item_labels (tweet_id, kind, value) VALUES (?, ?, ?)",
    );
    for (const kind of LABEL_KINDS)
      for (const value of fields[kind]) insert.run(tweetId, kind, value);
    return true;
  })();
}
