#!/usr/bin/env python3
"""
Discordエージェントのsessions.sqliteから未処理のユーザーメッセージを差分抽出するスクリプト。

DBはサンドボックスコンテナ内の /sessions/{group}/sessions.sqlite にマウントされる。
session_entries.payload_jsonにはAgentMessageがラップ無しで保存される。

抽出と状態コミットを「単一実行＋成功後コミット」の2フェーズで行う:

  フェーズ1（抽出）: メッセージを stdout に出し、進めるべき状態を pending ファイルに書く。
    python3 extract_interests.py \
        --state-file data/interests/last-sync.json \
        --state-out data/interests/last-sync.json.pending \
        --max-messages 500

    --logs-dir を省略すると /sessions（コンテナ内マウント先）を使う。

  フェーズ2（コミット）: 全処理が正常完了した後に pending を本ファイルへ原子的に昇格する。
    python3 extract_interests.py \
        --state-file data/interests/last-sync.json \
        --commit data/interests/last-sync.json.pending

Output (フェーズ1): JSON array of extracted user messages to stdout.

動作要件: Python 3.7+（型注釈は from __future__ import annotations で遅延評価）
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

MIN_LENGTH = 20

# 状態ファイル (last-sync.json) のスキーマバージョン。
# version 3: SQLite session_entries の sequence をセッションごとに保持する（現行）。
# version 2: JSONL の行数を "{group}/{ファイル名}" ごとに保持する。
# version 1相当（旧Claude Code会話ログ対象版）はフラットな "{ファイル名}" キーで、
# schema_version フィールド自体を持たない。
SCHEMA_VERSION = 3

# role: "user" だが人間の発言ではない cron 合成メッセージのプレフィックス。
# src/cron/jobs/mail.ts:215-216 でメールスレッド初期化時に、エージェントへ文脈を
# 把握させるためメール本文を role: "user" として合成・書き込みしている
# （`メールID: ${meta.id}\n\n${emailText}`）。これは人間の興味ではないため
# 興味抽出の対象から除外する。
NOISE_PREFIXES = ("メールID: ",)


def normalize_content(content) -> str | None:
    """user メッセージの content を平文テキストに正規化する。

    @earendil-works/pi-ai の UserMessage["content"] は次の型を取る:
      string | (TextContent | ImageContent)[]
    （toolCall ブロックは AssistantMessage["content"] にのみ現れ、user content には含まれない）

    text ブロックのみを連結して返す。text ブロックを含まない場合（ImageContent のみ等）は None。
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                texts.append(block["text"])
        return "\n".join(texts) if texts else None
    return None


def default_logs_dir() -> Path:
    """コンテナ内のセッションログマウント先を返す（グループごとに /sessions/{group} がマウントされる）。"""
    return Path("/sessions")


def ts_ms_to_iso(ts_ms) -> str:
    """セッションログの timestamp（epochミリ秒）を ISO8601(UTC) に変換する。"""
    try:
        return datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return ""


def load_state(state_file: Path) -> dict:
    if state_file.exists():
        try:
            with open(state_file, encoding="utf-8") as f:
                state = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            # 破損していても止めない（自律実行ルール: エラーは記録して継続）。
            # 空状態にフォールバックすると全再読込になり安全側（取りこぼしより重複を許容）。
            print(f"WARNING: state file unreadable, starting fresh: {e}", file=sys.stderr)
            return {"last_sync_at": None, "sessions": {}}

        # schema_version が無い、または現行と異なる状態ファイルは session_id の
        # キー形式が噛み合わない可能性がある（例: 旧版はフラット "{ファイル名}"
        # キー、現行は "{group}/{ファイル名}"）。サイレントに sessions_state.get()
        # が常に {} を返す全件再走査に陥るより、検知して警告を出した上で
        # 明示的に sessions をリセットする（last_sync_at は参考情報として残す）。
        if state.get("schema_version") != SCHEMA_VERSION:
            print(
                f"WARNING: incompatible state file schema_version "
                f"({state.get('schema_version')!r} != {SCHEMA_VERSION!r}); "
                f"resetting sessions to re-scan all sessions safely.",
                file=sys.stderr,
            )
            state["sessions"] = {}
        return state
    return {"last_sync_at": None, "sessions": {}}


def save_state(state_file: Path, state: dict):
    """一時ファイルへ書き込んでから os.replace で原子的に差し替える。"""
    state_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_file.with_suffix(state_file.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, state_file)


def extract_from_session(filepath: Path, session_id: str, skip_lines: int = 0):
    """セッションを skip_lines の続きから読み、(抽出メッセージ, 走査した総行数) を返す。

    総行数は「この open で実際に EOF まで読んだ行数」なので、これを lines_read に
    使えば出力範囲としおりが必ず同一 open 内で整合する（読了後に別 open で数え直す
    と、その隙の追記分までしおりが進み恒久的に取りこぼす TOCTOU を生むため避ける）。
    """
    messages = []
    lines_total = 0
    with open(filepath, encoding="utf-8") as f:
        for i, line in enumerate(f):
            lines_total = i + 1
            if i < skip_lines:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue

            if obj.get("role") != "user":
                continue

            content = normalize_content(obj.get("content", ""))
            if content is None:
                continue
            if content.startswith(NOISE_PREFIXES):
                continue
            if len(content) <= MIN_LENGTH:
                continue

            messages.append({
                "ts": ts_ms_to_iso(obj.get("timestamp")),
                "session_id": session_id,
                "content": content[:2000],
            })
    return messages, lines_total


