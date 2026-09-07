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

    def test_settled_history_preserves_unknowns_and_only_new_work_changes_balance(self):
        doc = self.store.export()
        sid = self.student["id"]
        doc["students"][0]["balance_verified"] = False
        doc["courses"] = [dict(id="old", student_id=sid, subject="数学", date=None, start_time=None,
                               duration_minutes=120, actual_minutes=None, hourly_rate_cents=None,
                               status="completed", source="虚构旧表.xlsx / A1", needs_review=True)]
        doc["payments"] = [dict(id="old-pay", student_id=sid, date=None, kind="payment", amount_cents=50000)]
        doc["reviews"] = [dict(id="old-review", student_id=sid, course_id="old", kind="missing_course_fields")]
        self.store.restore(doc)
        future = self.course(date="2099-09-12")
        before = self.store.export()
        result = self.call("POST", f"/api/students/{sid}/settle-history", {
            "course_ids": ["old"], "payment_ids": ["old-pay"], "note": "老师确认此前全部结清，无欠费无剩余预付款"})
        self.assertEqual(self.balance(), 0)
        self.assertEqual(result["balance_cents"], 0)
        after = self.store.export()
        for table in ("courses", "payments", "reviews"):
            self.assertEqual(after[table], before[table])
        self.assertTrue(self.store.state()["students"][0]["balance_verified"])
        self.call("PATCH", "/api/courses/old", {"date": "2025-08-01", "start_time": "18:00", "actual_minutes": 120, "hourly_rate_cents": 20000, "needs_review": False})
        self.call("PATCH", "/api/payments/old-pay", {"date": "2025-07-01", "amount_cents": 70000})
        self.assertEqual(self.balance(), 0)
        self.call("PATCH", f"/api/courses/{future}", {"status": "completed", "actual_minutes": 60})
        self.assertEqual(self.balance(), -15000)
        self.call("POST", "/api/payments", {"student_id": sid, "date": "2099-09-12", "amount_cents": 10000})
        self.assertEqual(self.balance(), -5000)
        # Retrying the historical confirmation must never absorb new lessons or payments.
        again = self.call("POST", f"/api/students/{sid}/settle-history", {"course_ids": [], "payment_ids": [], "note": "重试"})
        self.assertEqual(again, result)
        self.assertEqual(self.balance(), -5000)
        self.call("PATCH", f"/api/courses/{future}", {"status": "scheduled"})
        self.assertEqual(self.balance(), 10000)
        saved = self.store.export()
        self.store.restore(saved)
        self.assertEqual(self.balance(), 10000)
        self.assertEqual(self.store.state()["students"][0]["settlement"], result)

    def test_settlement_scope_and_restore_validation(self):
        sid = self.student["id"]
        future = self.course(date="2099-09-12")
        path = f"/api/students/{sid}/settle-history"
        with self.assertRaises(AppError):
            self.call("POST", path, {"course_ids": [future], "payment_ids": [], "note": "结清"})
        other = self.call("POST", "/api/students", {"name": "另一个虚构学生"})
        payment = self.call("POST", "/api/payments", {"student_id": other["id"], "date": "2025-01-01", "amount_cents": 20000})
        with self.assertRaises(AppError):
            self.call("POST", path, {"course_ids": [], "payment_ids": [payment["id"]], "note": "结清"})
        self.assertNotIn("account_settlements", self.store.export()["meta"])
        self.call("POST", path, {"course_ids": [], "payment_ids": [], "note": "历史无结余"})
        doc = self.store.export()
        doc["meta"]["account_settlements"][sid]["payment_ids"] = [payment["id"]]
        with self.assertRaises(AppError):
            self.store.restore(doc)
        self.assertEqual(self.store.state()["students"][0]["settlement"]["payment_ids"], [])

    def test_reconcile_current_balance_ignores_settled_unknown_history(self):
        doc = self.store.export()
        sid = self.student["id"]
        doc["courses"] = [dict(id="unknown", student_id=sid, subject="数学", date=None, start_time=None,
                               status="completed", actual_minutes=None, hourly_rate_cents=None, needs_review=True, source="虚构旧表")]
        self.store.restore(doc)
        self.call("POST", f"/api/students/{sid}/settle-history", {"course_ids": ["unknown"], "payment_ids": [], "note": "全部旧账结清"})
        self.call("POST", f"/api/students/{sid}/reconcile", {"balance_cents": 30000, "note": "核对后续新账"})
        self.assertEqual(self.balance(), 30000)
        self.assertIsNone(self.store.state()["courses"][0]["fee_cents"])

    def test_confirmed_carryover_preserves_credit_or_debt_without_cash_payment(self):
        sid = self.student["id"]
        for opening in (400000, -90000):
            with self.subTest(opening=opening):
                doc = self.store.export()
                doc["courses"] = []
                doc["payments"] = [dict(id="old-pay", student_id=sid, date=None, amount_cents=20000, kind="payment")]
                doc["meta"].pop("account_settlements", None)
                self.store.restore(doc)
                self.call("POST", f"/api/students/{sid}/settle-history", {"balance_cents": opening, "course_ids": [], "payment_ids": ["old-pay"], "note": "虚构原表的期初结转扣除本期已上课"})
                self.assertEqual(self.balance(), opening)
                self.assertEqual(len(self.store.state()["payments"]), 1)
                new = self.course()
                self.call("PATCH", f"/api/courses/{new}", {"status": "completed", "actual_minutes": 60})
                self.assertEqual(self.balance(), opening - 15000)
                self.call("POST", "/api/payments", {"student_id": sid, "date": "2026-09-08", "amount_cents": 30000})
                self.assertEqual(self.balance(), opening + 15000)
                self.store.restore(self.store.export())
                self.assertEqual(self.balance(), opening + 15000)

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

    def historical_course(self, kinds, **fields):
        course_id = self.course()
        doc = self.store.export()
        doc["courses"][0].update(source="示例表.xlsx / B2", status="completed", actual_minutes=None, hourly_rate_cents=None, needs_review=True, **fields)
        doc["reviews"] = [dict(id=kind, student_id=self.student["id"], course_id=course_id, kind=kind,
                               message="历史事项待核对", source="示例表.xlsx / B2", status="pending", resolution="") for kind in kinds]
        self.store.restore(doc)
        return course_id

    def test_confirming_charge_keeps_missing_date_pending_until_filled(self):
        course_id = self.historical_course(["missing_course_fields", "zero_rate"], date=None)
        self.call("PATCH", f"/api/courses/{course_id}", {"actual_minutes": 120, "hourly_rate_cents": 15000, "needs_review": False})
        state = self.store.state()
        self.assertIsNone(state["courses"][0]["date"])
        self.assertIsNone(state["courses"][0]["fee_cents"])
        self.assertEqual({r["id"]: r["status"] for r in state["reviews"]}, {"missing_course_fields": "pending", "zero_rate": "resolved"})
        with self.assertRaisesRegex(AppError, "日期"):
            self.call("PATCH", "/api/reviews/missing_course_fields", {"status": "resolved", "resolution": "核对时长单价"})
        self.call("PATCH", f"/api/courses/{course_id}", {"date": "2024-08-05", "needs_review": False})
        state = self.store.state()
        self.assertTrue(all(r["status"] == "resolved" for r in state["reviews"]))
        self.assertEqual(state["courses"][0]["fee_cents"], 30000)

    def test_charge_confirmation_keeps_other_reviews_and_manual_resolution_updates_fee(self):
        course_id = self.historical_course(["schedule_only", "time_typo"])
        self.call("PATCH", f"/api/courses/{course_id}", {"actual_minutes": 120, "hourly_rate_cents": 15000, "needs_review": False})
        state = self.store.state()
        self.assertEqual({r["id"]: r["status"] for r in state["reviews"]}, {"schedule_only": "pending", "time_typo": "resolved"})
        self.assertTrue(state["courses"][0]["needs_review"])
        self.call("PATCH", "/api/reviews/schedule_only", {"status": "resolved", "resolution": "已与原账核对出勤和扣费"})
        self.assertEqual(self.store.state()["courses"][0]["fee_cents"], 30000)

    def test_manual_course_review_rejects_objective_missing_fields(self):
        for fields, label in [({"start_time": None}, "开始时间"), ({"subject": "待确认"}, "科目"), ({}, "实际时长")]:
            with self.subTest(label=label):
                doc = self.store.export()
                doc["courses"] = []
                doc["reviews"] = []
                self.store.restore(doc)
                self.historical_course(["missing_course_fields"], **fields)
                with self.assertRaisesRegex(AppError, label):
                    self.call("PATCH", "/api/reviews/missing_course_fields", {"status": "resolved", "resolution": "核对完成"})
                self.assertEqual(self.store.state()["reviews"][0]["status"], "pending")

    def test_historical_payment_date_preserved_and_only_selected_source_resolved(self):
        doc = self.store.export()
        doc["payments"] = [dict(id=f"payment-{n}", student_id=self.student["id"], date=None, kind="payment", amount_cents=10000, source=f"示例表.xlsx / B{n}") for n in (2, 3)]
        doc["reviews"] = [dict(id=f"review-{n}", student_id=self.student["id"], kind="payment_date_missing", source=f"示例表.xlsx / B{n}") for n in (2, 3)]
        self.store.restore(doc)
        self.call("PATCH", "/api/payments/payment-2", {"notes": "仅补充备注"})
        self.assertIsNone(self.store.state()["payments"][0]["date"])
        with self.assertRaises(AppError):
            self.call("PATCH", "/api/payments/payment-2", {"date": "2024-08-05", "review_ids": ["review-3"]})
        self.assertIsNone(self.store.state()["payments"][0]["date"])
        with self.assertRaisesRegex(AppError, "日期"):
            self.call("PATCH", "/api/reviews/review-2", {"status": "resolved", "resolution": "已核对"})
        self.call("PATCH", "/api/payments/payment-2", {"date": "2024-08-05", "review_ids": ["review-2"]})
        self.assertEqual({r["id"]: r["status"] for r in self.store.state()["reviews"]}, {"review-2": "resolved", "review-3": "pending"})

    def test_imported_undated_payment_without_source_can_keep_date_empty(self):
        doc = self.store.export()
        doc["payments"] = [dict(id="undated", student_id=self.student["id"], date=None, kind="refund", amount_cents=-10000)]
        self.store.restore(doc)
        payment = self.call("PATCH", "/api/payments/undated", {"notes": "仅补充备注"})
        self.assertIsNone(payment["date"])
        self.assertEqual(payment["amount_cents"], -10000)
        with self.assertRaisesRegex(AppError, "日期"):
            self.call("POST", "/api/payments", {"student_id": self.student["id"], "amount_cents": 10000})

    def test_reopening_course_review_restores_unknown_charge(self):
        course_id = self.historical_course(["time_typo"])
        self.call("PATCH", f"/api/courses/{course_id}", {"actual_minutes": 121, "hourly_rate_cents": 15000, "needs_review": False})
        self.assertEqual(self.store.state()["courses"][0]["fee_cents"], 30250)
        self.call("PATCH", "/api/reviews/time_typo", {"status": "pending", "resolution": "需要再次核实"})
        self.assertIsNone(self.store.state()["courses"][0]["fee_cents"])


if __name__ == "__main__":
    unittest.main()
