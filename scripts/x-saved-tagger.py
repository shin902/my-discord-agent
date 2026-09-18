#!/usr/bin/env python3
"""Host-only PixAI batch classifier using a pinned, offline model."""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata

MODEL = "pixai-labs/pixai-tagger-v1.0"
REVISION = "f33cfdb53c0c90b049bab9ce066eea1118970ef8"
PREFIX = "pixai-v1:"
CATEGORIES = {"copyright": "series", "character": "character", "general": "tag"}
DEFAULT_THRESHOLDS = {"copyright": 0.46, "character": 0.37, "general": 0.34}


def normalized(value):
    return unicodedata.normalize("NFKC", value).casefold().strip()


def label(value):
    if not isinstance(value, str) or any(c in value for c in "\r\n\0"):
        raise ValueError("Labels must be single-line strings")
    value = re.sub(r"\s+", "_", normalized(value))
    if not 1 <= len(value) <= 100:
        raise ValueError("Labels must contain 1–100 characters")
    return value


def read_aliases(raw):
    """Compile local aliases, rejecting ambiguous names and unknown parent series."""
    maps, patterns, parents = {}, [], {}
    for group, kind in (("series", "series"), ("characters", "character"), ("tags", "tag")):
        entries = raw.get(group, {})
        lookup = maps[kind] = {}
        canonical_keys = set()
        for canonical, entry in entries.items():
            canonical = label(canonical)
            if canonical in canonical_keys:
                raise ValueError(f"Ambiguous canonical label: {canonical}")
            canonical_keys.add(canonical)
            for alias in [canonical, *entry.get("aliases", [])]:
                key = label(alias)
                if key in lookup and lookup[key] != canonical:
                    raise ValueError(f"Ambiguous alias: {key}")
                lookup[key] = canonical
                literal = normalized(alias).replace("_", " ")
                # ASCII words must not match inside other words; Japanese aliases are substrings.
                left = r"(?<![a-z0-9])" if literal[0].isascii() and literal[0].isalnum() else ""
                right = r"(?![a-z0-9])" if literal[-1].isascii() and literal[-1].isalnum() else ""
                patterns.append((kind, canonical, re.compile(left + re.escape(literal) + right)))
            if kind == "character" and "series" in entry:
                parents[canonical] = label(entry["series"])
    series = {label(key) for key in raw.get("series", {})}
    if any(parent not in series for parent in parents.values()):
        raise ValueError("Character series must reference a canonical series entry")
    return maps, patterns, parents


def text_labels(text, aliases):
    _, patterns, parents = aliases
    text = normalized(text).replace("_", " ")
    result = {(kind, canonical) for kind, canonical, regex in patterns if regex.search(text)}
    result.update(("series", parents[value]) for kind, value in list(result)
                  if kind == "character" and value in parents)
    return result


def image_labels(results, aliases, thresholds):
    maps, _, parents = aliases
    output = {}
    for category, kind in CATEGORIES.items():
        for value, score in results[category].items():
            if score < thresholds[category]:
                continue
            value = label(value)
            value = maps[kind].get(value, value)
            key = (kind, value)
            output[key] = max(output.get(key, 0), score)
            if kind == "character" and value in parents:
                key = ("series", parents[value])
                output[key] = max(output.get(key, 0), score)
    return output


def load_tagger(cache, device):
    # No HF request, telemetry, or automatic download during scheduled inference.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("MKL_NUM_THREADS", "4")
    from huggingface_hub import snapshot_download
    from transformers import pipeline
    from PIL import Image
    import torch

    snapshot = snapshot_download(MODEL, revision=REVISION, cache_dir=cache, local_files_only=True)
    tagger = pipeline(model=snapshot, image_processor=snapshot, trust_remote_code=True,
                      device=device, dtype=torch.float32, local_files_only=True, use_fast=False)

    def infer(image_path):
        with Image.open(image_path) as image, torch.inference_mode():
            # Keep upstream preprocessing; use all scores so our inclusive thresholds are authoritative.
            return tagger(image, threshold=0.0)["results"]
    return infer


