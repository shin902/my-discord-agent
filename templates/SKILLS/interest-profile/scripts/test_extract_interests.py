import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("extract_interests.py")


def create_db(root, sessions):
    db_dir = root / "group"
    db_dir.mkdir()
    db = sqlite3.connect(db_dir / "sessions.sqlite")
    db.executescript("""
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE session_entries (
          session_id TEXT, sequence INTEGER, payload_json TEXT,
          PRIMARY KEY (session_id, sequence));
        CREATE INDEX session_entries_session_id_id ON session_entries(session_id, sequence);
    """)
    for session_id, count in sessions.items():
        db.execute("INSERT INTO sessions VALUES (?)", (session_id,))
        db.executemany(
            "INSERT INTO session_entries VALUES (?, ?, ?)",
            [(session_id, sequence, json.dumps({"role": "user", "content": f"qualifying message number {sequence:04d}"}))
             for sequence in range(1, count + 1)],
        )
    db.commit()
    db.close()


def run_extract(root, state, pending, maximum=500):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--logs-dir", str(root), "--state-file", str(state),
         "--state-out", str(pending), "--max-messages", str(maximum)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout), json.loads(pending.read_text())


class ExtractInterestsTest(unittest.TestCase):
    def test_v2_state_rescans_and_migrates_to_v3(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            create_db(root, {"one": 2})
            state = root / "state.json"
            state.write_text(json.dumps({"schema_version": 2, "sessions": {"group/old.jsonl": {"lines_read": 99}}}))
            messages, pending = run_extract(root, state, root / "pending.json")
            self.assertEqual(2, len(messages))
            self.assertEqual(3, pending["schema_version"])
            self.assertEqual({"sequence": 2}, pending["sessions"]["group/one"])

    def test_limit_across_sessions_continues_without_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            create_db(root, {"a": 400, "b": 300})
            state = root / "state.json"
            first, pending = run_extract(root, state, root / "first.json")
            self.assertEqual(500, len(first))
            self.assertEqual({"sequence": 100}, pending["sessions"]["group/b"])
            state.write_text(json.dumps(pending))
            second, final = run_extract(root, state, root / "second.json")
            self.assertEqual(200, len(second))
            self.assertEqual({"sequence": 300}, final["sessions"]["group/b"])
            self.assertEqual(700, len({(m["session_id"], m["content"]) for m in first + second}))

    def test_noop_sync_does_not_select_historical_payloads(self):
        spec = importlib.util.spec_from_file_location("extract_interests", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            create_db(root, {"one": 2})
            state = root / "state.json"
            state.write_text(json.dumps({"schema_version": 3, "sessions": {"group/one": {"sequence": 2}}}))
            statements = []
            real_connect = module.sqlite3.connect
            def traced_connect(*args, **kwargs):
                connection = real_connect(*args, **kwargs)
                connection.set_trace_callback(statements.append)
                return connection
            module.sqlite3.connect = traced_connect
            old_argv = sys.argv
            sys.argv = [str(SCRIPT), "--logs-dir", str(root), "--state-file", str(state), "--state-out", str(root / "pending.json")]
            try:
                module.main()
            finally:
                sys.argv = old_argv
            payload_queries = [sql for sql in statements if "payload_json" in sql]
            self.assertEqual(1, len(payload_queries))
            self.assertIn("sequence > 2", payload_queries[0])


if __name__ == "__main__":
    unittest.main()
