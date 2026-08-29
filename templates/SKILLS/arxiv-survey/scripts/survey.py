#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

API_URL = "https://export.arxiv.org/api/query"
ATOM = "{http://www.w3.org/2005/Atom}"
USER_AGENT = "my-discord-agent/arxiv"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024


def date_arg(value: str) -> str:
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must be YYYY-MM-DD") from exc
    if parsed.isoformat() != value:
        raise argparse.ArgumentTypeError("date must be YYYY-MM-DD")
    return value


def normalize_timestamp(value: str | None) -> str:
    if not value:
        return ""
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return (
        parsed.astimezone(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def clean_query(value: str) -> str:
    if len(value) > 500:
        raise ValueError("query must be at most 500 characters")
    value = re.sub(r"\s+", " ", value).strip().replace('"', " ").replace("\\", " ")
    value = re.sub(r"\s+", " ", value).strip()
    if not value:
        raise ValueError("query must not be empty")
    return f'all:"{value}"'


def build_search_query(
    queries: list[str], from_date: str | None, to_date: str | None
) -> str:
    terms = [clean_query(query) for query in queries]
    expression = terms[0] if len(terms) == 1 else f"({' OR '.join(terms)})"
    if not from_date and not to_date:
        return expression
    start = (from_date.replace("-", "") if from_date else "19910101") + "0000"
    end = (to_date.replace("-", "") if to_date else "99991231") + "2359"
    if start > end:
        raise ValueError("--from must be on or before --to")
    return f"{expression} AND submittedDate:[{start} TO {end}]"


def parse_papers(xml: bytes) -> list[dict[str, object]]:
    root = ET.fromstring(xml)
    deduplicated: dict[str, dict[str, object]] = {}
    for entry in root.findall(f"{ATOM}entry"):
        raw_id = (entry.findtext(f"{ATOM}id") or "").rstrip("/")
        abs_marker = "/abs/"
        abs_index = raw_id.find(abs_marker)
        id_with_version = (
            raw_id[abs_index + len(abs_marker) :]
            if abs_index >= 0
            else raw_id
        )
        match = re.match(r"^(.*?)(?:v(\d+))?$", id_with_version)
        arxiv_id = match.group(1) if match else id_with_version
        version = int(match.group(2)) if match and match.group(2) else None
        title = " ".join((entry.findtext(f"{ATOM}title") or "").split())
        abstract = " ".join((entry.findtext(f"{ATOM}summary") or "").split())
        authors = list(
            dict.fromkeys(
                " ".join((author.findtext(f"{ATOM}name") or "").split())
                for author in entry.findall(f"{ATOM}author")
                if " ".join((author.findtext(f"{ATOM}name") or "").split())
            )
        )
        categories = [
            category.attrib.get("term", "")
            for category in entry.findall(f"{ATOM}category")
            if category.attrib.get("term")
        ]
        paper = {
            "id": arxiv_id,
            "version": version,
            "title": title or "(タイトルなし)",
            "authors": authors,
            "submitted_at": normalize_timestamp(entry.findtext(f"{ATOM}published")),
            "updated_at": normalize_timestamp(entry.findtext(f"{ATOM}updated")),
            "categories": list(dict.fromkeys(categories)),
            "abstract": abstract,
            "url": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else "",
            "pdf_url": f"https://arxiv.org/pdf/{arxiv_id}" if arxiv_id else "",
        }
        key = arxiv_id or str(paper["url"]) or str(len(deduplicated))
        deduplicated.setdefault(key, paper)
    return list(deduplicated.values())


def main() -> None:
    parser = argparse.ArgumentParser(description="Survey arXiv and print normalized JSON")
    parser.add_argument("queries", nargs="+", help="1-8 natural-language search queries")
    parser.add_argument("--from", dest="from_date", type=date_arg)
    parser.add_argument("--to", dest="to_date", type=date_arg)
    parser.add_argument("--limit", type=int, choices=range(1, 51), default=30)
    parser.add_argument(
        "--sort",
        choices=("relevance", "submitted", "updated"),
        default="submitted",
    )
    args = parser.parse_args()
    if len(args.queries) > 8:
        parser.error("at most 8 queries may be supplied")

    sort_map = {
        "relevance": "relevance",
        "submitted": "submittedDate",
        "updated": "lastUpdatedDate",
    }
    try:
        search_query = build_search_query(args.queries, args.from_date, args.to_date)
    except ValueError as exc:
        parser.error(str(exc))
    params = urllib.parse.urlencode(
        {
            "search_query": search_query,
            "start": 0,
            "max_results": args.limit,
            "sortBy": sort_map[args.sort],
            "sortOrder": "descending",
        }
    )
    request = urllib.request.Request(
        f"{API_URL}?{params}",
        headers={
            "Accept": "application/atom+xml, application/xml, text/xml",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise RuntimeError("arXiv API response exceeded 5 MiB")
    print(json.dumps(parse_papers(body), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
