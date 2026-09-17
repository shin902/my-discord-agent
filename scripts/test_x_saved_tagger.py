import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("tagger", Path(__file__).with_name("x-saved-tagger.py"))
tagger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tagger)

ALIASES = {
    "series": {"bocchi_the_rock": {"aliases": ["ぼざろ", "ぼっち・ざ・ろっく"]}},
    "characters": {"gotoh_hitori": {"series": "bocchi_the_rock", "aliases": ["後藤ひとり", "ぼっちちゃん"]}},
    "tags": {"ai": {"aliases": []}, "a+b": {"aliases": []}},
}


class ClassifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "archive"
        self.root.mkdir()
        self.db_path = self.root / "x-saved.sqlite"
        self.db = sqlite3.connect(self.db_path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            PRAGMA user_version=5;
            CREATE TABLE x_items (tweet_id TEXT PRIMARY KEY, text TEXT);
            CREATE TABLE x_media (tweet_id TEXT, kind TEXT, position INTEGER, status TEXT, local_path TEXT);
            CREATE TABLE x_item_labels (tweet_id TEXT, kind TEXT, value TEXT CHECK(length(value) BETWEEN 1 AND 100), PRIMARY KEY(tweet_id,kind,value));
            CREATE TABLE x_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE x_item_state (tweet_id TEXT PRIMARY KEY, status TEXT, note TEXT);
        """)
        self.infer = Mock(return_value={"copyright": {}, "character": {}, "general": {}})
        self.loader = patch.object(tagger, "load_tagger", return_value=self.infer).start()
        self.addCleanup(patch.stopall)

    def seed(self, tweet_id="123", text="ぼっちちゃん", status="done", positions=(0,)):
        with self.db:
            self.db.execute("INSERT INTO x_items VALUES (?,?)", (tweet_id, text))
            self.db.execute("INSERT INTO x_item_state VALUES (?,'keep','retained note')", (tweet_id,))
            for position in positions:
                local = f"media/{tweet_id}/{position}.jpg"
                target = self.root / local
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"image fixture")
                self.db.execute("INSERT INTO x_media VALUES (?,'image',?,?,?)", (tweet_id, position, status, local))

    def run_batch(self, **kwargs):
        return tagger.classify(self.db_path, ALIASES, str(self.root.parent / "cache"), **kwargs)

    def labels(self, tweet_id="123"):
        return set(self.db.execute("SELECT kind,value FROM x_item_labels WHERE tweet_id=?", (tweet_id,)))

    def test_literal_aliases_boundaries_normalization_and_ambiguity(self):
        aliases = tagger.read_aliases(ALIASES)
        labels = tagger.text_labels("mail ＡＩ a+b ぼっちちゃん", aliases)
        self.assertEqual(labels, {("tag", "ai"), ("tag", "a+b"), ("character", "gotoh_hitori"), ("series", "bocchi_the_rock")})
        self.assertEqual(tagger.text_labels("mail aaab", aliases), set())
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            tagger.read_aliases({"tags": {"a": {"aliases": ["same"]}, "b": {"aliases": ["SAME"]}}})
        with self.assertRaisesRegex(ValueError, "reference"):
            tagger.read_aliases({"characters": {"a": {"series": "missing"}}})
        for group in ("series", "characters", "tags"):
            for first, second in (("Alice", "alice"), ("Ａｌｉｃｅ", "alice"), ("alice smith", "alice_smith")):
                with self.subTest(group=group, first=first), self.assertRaisesRegex(ValueError, "Ambiguous canonical"):
                    tagger.read_aliases({group: {first: {}, second: {}}})

    def test_all_images_union_thresholds_and_manual_labels_survive(self):
        self.seed(positions=(0, 1))
        with self.db:
            self.db.execute("INSERT INTO x_item_labels VALUES ('123','tag','manual')")
        self.infer.side_effect = [
            {"copyright": {"Bocchi The Rock": 0.46}, "character": {"後藤ひとり": 0.37}, "general": {"guitar": 0.9, "low": 0.1}, "rating": {"rating:g": 1}},
            {"copyright": {"other_series": 0.8}, "character": {"other_character": 0.8}, "general": {"guitar": 0.8, "solo": 0.7}},
        ]
        self.assertEqual(self.run_batch(), {"processed": 1, "failed": 0})
        self.assertEqual(self.infer.call_count, 2)
        self.assertEqual(self.loader.call_count, 1)
        self.assertEqual(self.labels(), {("series", "bocchi_the_rock"), ("series", "other_series"), ("character", "gotoh_hitori"), ("character", "other_character"), ("tag", "manual"), ("tag", "guitar"), ("tag", "solo")})
        self.assertEqual(self.db.execute("SELECT status,note FROM x_item_state").fetchone(), ("keep", "retained note"))
        self.assertEqual(self.db.execute("SELECT status,local_path FROM x_media ORDER BY position").fetchall(),
                         [("done", "media/123/0.jpg"), ("done", "media/123/1.jpg")])
        self.assertEqual(self.run_batch(), {"processed": 0, "failed": 0})
        self.assertEqual(self.infer.call_count, 2)
        # Human removal is not undone by the next unchanged run.
        with self.db:
            self.db.execute("DELETE FROM x_item_labels WHERE value IN ('guitar', 'gotoh_hitori')")
        self.run_batch()
        self.assertNotIn(("tag", "guitar"), self.labels())
        self.assertNotIn(("character", "gotoh_hitori"), self.labels())

    def test_failure_retries_without_writing_text_or_partial_image_labels(self):
        self.seed("123", positions=(0, 1))
        self.infer.side_effect = [
            {"copyright": {}, "character": {}, "general": {"partial": 0.9}},
            ValueError("broken image"),
        ] * 2
        for _ in range(2):
            self.assertEqual(self.run_batch(limit=1), {"processed": 0, "failed": 1})
            self.assertEqual(self.labels(), set())
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM x_meta").fetchone()[0], 0)
        self.infer.side_effect = None
        self.assertEqual(self.run_batch(limit=1), {"processed": 1, "failed": 0})
        self.assertEqual(self.db.execute("SELECT value FROM x_meta").fetchone()[0], "done")
        self.assertEqual(self.labels(), {("character", "gotoh_hitori"), ("series", "bocchi_the_rock")})

    def test_filters_unready_tweets_before_limit(self):
        self.seed("pending", status="pending", positions=(0, 1))
        self.seed("ready")
        real_connect = sqlite3.connect

        def connect(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connection.create_function("random", 0, lambda: 0)
            return connection

        with patch.object(tagger.sqlite3, "connect", side_effect=connect):
            self.assertEqual(self.run_batch(limit=1)["processed"], 1)
        self.assertEqual(self.loader.call_count, 1)
        self.assertEqual(self.labels("pending"), set())
        self.assertEqual(self.db.execute(
            "SELECT value FROM x_meta WHERE key='pixai-v1:ready'"
        ).fetchone(), ("done",))

    def test_waits_for_all_downloads_and_reprocesses_only_after_marker_removal(self):
        self.seed(positions=(0, 1))
        with self.db:
            self.db.execute("UPDATE x_media SET status='pending' WHERE position=1")
        self.run_batch()
        self.loader.assert_not_called()
        self.assertEqual(self.run_batch()["processed"], 0)
        self.assertEqual(self.labels(), set())
        with self.db:
            self.db.execute("UPDATE x_media SET status='done'")
        self.assertEqual(self.run_batch()["processed"], 1)
        self.assertEqual(self.infer.call_count, 2)
        with self.db:
            self.db.execute("UPDATE x_items SET text='AI'")
        self.assertEqual(self.run_batch(thresholds={"general": 0.8})["processed"], 0)
        self.assertEqual(self.infer.call_count, 2)
        with self.db:
            self.db.execute("DELETE FROM x_meta WHERE key='pixai-v1:123'")
        self.infer.return_value["general"] = {"guitar": 0.7}
        self.assertEqual(self.run_batch(thresholds={"general": 0.8})["processed"], 1)
        self.assertIn(("tag", "ai"), self.labels())
        self.assertNotIn(("tag", "guitar"), self.labels())

    def test_archive_escape_and_missing_file_remain_retryable(self):
        self.seed()
        with self.db:
            self.db.execute("UPDATE x_media SET local_path='../outside.jpg'")
        self.assertEqual(self.run_batch()["failed"], 1)
        self.loader.assert_not_called()
        with self.db:
            self.db.execute("UPDATE x_media SET local_path='media/123/0.jpg'")
        (self.root / "media/123/0.jpg").unlink()
        self.infer.side_effect = lambda image: image.read_bytes()
        self.assertEqual(self.run_batch()["failed"], 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM x_meta").fetchone()[0], 0)

    def test_caps_image_labels_but_never_discards_text_or_existing(self):
        self.seed(text="AI")
        self.infer.return_value["general"] = {f"tag_{n:02}": 0.9 for n in range(80)}
        self.run_batch()
        tags = {value for kind, value in self.labels() if kind == "tag"}
        self.assertEqual(len(tags), 50)
        self.assertIn("ai", tags)
        self.assertIn("tag_00", tags)
        self.assertNotIn("tag_79", tags)

    def test_database_failure_escapes_and_rolls_back_completion(self):
        self.seed()
        self.infer.return_value["general"] = {"guitar": 0.9}
        self.db.executescript("""CREATE TRIGGER fail BEFORE INSERT ON x_meta
            BEGIN SELECT RAISE(ABORT, 'db failed'); END;""")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "db failed"):
            self.run_batch()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM x_meta").fetchone()[0], 0)
        self.assertEqual(self.labels(), set())


if __name__ == "__main__":
    unittest.main()