def classify(db_path, aliases_raw, cache, device="cpu", limit=20, thresholds=None):
    thresholds = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    if thresholds.keys() != CATEGORIES.keys() or any(
        not 0 <= v <= 1
        for v in thresholds.values()
    ):
        raise ValueError("Invalid category thresholds")
    if not 1 <= limit <= 100:
        raise ValueError("limit must be 1–100")
    aliases = read_aliases(aliases_raw)
    db_path = Path(db_path).resolve()
    if Path(cache).resolve().is_relative_to(db_path.parent):
        raise ValueError("Model cache must be outside the agent-visible archive directory")
    # mode=rw prevents silently creating an empty database on a mistyped path.
    db = sqlite3.connect(db_path.as_uri() + "?mode=rw", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    infer = None
    processed = failed = 0
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != 5:
            raise ValueError("Expected x-saved schema v5; upgrade host first")
        db.execute("PRAGMA foreign_keys=ON")
        # ponytail: random batches avoid a stuck prefix without a retry ledger; no strict retry order.
        tweets = db.execute("""SELECT i.tweet_id, i.text
            FROM x_items i LEFT JOIN x_meta m ON m.key = ? || i.tweet_id
            WHERE (m.value IS NULL OR m.value != 'done')
              AND EXISTS (SELECT 1 FROM x_media WHERE tweet_id=i.tweet_id AND kind='image')
              AND NOT EXISTS (SELECT 1 FROM x_media
                WHERE tweet_id=i.tweet_id AND kind='image' AND status != 'done')
            ORDER BY random() LIMIT ?""", (PREFIX, limit)).fetchall()
        for tweet in tweets:
            tweet_id = tweet["tweet_id"]
            media = db.execute("""SELECT local_path FROM x_media
                WHERE tweet_id=? AND kind='image' ORDER BY position""", (tweet_id,)).fetchall()
            candidates = {}
            try:
                for image in media:
                    image_path = (db_path.parent / image["local_path"]).resolve()
                    # Archive data is sandbox-writable; do not follow paths outside that mount.
                    image_path.relative_to(db_path.parent)
                    if infer is None:
                        infer = load_tagger(cache, device)
                    for key, score in image_labels(infer(image_path), aliases, thresholds).items():
                        candidates[key] = max(candidates.get(key, 0), score)
            except Exception as error:
                failed += 1
                print(f"[x-saved-tagger] {tweet_id}: {error}", file=sys.stderr)
                continue
            # Database errors escape; all labels and the done marker commit together.
            with db:
                db.executemany("INSERT OR IGNORE INTO x_item_labels VALUES (?, ?, ?)",
                               [(tweet_id, kind, value) for kind, value in sorted(text_labels(tweet["text"], aliases))])
                existing = set(tuple(row) for row in db.execute(
                    "SELECT kind, value FROM x_item_labels WHERE tweet_id=?", (tweet_id,)))
                counts = {kind: sum(k == kind for k, _ in existing) for kind in CATEGORIES.values()}
                for (kind, value), _ in sorted(candidates.items(), key=lambda item: (-item[1], item[0])):
                    if (kind, value) not in existing and counts[kind] < 50:
                        db.execute("INSERT OR IGNORE INTO x_item_labels VALUES (?, ?, ?)", (tweet_id, kind, value))
                        counts[kind] += 1
                db.execute("INSERT INTO x_meta (key,value) VALUES (?, 'done') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (PREFIX + tweet_id,))
            processed += 1
        return {"processed": processed, "failed": failed}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--aliases", required=True)
    parser.add_argument("--cache", required=True, help="Host-only Hugging Face cache, outside the agent mount")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--thresholds", default="{}", help="JSON category overrides")
    args = parser.parse_args()
    aliases = json.loads(Path(args.aliases).read_text(encoding="utf-8"))
    print(json.dumps(classify(args.db, aliases, args.cache, args.device, args.limit, json.loads(args.thresholds))))


if __name__ == "__main__":
    main()
