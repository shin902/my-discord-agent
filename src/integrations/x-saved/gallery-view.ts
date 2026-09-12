import {
  formatLabels,
  type GalleryCard,
  type GalleryFilters,
  type GalleryMedia,
  type getGalleryItem,
  ITEM_STATUSES,
  LABEL_KINDS,
  type listGallery,
} from "./gallery-store.js";

export const GALLERY_CSS = `
:root { color-scheme: light; --paper: #edf2f6; --ink: #182e43; --muted: #53687a; --line: #bdcdd9; --blue: #164fbe; --stage: #dce5ed; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
* { box-sizing: border-box; }
body { margin: 0; }
a { color: var(--blue); text-underline-offset: .2em; }
button, input, select, textarea { font: inherit; font-size: 1rem; }
button, .button { display: inline-block; background: var(--blue); color: white; border: 1px solid var(--blue); border-radius: .35rem; padding: .6rem 1rem; text-decoration: none; cursor: pointer; }
input, select, textarea { width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: .3rem; background: white; color: var(--ink); padding: .55rem; }
textarea { resize: vertical; }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 3px; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding: 1rem 3vw; }
header a { color: var(--ink); text-decoration: none; }
h1 { font: italic 1.9rem/1.2 Georgia, serif; margin: 0; }
h2 { font-size: 1.15rem; margin: 0 0 1rem; }
p { margin: .5rem 0; }
small, .muted { color: var(--muted); }
main { max-width: 1800px; margin: auto; padding: 1.5rem 3vw 3rem; }
label { display: grid; align-content: start; gap: .3rem; font-size: .9rem; }
.search { display: flex; align-items: end; gap: .75rem; }
.search label { flex: 1; }
details { margin-top: 1rem; border-block: 1px solid var(--line); padding: .8rem 0; }
summary { cursor: pointer; font-weight: 600; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .8rem; padding-top: 1rem; }
.help { font-size: .85rem; color: var(--muted); margin-top: .8rem; }
.toolbar, nav { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin: 1.25rem 0; }
.count { font-family: ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 1.1rem; }
.card { min-width: 0; background: white; border-radius: .4rem; overflow: hidden; border: 1px solid var(--line); }
.card-link { display: block; color: inherit; text-decoration: none; }
.stage { display: grid; place-items: center; aspect-ratio: 1; background: var(--stage); position: relative; overflow: hidden; }
.stage img, .stage video { width: 100%; height: 100%; object-fit: contain; }
.kind { position: absolute; bottom: .5rem; left: .5rem; background: var(--ink); color: white; padding: .1rem .45rem; border-radius: .2rem; font: .75rem/1.6 ui-monospace, monospace; }
.caption { padding: .8rem .9rem .4rem; }
.meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .25rem .6rem; font-size: .8rem; color: var(--muted); }
.excerpt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 3em; font-size: .9rem; overflow-wrap: anywhere; }
.tags { display: flex; gap: .25rem; flex-wrap: wrap; margin-top: .5rem; }
.tag { font-size: .75rem; background: var(--paper); border-radius: .2rem; padding: .1rem .4rem; overflow-wrap: anywhere; }
.original { display: inline-block; margin: .35rem .9rem .8rem; font-size: .8rem; }
.empty, .notice { padding: 1rem; border: 1px solid var(--line); border-radius: .4rem; background: white; }
.detail { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr); gap: 2rem; }
.detail-media { display: grid; gap: 1rem; align-content: start; }
.detail-media img, .detail-media video { display: block; max-width: 100%; max-height: 80vh; margin: auto; }
figure { margin: 0; background: var(--stage); padding: .6rem; border-radius: .4rem; }
figcaption { font-size: .8rem; margin-top: .5rem; color: var(--muted); }
.body-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.editor { display: grid; gap: .8rem; border-top: 1px solid var(--line); margin-top: 1.5rem; padding-top: 1.5rem; }
.notice { margin: 1rem 0; }
#saved:not(:target) { display: none; }
@media (max-width: 650px) {
  header small { display: none; }
  main { padding-inline: .75rem; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .6rem; }
  .caption { padding: .6rem; }
  .original { margin-left: .6rem; }
  .detail { grid-template-columns: 1fr; gap: 1rem; }
  .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .search { flex-wrap: wrap; }
  .search label { flex-basis: 100%; }
}
`;

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}

