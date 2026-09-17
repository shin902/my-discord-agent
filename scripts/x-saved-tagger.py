#!/usr/bin/env python3
"""Host-only PixAI batch classifier. Inference is offline; --download is explicit."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime, timezone

MODEL = "pixai-labs/pixai-tagger-v1.0"
REVISION = "f33cfdb53c0c90b049bab9ce066eea1118970ef8"
FILES = ["config.json", "preprocessor_config.json", "tagger_pipeline.py", "model.safetensors"]
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
    """Validate human aliases; reject ambiguous mappings rather than pick a winner."""
    if not isinstance(raw, dict) or raw.keys() - {"series", "characters", "tags"}:
        raise ValueError("Expected series/characters/tags alias dictionaries")
    maps, patterns, parents = {}, [], {}
    for group, kind in (("series", "series"), ("characters", "character"), ("tags", "tag")):
        entries = raw.get(group, {})
        if not isinstance(entries, dict):
            raise ValueError(f"{group} must be an object")
        lookup = maps[kind] = {}
        for canonical, entry in entries.items():
            canonical = label(canonical)
            allowed = {"aliases", "series"} if kind == "character" else {"aliases"}
            if not isinstance(entry, dict) or entry.keys() - allowed:
                raise ValueError("Invalid alias entry")
            aliases = entry.get("aliases", [])
            if not isinstance(aliases, list):
                raise ValueError("aliases must be a list")
            for alias in [canonical, *aliases]:
                key = label(alias)
                if key in lookup and lookup[key] != canonical:
                    raise ValueError(f"Ambiguous alias: {key}")
                lookup[key] = canonical
                literal = normalized(alias).replace("_", " ")
                # ASCII words must not match inside other words; Japanese aliases are substrings.
                left = r"(?<![a-z0-9])" if literal[0].isascii() and literal[0].isalnum() else ""
                right = r"(?![a-z0-9])" if literal[-1].isascii() and literal[-1].isalnum() else ""
                patterns.append((kind, canonical, re.compile(left + re.escape(literal) + right)))
            if "series" in entry:
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
    if not isinstance(results, dict):
        raise ValueError("Invalid PixAI output")
    for category, kind in CATEGORIES.items():
        scores = results.get(category)
        if not isinstance(scores, dict):
            raise ValueError(f"Missing PixAI category: {category}")
        for value, score in scores.items():
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError("Invalid PixAI confidence")
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


def archive_path(root, tweet_id, position, local_path):
    if not re.fullmatch(r"[1-9][0-9]{0,19}", tweet_id) or not 0 <= position <= 15:
        raise ValueError("Invalid media identity")
    if not isinstance(local_path, str) or not re.fullmatch(
        rf"media/{tweet_id}/{position}\.(jpg|png|webp|gif)", local_path
    ):
        raise ValueError("Invalid archived image path")
    candidate = root / local_path
    for part in (root / "media", root / "media" / tweet_id, candidate):
        if part.is_symlink():
            raise ValueError("Archived image symlinks are not allowed")
    if not candidate.is_file():
        raise FileNotFoundError(local_path)
    return candidate


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
    if thresholds is not None and not isinstance(thresholds, dict):
        raise ValueError("thresholds must be an object")
    thresholds = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    if thresholds.keys() != CATEGORIES.keys() or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1
        for v in thresholds.values()
    ):
        raise ValueError("Invalid category thresholds")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("limit must be 1–100")
    aliases = read_aliases(aliases_raw)
    policy = [REVISION, 1, aliases_raw, thresholds]
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
        # ponytail: scan metadata for thousands of Tweets; index persisted input hashes if this outgrows that.
        tweets = db.execute("""SELECT i.tweet_id, i.text, m.value AS checkpoint
            FROM x_items i LEFT JOIN x_meta m ON m.key = ? || i.tweet_id
            WHERE EXISTS (SELECT 1 FROM x_media WHERE tweet_id=i.tweet_id AND kind='image')
            ORDER BY json_extract(m.value, '$.attempted_at'), i.tweet_id""", (PREFIX,)).fetchall()
        for tweet in tweets:
            tweet_id = tweet["tweet_id"]
            media = [dict(row) for row in db.execute("""SELECT position, status, local_path
                FROM x_media WHERE tweet_id=? AND kind='image' ORDER BY position""", (tweet_id,))]
            fingerprint = hashlib.sha256(json.dumps(
                [policy, tweet["text"], media], sort_keys=True, ensure_ascii=False
            ).encode()).hexdigest()
            checkpoint = json.loads(tweet["checkpoint"] or "{}")
            if checkpoint.get("fingerprint") == fingerprint:
                continue
            if processed + failed >= limit:
                break
            baseline = text_labels(tweet["text"], aliases)
            # Text matches survive model/cache/decode failures. Never replace existing human labels.
            with db:
                db.executemany("INSERT OR IGNORE INTO x_item_labels VALUES (?, ?, ?)",
                               [(tweet_id, kind, value) for kind, value in sorted(baseline)])
            candidates = {}
            error = None
            try:
                for image in media:
                    if image["status"] != "done":
                        continue  # A later download changes the fingerprint and reopens this Tweet.
                    image_path = archive_path(db_path.parent, tweet_id, image["position"], image["local_path"])
                    if infer is None:
                        infer = load_tagger(cache, device)
                    for key, score in image_labels(infer(image_path), aliases, thresholds).items():
                        candidates[key] = max(candidates.get(key, 0), score)
            except Exception as cause:
                error = str(cause)[:1000]
            # Database errors deliberately escape the per-image failure boundary.
            with db:
                if error is None:
                    existing = set(tuple(row) for row in db.execute(
                        "SELECT kind, value FROM x_item_labels WHERE tweet_id=?", (tweet_id,)))
                    counts = {kind: sum(k == kind for k, _ in existing) for kind in CATEGORIES.values()}
                    for (kind, value), _ in sorted(candidates.items(), key=lambda item: (-item[1], item[0])):
                        if (kind, value) not in existing and counts[kind] < 50:
                            db.execute("INSERT OR IGNORE INTO x_item_labels VALUES (?, ?, ?)", (tweet_id, kind, value))
                            counts[kind] += 1
                    processed += 1
                else:
                    failed += 1
                    print(f"[x-saved-tagger] {tweet_id}: {error}", file=sys.stderr)
                checkpoint = {"fingerprint": fingerprint if error is None else None,
                              "attempted_at": datetime.now(timezone.utc).isoformat(), "last_error": error}
                db.execute("INSERT INTO x_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (PREFIX + tweet_id, json.dumps(checkpoint)))
        return {"processed": processed, "failed": failed}
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db")
    parser.add_argument("--aliases")
    parser.add_argument("--cache", required=True, help="Host-only Hugging Face cache, outside the agent mount")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps"])
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--thresholds", default="{}", help="JSON category overrides")
    parser.add_argument("--download", action="store_true", help="Download pinned model/code only; no classification")
    args = parser.parse_args()
    if args.download:
        os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
        from huggingface_hub import snapshot_download
        print(snapshot_download(MODEL, revision=REVISION, cache_dir=args.cache, allow_patterns=FILES))
        return
    if not args.db or not args.aliases:
        parser.error("--db and --aliases are required for classification")
    aliases = json.loads(Path(args.aliases).read_text(encoding="utf-8"))
    print(json.dumps(classify(args.db, aliases, args.cache, args.device, args.limit, json.loads(args.thresholds))))


if __name__ == "__main__":
    main()
