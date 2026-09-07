import copy
import json
import sqlite3
from pathlib import Path
import tempfile
import unittest

from lessonmanager import AppError, Store


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lessonmanager-test-")
        self.store = Store(self.tmp.name)
        self.student = self.call("POST", "/api/students", {"name": "示例学生", "rates": {"数学": 15000, "物理": 20000}})

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, method, path, body=None):
        return self.store.mutate(method, path, body or {})

    def course(self, **kwargs):
        data = {"student_id": self.student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120}
        data.update(kwargs)
        return self.call("POST", "/api/courses", data)["created"][0]

    def balance(self):
        return next(s for s in self.store.state()["students"] if s["id"] == self.student["id"])["balance_cents"]

    def test_charge_payment_negative_balance_and_idempotent_completion(self):
        course = self.course()
        self.call("POST", "/api/payments", {"student_id": self.student["id"], "date": "2026-09-07", "amount_cents": 10000})
        self.assertEqual(self.balance(), 10000)
        for _ in range(2):
            self.call("PATCH", f"/api/courses/{course}", {"status": "completed", "actual_minutes": 120})
        self.assertEqual(self.balance(), -20000)
        self.call("POST", "/api/payments", {"student_id": self.student["id"], "date": "2026-09-08", "amount_cents": 100000})
        self.assertEqual(self.balance(), 80000)

    def test_rate_freeze_subject_rates_and_correction(self):
        first = self.course()
        self.call("PATCH", f"/api/courses/{first}", {"status": "completed", "actual_minutes": 60})
        self.call("PATCH", f"/api/students/{self.student['id']}", {"rates": {"数学": 30000, "物理": 20000}})
        self.assertEqual(self.balance(), -15000)
        second = self.course(subject="物理", date="2026-09-08")
        self.call("PATCH", f"/api/courses/{second}", {"status": "completed"})
        self.assertEqual(self.balance(), -55000)
        self.call("PATCH", f"/api/courses/{first}", {"actual_minutes": 120})
        self.assertEqual(self.balance(), -70000)
        self.call("PATCH", f"/api/courses/{first}", {"status": "scheduled"})
        self.assertEqual(self.balance(), -40000)

    def test_cancel_and_refund(self):
        c = self.course()
        self.call("PATCH", f"/api/courses/{c}", {"status": "cancelled"})
        self.assertEqual(self.balance(), 0)
        self.call("POST", "/api/payments", {"student_id": self.student["id"], "date": "2026-09-07", "amount_cents": 25000, "kind": "refund"})
        self.assertEqual(self.balance(), -25000)

    def test_weekly_series_only_moves_uncompleted_following(self):
        ids = self.call("POST", "/api/courses", {"student_id": self.student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120, "repeat_until": "2026-09-28"})["created"]
        self.assertEqual(len(ids), 4)
        self.call("PATCH", f"/api/courses/{ids[2]}", {"status": "completed"})
        self.call("PATCH", f"/api/courses/{ids[1]}", {"date": "2026-09-15", "start_time": "19:00", "scope": "following"})
        dates = {c["id"]: (c["date"], c["start_time"]) for c in self.store.state()["courses"]}
        self.assertEqual(dates[ids[0]], ("2026-09-07", "18:00"))
        self.assertEqual(dates[ids[1]], ("2026-09-15", "19:00"))
        self.assertEqual(dates[ids[2]], ("2026-09-21", "18:00"))
        self.assertEqual(dates[ids[3]], ("2026-09-29", "19:00"))

    def test_copy_previous_week_skips_duplicates(self):
        self.course()
        self.course(subject="物理", date="2026-09-08")
        first = self.call("POST", "/api/courses/copy-week", {"week_start": "2026-09-14"})
        again = self.call("POST", "/api/courses/copy-week", {"week_start": "2026-09-14"})
        self.assertEqual(len(first["created"]), 2)
        self.assertEqual(again, {"created": [], "skipped": 2})

    def test_conflicts_do_not_include_adjacent_or_cancelled(self):
        a = self.course()
        b = self.course(start_time="20:00")
        self.assertFalse(any(c["conflict"] for c in self.store.state()["courses"]))
        self.call("PATCH", f"/api/courses/{b}", {"start_time": "19:00"})
        self.assertTrue(all(c["conflict"] for c in self.store.state()["courses"]))
        self.call("PATCH", f"/api/courses/{a}", {"status": "cancelled"})
        self.assertFalse(any(c["conflict"] for c in self.store.state()["courses"]))

    def test_unknown_historical_charge_not_reported_as_known_zero(self):
        doc = self.store.export()
        doc["students"][0]["balance_verified"] = False
        doc["courses"] = [{"id": "legacy-example", "student_id": self.student["id"], "subject": "英语", "date": "2024-08-05", "start_time": None, "duration_minutes": 120, "actual_minutes": None, "status": "completed", "hourly_rate_cents": None, "source": "示例表.xlsx / Sheet1!B2", "needs_review": True}]
        self.store.restore(doc)
        state = self.store.state()
        self.assertIsNone(state["courses"][0]["fee_cents"])
        self.assertFalse(state["students"][0]["balance_verified"])
        with self.assertRaises(AppError):
            self.call("POST", f"/api/students/{self.student['id']}/reconcile", {"balance_cents": 10000, "note": "核对示例"})

    def test_new_course_whole_hours_historical_fraction_preserved(self):
        with self.assertRaises(AppError):
            self.course(duration_minutes=150)
        c = self.course()
        doc = self.store.export()
        doc["courses"][0].update(source="示例表.xlsx / A1", actual_minutes=150, status="completed", hourly_rate_cents=15000)
        self.store.restore(doc)
        self.assertEqual(self.balance(), -37500)
        self.call("PATCH", f"/api/courses/{c}", {"notes": "保留历史时长"})
        self.assertEqual(self.balance(), -37500)

    def test_restore_is_atomic_and_rejects_incomplete_backup(self):
        self.course()
        before = self.store.export()
        bad = copy.deepcopy(before)
        bad["courses"][0]["student_id"] = "missing"
        with self.assertRaises(AppError):
            self.store.restore(bad)
        after = self.store.export()
        for table in ("students", "courses", "payments", "reviews", "periods"):
            self.assertEqual(before[table], after[table])
        self.assertGreaterEqual(len(list((Path(self.tmp.name) / "backups").glob("*.sqlite3"))), 2)

    def test_reopen_same_database_retains_data_and_restore_matches(self):
        self.course()
        snapshot = self.store.export()
        reopened = Store(self.tmp.name)
        self.assertEqual(len(reopened.state()["courses"]), 1)
        with tempfile.TemporaryDirectory(prefix="lessonmanager-restore-") as target:
            recovered = Store(target)
            recovered.restore(snapshot)
            self.assertEqual(reopened.state()["students"], recovered.state()["students"])
            self.assertEqual(reopened.state()["courses"], recovered.state()["courses"])

    def test_balance_reconciliation_records_only_difference(self):
        c = self.course()
        self.call("PATCH", f"/api/courses/{c}", {"status": "completed"})
        self.call("POST", f"/api/students/{self.student['id']}/reconcile", {"balance_cents": 10000, "note": "已核对历史结余"})
        self.assertEqual(self.balance(), 10000)
        self.assertEqual(self.store.state()["payments"][0]["amount_cents"], 40000)

    def test_initial_import_is_reentrant_without_overwriting_edits(self):
        doc = self.store.export()
        self.call("PATCH", f"/api/students/{self.student['id']}", {"notes": "保留后续修改"})
        self.store.restore(doc, initial=True)
        self.store.restore(doc, initial=True)
        self.assertEqual(len(self.store.state()["students"]), 1)
        self.assertEqual(self.store.state()["students"][0]["notes"], "保留后续修改")

    def test_database_connection_closes_at_request_end(self):
        with self.store.connect() as conn:
            conn.execute("SELECT 1")
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_editing_historical_note_does_not_invent_missing_hours(self):
        self.course()
        doc = self.store.export()
        doc["courses"][0].update(source="示例表.xlsx / B2", status="completed", actual_minutes=None, hourly_rate_cents=15000, needs_review=True)
        self.store.restore(doc)
        course = doc["courses"][0]
        self.call("PATCH", f"/api/courses/{course['id']}", {"notes": "仅补充备注"})
        self.assertIsNone(self.store.state()["courses"][0]["actual_minutes"])


if __name__ == "__main__":
    unittest.main()