export function galleryPage(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · X saved</title>
<link rel="stylesheet" href="/gallery.css"></head><body>
<header><a href="/"><h1>X saved / Gallery</h1></a><small>保存した画像を、もう一度。</small></header>
<main>${body}</main></body></html>`;
}

function select(
  name: string,
  label: string,
  value: string,
  entries: readonly (readonly [string, string])[],
): string {
  return `<label><span id="${name}-label">${label}</span><select name="${name}" aria-labelledby="${name}-label">${entries
    .map(
      ([key, title]) =>
        `<option value="${escapeHtml(key)}"${key === value ? " selected" : ""}>${escapeHtml(title)}</option>`,
    )
    .join("")}</select></label>`;
}
function input(
  name: string,
  label: string,
  value: string,
  type = "text",
  maxLength = 500,
): string {
  return `<label>${label}<input type="${type}" name="${name}" value="${escapeHtml(value)}" maxlength="${maxLength}"></label>`;
}
const statusOptions = ITEM_STATUSES.map((s) => [s, s] as const);
const labelTitles = {
  series: "Series / 作品",
  character: "Characters / キャラクター",
  tag: "Tags / タグ",
};
const original = (id: string) =>
  `<a href="https://x.com/i/status/${encodeURIComponent(id)}" target="_blank" rel="noreferrer noopener">元Tweet ↗</a>`;
const mediaUrl = (id: string, media: GalleryMedia) =>
  `/media/${encodeURIComponent(id)}/${encodeURIComponent(media.kind)}/${encodeURIComponent(media.position)}`;

function mediaElement(
  id: string,
  media: GalleryMedia,
  detail: boolean,
): string {
  if (media.media_status !== "done")
    return `<p class="muted">${media.media_status === "failed" ? "保存失敗" : "保存待ち"} · ${escapeHtml(media.kind)}</p>`;
  const url = mediaUrl(id, media);
  if (media.kind === "image")
    return `<img src="${url}" alt="${escapeHtml(media.alt_text ?? "保存画像")}" loading="lazy" decoding="async">`;
  // No thumbnail store or eager grid downloads; native MP4 preview in detail.
  return `<video src="${url}#t=0.1" preload="${detail ? "metadata" : "none"}" playsinline${detail ? " controls" : ""} aria-label="保存動画"></video>`;
}
function card(item: GalleryCard, query: string): string {
  return `<article class="card"><a class="card-link" href="/items/${encodeURIComponent(item.tweet_id)}?${escapeHtml(query)}" aria-label="${escapeHtml(item.author_handle || item.tweet_id)} の詳細">
<div class="stage">${mediaElement(item.tweet_id, item, false)}<span class="kind">${escapeHtml(item.kind.toUpperCase())} · ${escapeHtml(item.position + 1)}</span></div>
<div class="caption"><div class="meta"><strong>@${escapeHtml(item.author_handle || "unknown")}</strong><span>${escapeHtml(item.status)}</span></div>
<p class="excerpt">${escapeHtml(item.text.slice(0, 300) || "（本文なし）")}</p>
<div class="tags">${LABEL_KINDS.flatMap((kind) =>
    item.labels.filter((label) => label.kind === kind).slice(0, 2),
  )
    .map(
      (l) =>
        `<span class="tag" title="${escapeHtml(l.kind)}">${escapeHtml(l.value)}</span>`,
    )
    .join("")}</div></div></a>
<div class="original">${original(item.tweet_id)}</div></article>`;
}

export function galleryListPage(
  filters: GalleryFilters,
  result: ReturnType<typeof listGallery>,
): string {
  const query = new URLSearchParams(
    Object.entries(filters).map(([k, v]): [string, string] => [k, String(v)]),
  );
  query.set("page", String(result.page));
  const pageLink = (page: number, text: string) => {
    const next = new URLSearchParams(query);
    next.set("page", String(page));
    return `<a href="/?${escapeHtml(next)}">${text}</a>`;
  };
  const pagination = `<nav aria-label="ページ移動"><span>${result.page > 1 ? pageLink(result.page - 1, "← 前の60件") : ""}</span>
<span class="count">${result.page} / ${result.pages}</span><span>${result.page < result.pages ? pageLink(result.page + 1, "次の60件 →") : ""}</span></nav>`;
  const active = Object.entries(filters).filter(
    ([k, v]) => !["q", "sort", "page"].includes(k) && v,
  ).length;
  return galleryPage(
    "Gallery",
    `<form method="get" action="/" role="search">
<div class="search">${input("q", "Tweet本文を検索", filters.q)}<button type="submit">絞り込む</button><a href="/">リセット</a></div>
<details><summary>フィルター${active ? ` · ${active} 条件` : ""}</summary><div class="filters">
${select("media", "Media", filters.media, [
  ["", "すべて"],
  ["image", "画像"],
  ["video", "動画"],
])}
${select("source", "Source", filters.source, [
  ["", "すべて"],
  ["like", "Like"],
  ["bookmark", "Bookmark"],
])}
${LABEL_KINDS.map((k) => `<label>${labelTitles[k]}<textarea name="${k}" rows="2" maxlength="10000">${escapeHtml(filters[k])}</textarea></label>`).join("")}
${select("status", "Status", filters.status, [["", "すべて"], ...statusOptions])}
${select("review", "分類の確認", filters.review, [
  ["", "すべて"],
  ["unknown", "Unknown / 未分類"],
  ["needs-review", "Needs review / inbox"],
])}
${input("author", "Author / @handle", filters.author, "text", 100)}
${input("from", "投稿日（UTC）から", filters.from, "date")}${input("to", "投稿日（UTC）まで", filters.to, "date")}
${select("sort", "並び順", filters.sort, [
  ["saved", "保存が新しい順"],
  ["newest", "投稿が新しい順"],
  ["oldest", "投稿が古い順"],
  ["author", "Author順"],
])}
</div><p class="help">作品・キャラクター・タグは1行1値で複数指定（完全一致・すべてを含む）。カンマは値の一部。改行入りの値はJSON配列で指定。Unknown は作品またはキャラクターが未入力、または unknown ラベル付き。投稿日不明は初回保存日を使います。</p>
<button type="submit">条件を適用</button></details></form>
<div class="toolbar"><strong class="count">${result.total.toLocaleString("en-US")} media</strong><span class="muted">1ページ60件 · 分類はTweet単位</span></div>
${result.total ? `<div class="grid">${result.items.map((item) => card(item, String(query))).join("")}</div>` : `<section class="empty"><h2>表示できるメディアがありません</h2><p>条件を減らすか、media archive の収集・ダウンロードを確認してください。</p><a href="/">フィルターをリセット</a></section>`}
${pagination}`,
  );
}

export function galleryDetailPage(
  item: NonNullable<ReturnType<typeof getGalleryItem>>,
  query: string,
  message = "",
  submitted?: Record<string, string>,
): string {
  const fields = Object.fromEntries(
    LABEL_KINDS.map((kind) => [
      kind,
      formatLabels(
        item.labels.filter((l) => l.kind === kind).map((l) => l.value),
      ),
    ]),
  );
  return galleryPage(
    `@${item.author_handle || "unknown"}`,
    `<nav aria-label="詳細ナビゲーション"><a href="/?${escapeHtml(query)}">← 一覧に戻る</a>${original(item.tweet_id)}</nav>
${message ? `<p class="notice" role="status">${escapeHtml(message)}</p>` : '<p id="saved" class="notice" role="status">変更を保存しました。</p>'}
<div class="detail"><section class="detail-media" aria-label="保存メディア">
${item.media.map((m) => `<figure>${mediaElement(item.tweet_id, m, true)}<figcaption>${escapeHtml(m.kind)} · ${escapeHtml(m.position + 1)}${m.media_status === "done" ? ` · <a href="${mediaUrl(item.tweet_id, m)}" target="_blank" rel="noopener">ファイルを開く</a>` : ""}</figcaption></figure>`).join("") || "<p>メディアなし</p>"}</section>
<section aria-label="Tweetと分類"><h2>@${escapeHtml(item.author_handle || "unknown")}</h2>
<p class="meta">${escapeHtml(item.tweet_created_at ?? item.first_seen_at)} · ${item.seen_liked ? "Like " : ""}${item.seen_bookmarked ? "Bookmark" : ""}</p>
<p class="body-text">${escapeHtml(item.text || "（本文なし）")}</p>
${item.note ? `<h2>Note</h2><p class="body-text">${escapeHtml(item.note)}</p>` : ""}
<form class="editor" method="post" action="/items/${encodeURIComponent(item.tweet_id)}?${escapeHtml(query)}"><h2>分類を編集</h2>
${LABEL_KINDS.map((kind) => `<label>${labelTitles[kind]}<textarea name="${kind}" rows="3" maxlength="10000">${escapeHtml(submitted?.[kind] ?? fields[kind])}</textarea></label>`).join("")}
${select("status", "Status", submitted?.status ?? item.status, statusOptions)}
<p class="help">1行1値。カンマは値の一部。改行入り・前後の空白・先頭の [ を含む値はJSON配列で保持します。各50個・1値100文字まで。空欄で解除。同じTweetの全メディアに反映されます。</p>
<button type="submit">変更を保存</button></form></section></div>`,
  );
}
