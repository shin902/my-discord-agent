#!/usr/bin/env bash
set -euo pipefail

# url-fetch – CLI port of my-discord-agent's url-fetch tool
# Usage: url-fetch.sh <URL>
# Outputs fetched content to stdout. Pipe to file with > if needed.

VERSION="0.1.0"

# ── Helpers ──────────────────────────────────────────────────────────────────

die() { echo "error: $*" >&2; exit 1; }

# ── Cleanup ───────────────────────────────────────────────────────────────────
_cleanup_paths=()
_register_cleanup() { _cleanup_paths+=("$@"); }
_cleanup() {
  for p in "${_cleanup_paths[@]+"${_cleanup_paths[@]}"}"; do
    rm -rf "$p"
  done
}
trap _cleanup EXIT

usage() {
  cat <<EOF
url-fetch v${VERSION}

Usage: url-fetch.sh <URL>

Fetches content from the given URL and outputs to stdout.
Auto-detects service type (YouTube, GitHub, Reddit, RSS, web).
EOF
}

# Check required external commands exist
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    die "'$1' is not installed"
  fi
}

# ── URL validation ───────────────────────────────────────────────────────────

validate_url() {
  local url="$1"
  # Must start with http:// or https://
  if [[ ! "$url" =~ ^https?:// ]]; then
    die "unsupported protocol (only http/https allowed): $url"
  fi
}

# ── Service detection ────────────────────────────────────────────────────────

detect_service() {
  local url="$1"
  local host
  # Strip www. and scheme
  host=$(echo "$url" | sed -E 's|^https?://(www\.)?([^/]+).*|\2|')
  local path
  path=$(echo "$url" | sed -E 's|^https?://[^/]+(/[^?#]*)?.*|\1|' | tr '[:upper:]' '[:lower:]')

  case "$host" in
    youtube.com|youtu.be) echo "youtube" ;;
    github.com)
      if [[ "$path" =~ ^/[^/]+/[^/?#]+/?$ ]]; then
        echo "github-repo"
      else
        echo "web"
      fi
      ;;
    reddit.com|old.reddit.com) echo "reddit" ;;
    *)
      if [[ "$path" == *.xml || "$path" == *.rss || "$path" == */feed* || "$path" == */rss* ]]; then
        echo "rss"
      else
        echo "web"
      fi
      ;;
  esac
}

# ── Formatters ───────────────────────────────────────────────────────────────

format_duration() {
  local secs="$1"
  local h m s
  h=$((secs / 3600))
  m=$(( (secs % 3600) / 60 ))
  s=$((secs % 60))
  if (( h > 0 )); then
    printf "%d:%02d:%02d" "$h" "$m" "$s"
  else
    printf "%d:%02d" "$m" "$s"
  fi
}

# YouTube: yt-dlp JSON → Markdown
format_youtube() {
  local meta_json="$1"
  local subs_dir="$2"

  # Extract JSON (yt-dlp may prepend WARNING lines)
  local json
  json=$(sed -n '/^{/,$ p' "$meta_json")
  if [[ -z "$json" ]]; then
    echo "(metadata read failed)"
    return
  fi

  local title channel upload_date duration views likes tags description
  title=$(echo "$json" | jq -r '.title // empty')
  channel=$(echo "$json" | jq -r '(.channel // .uploader // empty)')
  upload_date=$(echo "$json" | jq -r '.upload_date // empty')
  duration=$(echo "$json" | jq -r '.duration // empty')
  views=$(echo "$json" | jq -r '.view_count // empty')
  likes=$(echo "$json" | jq -r '.like_count // empty')
  tags=$(echo "$json" | jq -r '(.tags // []) | join(", ")')
  description=$(echo "$json" | jq -r '.description // empty')

  # Title
  echo "# ${title:-"(タイトル不明)"}"
  echo ""

  # Channel
  if [[ -n "$channel" ]]; then
    echo "**チャンネル**: ${channel}"
  fi

  # Upload date (YYYYMMDD → YYYY-MM-DD)
  if [[ ${#upload_date} -eq 8 ]]; then
    echo "**投稿日**: ${upload_date:0:4}-${upload_date:4:2}-${upload_date:6:2}"
  fi

  # Duration
  if [[ -n "$duration" && "$duration" != "null" ]]; then
    echo "**再生時間**: $(format_duration "$duration")"
  fi

  # Views
  if [[ -n "$views" && "$views" != "null" ]]; then
    printf "**視聴回数**: %'d\n" "$views"
  fi

  # Likes
  if [[ -n "$likes" && "$likes" != "null" ]]; then
    printf "**いいね**: %'d\n" "$likes"
  fi

  # Tags
  if [[ -n "$tags" ]]; then
    echo "**タグ**: ${tags}"
  fi

  # Description
  if [[ -n "$description" ]]; then
    echo ""
    echo "## 説明"
    echo ""
    echo "$description"
  fi

  # Chapters
  local chapters_count
  chapters_count=$(echo "$json" | jq '.chapters // [] | length')
  if (( chapters_count > 0 )); then
    echo ""
    echo "## チャプター"
    echo ""
    echo "$json" | jq -r '
      def fmt_dur:
        . as $s |
        ($s / 3600 | floor) as $h |
        (($s % 3600) / 60 | floor) as $m |
        ($s % 60) as $sec |
        if $h > 0 then
          "\($h):\($m | tostring | if length < 2 then "0" + . else . end):\($sec | tostring | if length < 2 then "0" + . else . end)"
        else
          "\($m):\($sec | tostring | if length < 2 then "0" + . else . end)"
        end;
      .chapters[] | "\(.start_time | floor | fmt_dur) \(.title // "")"
    '
  fi

  # Subtitles
  local sub_files
  sub_files=$(find "$subs_dir" -maxdepth 1 -name '*.vtt' 2>/dev/null || true)
  if [[ -n "$sub_files" ]]; then
    while IFS= read -r vtt_file; do
      local lang
      lang=$(basename "$vtt_file" | sed -E 's/.*\.([a-zA-Z-]+)\.vtt$/\1/')
      local text
      # Parse VTT: strip timestamps, cue numbers, timing tags, deduplicate.
      # Some YouTube VTT files collapse cue timings into the text line, so
      # remove cue timing ranges wherever they appear before line-oriented parsing.
      text=$(sed -E \
        -e 's/[0-9]{2}:[0-9]{2}:[0-9]{2}[.,][0-9]{3}[[:space:]]*-->[[:space:]]*[0-9]{2}:[0-9]{2}:[0-9]{2}[.,][0-9]{3}([[:space:]]+(align:[[:alpha:]-]+|position:[^[:space:]%]+%?|line:[^[:space:]%]+%?|size:[^[:space:]%]+%?|vertical:[[:alpha:]-]+))*//g' \
        -e 's/[[:space:]]*-->[[:space:]]*[0-9]{2}:[0-9]{2}:[0-9]{2}[.,][0-9]{3}([[:space:]]+(align:[[:alpha:]-]+|position:[^[:space:]%]+%?|line:[^[:space:]%]+%?|size:[^[:space:]%]+%?|vertical:[[:alpha:]-]+))*//g' \
        "$vtt_file" | awk '
        BEGIN { seen_count = 0 }
        /^WEBVTT/ { next }
        /^Kind:/ { next }
        /^Language:/ { next }
        /^[0-9]{2}:[0-9]{2}:[0-9]{2}[.,][0-9]{3}\s*-->/ { next }
        /^[0-9]+$/ { next }
        /<[0-9]{2}:[0-9]{2}:[0-9]{2}[.,][0-9]{3}>/ { next }
        {
          gsub(/<[^>]+>/, "")
          gsub(/^[[:space:]]+|[[:space:]]+$/, "")
          if (length($0) == 0) next
          if (!seen[$0]) {
            seen[$0] = 1
            lines[++n] = $0
          }
        }
        END {
          s = ""
          for (i = 1; i <= n; i++) {
            s = (s == "" ? "" : s " ") lines[i]
          }
          gsub(/。/, "。\n", s)
          printf "%s", s
        }
      ')
      if [[ -n "$text" ]]; then
        echo ""
        echo "## 字幕 (${lang})"
        echo ""
        echo "$text"
      fi
    done <<< "$sub_files"
  else
    echo ""
    echo "## 字幕"
    echo ""
    echo "(取得できませんでした)"
  fi
}

# Reddit: JSON → Markdown
format_reddit() {
  local json_file="$1"

  local raw
  raw=$(cat "$json_file")

  # Thread detail: [{post listing}, {comments listing}]
  local is_thread
  is_thread=$(echo "$raw" | jq 'type == "array" and length >= 1' 2>/dev/null || echo "false")

  if [[ "$is_thread" == "true" ]]; then
    local post
    post=$(echo "$raw" | jq -r '.[0].data.children[0].data // empty')

    if [[ -n "$post" ]]; then
      local title subreddit author score num_comments created_utc selftext
      title=$(echo "$post" | jq -r '.title // empty')
      subreddit=$(echo "$post" | jq -r '.subreddit // empty')
      author=$(echo "$post" | jq -r '.author // empty')
      score=$(echo "$post" | jq -r '.score // 0')
      num_comments=$(echo "$post" | jq -r '.num_comments // 0')
      created_utc=$(echo "$post" | jq -r '.created_utc // empty')
      selftext=$(echo "$post" | jq -r '.selftext // empty')

      echo "# ${title:-"(タイトル不明)"}"
      echo ""
      echo "**r/${subreddit}** | u/${author} | スコア: ${score} | コメント: ${num_comments}"

      if [[ -n "$created_utc" && "$created_utc" != "null" ]]; then
        local date_str
        # Linux: date -d @EPOCH, macOS: date -r EPOCH
        date_str=$(date -d "@${created_utc}" '+%Y-%m-%d' 2>/dev/null || date -r "${created_utc}" '+%Y-%m-%d' 2>/dev/null || echo "")
        if [[ -n "$date_str" ]]; then
          echo "**投稿日**: ${date_str}"
        fi
      fi

      if [[ -n "$selftext" && "$selftext" != "[removed]" && "$selftext" != "[deleted]" ]]; then
        echo ""
        echo "## 本文"
        echo ""
        echo "$selftext"
      fi

      # Comments
      local comments
      comments=$(echo "$raw" | jq -c '.[1].data.children[]? | select(.kind == "t1")' 2>/dev/null || true)
      if [[ -n "$comments" ]]; then
        echo ""
        echo "## トップコメント"
        echo ""
        while IFS= read -r comment; do
          [[ -z "$comment" ]] && continue
          local c_author c_score c_body
          c_author=$(printf '%s' "$comment" | jq -r '.data.author // "unknown"')
          c_score=$(printf '%s' "$comment" | jq -r '.data.score // 0')
          c_body=$(printf '%s' "$comment" | jq -r '.data.body // ""')
          echo "**u/${c_author}** (スコア: ${c_score})"
          echo "$c_body"
          echo ""
        done < <(printf '%s' "$comments" | jq -c '.')
      fi
      return
    fi
  fi

  # Subreddit listing
  local children
  children=$(echo "$raw" | jq -r '.data.children // [] | length' 2>/dev/null || echo "0")
  if (( children > 0 )); then
    echo "# 投稿一覧"
    echo ""
    echo "$raw" | jq -r '.data.children[] | "## \(.data.title)\nu/\(.data.author) | スコア: \(.data.score) | コメント: \(.data.num_comments)\nURL: \(.data.url)\n"'
    return
  fi

  echo "(Reddit レスポンスの構造を解析できませんでした)"
  echo ""
  echo "${raw:0:1000}"
}

# ── Fetchers ─────────────────────────────────────────────────────────────────

fetch_youtube() {
  local url="$1"
  check_cmd yt-dlp

  local tmp_dir
  tmp_dir=$(mktemp -d)
  _register_cleanup "$tmp_dir"

  local base="${tmp_dir}/yt"
  local meta_out="${base}.meta.json"
  local subs_dir="${base}.subs"
  mkdir -p "$subs_dir"

  # Fetch metadata JSON
  yt-dlp --no-check-certificate --dump-json "$url" > "$meta_out" 2>&1

  # Fetch subtitles (best effort)
  yt-dlp --no-check-certificate --write-auto-subs --sub-lang ja,en --skip-download \
    -o "${subs_dir}/%(id)s" "$url" > /dev/null 2>&1 || true

  format_youtube "$meta_out" "$subs_dir"
}

fetch_github_repo() {
  local url="$1"
  check_cmd curl
  check_cmd jq

  local repo_path
  repo_path=$(echo "$url" | sed -E 's|^https?://github.com/([^/]+/[^/?#]+).*|\1|')

  local api_base="https://api.github.com/repos/${repo_path}"

  local repo_json
  repo_json=$(curl -sf -H "Accept: application/vnd.github.v3+json" "${api_base}") \
    || die "GitHub API error for ${repo_path} (check if the repo is public)"

  local name description language license stars forks issues homepage is_fork created updated topics
  name=$(echo "$repo_json" | jq -r '.full_name // empty')
  description=$(echo "$repo_json" | jq -r '.description // empty')
  language=$(echo "$repo_json" | jq -r '.language // "Unknown"')
  license=$(echo "$repo_json" | jq -r '.license.name // "No License"')
  stars=$(echo "$repo_json" | jq -r '.stargazers_count')
  forks=$(echo "$repo_json" | jq -r '.forks_count')
  issues=$(echo "$repo_json" | jq -r '.open_issues_count')
  homepage=$(echo "$repo_json" | jq -r '.homepage // empty')
  is_fork=$(echo "$repo_json" | jq -r '.fork')
  created=$(echo "$repo_json" | jq -r '.created_at // empty')
  updated=$(echo "$repo_json" | jq -r '.updated_at // empty')
  topics=$(echo "$repo_json" | jq -r '(.topics // []) | join(", ")')

  echo "# ${name:-"${repo_path}"}"
  echo ""
  if [[ -n "$description" ]]; then
    echo "${description}"
    echo ""
  fi
  echo "**Language**: ${language} | **License**: ${license} | **Stars**: ${stars} | **Forks**: ${forks} | **Open Issues**: ${issues}"
  [[ -n "$topics" ]] && echo "**Topics**: ${topics}"
  [[ -n "$homepage" ]] && echo "**Homepage**: ${homepage}"
  echo "**Fork**: ${is_fork} | **Created**: ${created} | **Updated**: ${updated}"
  echo "**URL**: https://github.com/${repo_path}"
  echo ""
  echo "---"
  echo ""

  local readme
  readme=$(curl -sf -H "Accept: application/vnd.github.v3.raw" "${api_base}/readme" 2>/dev/null || true)

  if [[ -n "$readme" ]]; then
    echo "## README"
    echo ""
    echo "$readme"
  else
    echo "*(README not found)*"
  fi
}

fetch_reddit() {
  local url="$1"
  check_cmd curl

  local tmp_file
  tmp_file=$(mktemp)
  _register_cleanup "$tmp_file"

  local json_url
  if [[ "$url" == *.json ]]; then
    json_url="$url"
  else
    json_url=$(echo "$url" | sed -E 's|/?(\?.*)?$|.json\1|')
  fi

  curl -sf "$json_url" -H "User-Agent: url-fetch-cli/1.0" > "$tmp_file"
  format_reddit "$tmp_file"
}

fetch_rss() {
  local url="$1"
  check_cmd python3
  python3 -c "import feedparser" 2>/dev/null || die "'feedparser' Python package is not installed (pip install feedparser)"

  python3 -c "
import feedparser, json, sys
f = feedparser.parse(sys.argv[1])
entries = [{'title': e.title, 'link': e.link, 'summary': getattr(e, 'summary', '')} for e in f.entries[:20]]
print(json.dumps(entries, ensure_ascii=False, indent=2))
" "$url"
}

fetch_web() {
  local url="$1"
  check_cmd curl

  curl -sf "https://r.jina.ai/${url}"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local url="$1"

  validate_url "$url"

  local service
  service=$(detect_service "$url")

  case "$service" in
    youtube)      fetch_youtube "$url" ;;
    github-repo)  fetch_github_repo "$url" ;;
    reddit)       fetch_reddit "$url" ;;
    rss)          fetch_rss "$url" ;;
    web)          fetch_web "$url" ;;
    *)            die "unknown service: $service" ;;
  esac
}

main "$@"