def read_recent_log(log_file: Path, days: int):
    """interest-log.jsonl のうち直近 days 日分の行だけを stdout へ出す。

    生ログ全体ではなく直近分だけを Claude に渡すことで、ログが何万行に
    増えても INTERESTS.md 生成時のコンテキスト量を頭打ちにする（案A）。
    ts がパースできない行（壊れた行・ts欠損）は直近フィルタの対象から除外する
    （=直近として扱わない）。生ログ自体（log_file）はこの関数で変更・削除
    されないため、ここで出力しなくても情報が永久に失われるわけではなく、
    今回のINTERESTS.md生成での重み付けに使われないだけである。
    逆に「念のため残す」と、ts が永久にパースできない行は毎回「直近」として
    出力され続けてしまい、鮮度フィルタの意味を恒久的に無効化するバグになる
    ため、除外側に倒す。
    """
    if not log_file.exists():
        return  # ログ未作成なら何も出さない（初回sync等）

    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    kept = 0
    with open(log_file, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            try:
                ts = json.loads(line).get("ts", "")
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if dt < cutoff:
                    continue
            except (json.JSONDecodeError, ValueError, AttributeError):
                continue  # 壊れた行・ts欠損は直近フィルタから除外する（生ログ自体は無変更なので情報は失われない）
            print(line)
            kept += 1
    print(f"--- Loaded {kept} signals from last {days} days ---", file=sys.stderr)


def commit_state(state_file: Path, pending_file: Path):
    """pending ファイルを本ファイルへ原子的に昇格する。"""
    if not pending_file.exists():
        print(f"ERROR: pending file not found: {pending_file}", file=sys.stderr)
        sys.exit(1)

    with open(pending_file, encoding="utf-8") as f:
        state = json.load(f)

    save_state(state_file, state)
    pending_file.unlink()
    print(f"--- Committed state to {state_file} ---", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Extract user messages from session logs")
    parser.add_argument("--logs-dir", help="セッションログのマウント先（省略時は /sessions）")
    parser.add_argument("--state-file", help="Path to last-sync.json state file（抽出/コミット時に必須）")
    parser.add_argument("--state-out", help="抽出フェーズで算出した状態を書き出す pending ファイル（本ファイルは触らない）")
    parser.add_argument("--commit", help="pending ファイルを --state-file へ原子的に昇格する（コミットフェーズ）")
    parser.add_argument("--recent-log", help="interest-log.jsonl のうち直近分だけを出力する（INTERESTS.md生成用）")
    parser.add_argument("--recent-days", type=int, default=90, help="--recent-log で出力する日数（既定: 90）")
    parser.add_argument("--max-messages", type=int, default=500, help="1実行あたりの抽出上限（0以下で無制限）")
    args = parser.parse_args()

    # 日本語を含む JSON を stdout へ出すため、出力を UTF-8 に固定する
    # （非UTF-8コンソールでの UnicodeEncodeError を防ぐ）
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    # 読み込みモード: 直近 N 日分のシグナルだけを出力して終了する
    if args.recent_log:
        read_recent_log(Path(args.recent_log), args.recent_days)
        return

    if not args.state_file:
        parser.error("--state-file is required unless --recent-log is given")
    state_file = Path(args.state_file)

    # コミットフェーズ: 抽出は行わず pending を昇格して終了する
    if args.commit:
        commit_state(state_file, Path(args.commit))
        return

    # 抽出フェーズ
    logs_dir = Path(args.logs_dir) if args.logs_dir else default_logs_dir()
    if not logs_dir.exists():
        print(f"ERROR: logs dir not found: {logs_dir}\n"
              f"  --logs-dir で明示指定してください。", file=sys.stderr)
        sys.exit(1)

    state = load_state(state_file)
    sessions_state = state.get("sessions", {})

    all_messages = []
    new_state = dict(sessions_state)

    limit_reached = False
    db_files = sorted(logs_dir.glob("*/sessions.sqlite"))
    for db_path in db_files:
        group = db_path.parent.name
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            raw_session_ids = [
                row[0] for row in connection.execute("SELECT id FROM sessions ORDER BY id")
            ]
            for raw_session_id in raw_session_ids:
                session_id = f"{group}/{raw_session_id}"
                prev_sequence = sessions_state.get(session_id, {}).get("sequence", 0)
                rows = connection.execute(
                    "SELECT sequence, payload_json FROM session_entries "
                    "WHERE session_id = ? AND sequence > ? ORDER BY sequence",
                    (raw_session_id, prev_sequence),
                )
                for sequence, payload_json in rows:
                    new_state[session_id] = {"sequence": sequence}
                    try:
                        obj = json.loads(payload_json)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("role") != "user":
                        continue
                    content = normalize_content(obj.get("content", ""))
                    if content is None or content.startswith(NOISE_PREFIXES) or len(content) <= MIN_LENGTH:
                        continue
                    all_messages.append({
                        "ts": ts_ms_to_iso(obj.get("timestamp")),
                        "session_id": session_id,
                        "content": content[:2000],
                    })
                    if args.max_messages > 0 and len(all_messages) >= args.max_messages:
                        limit_reached = True
                        break
                if limit_reached:
                    break
            if limit_reached:
                break
        finally:
            connection.close()

    json.dump(all_messages, sys.stdout, ensure_ascii=False, indent=2)

    if args.state_out:
        # 実行環境のローカルタイムゾーンで記録する（環境を問わず正しいオフセットになる）
        state["schema_version"] = SCHEMA_VERSION
        state["last_sync_at"] = datetime.now().astimezone().isoformat()
        state["sessions"] = new_state
        save_state(Path(args.state_out), state)

    print(f"\n--- Extracted {len(all_messages)} messages from {len([s for s in new_state if new_state[s] != sessions_state.get(s)])} new/updated sessions ---", file=sys.stderr)


if __name__ == "__main__":
    main()
