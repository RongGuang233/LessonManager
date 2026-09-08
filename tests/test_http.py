import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from lessonmanager import Store, make_handler


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="lessonmanager-http-")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Store(self.tmp.name)))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path, method="GET", data=None):
        content = json.dumps(data).encode() if data is not None else None
        request = Request(self.base + path, data=content, method=method, headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            return json.load(response)

    def test_real_http_charge_and_backup_restore(self):
        self.assertEqual(self.request("/api/health")["app"], "LessonManager")
        student = self.request("/api/students", "POST", {"name": "HTTP示例", "rates": {"数学": 15000}})
        course = self.request("/api/courses", "POST", {"student_id": student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120})["created"][0]
        self.request(f"/api/courses/{course}", "PATCH", {"status": "completed", "actual_minutes": 60})
        self.assertEqual(self.request("/api/state")["students"][0]["balance_cents"], -15000)
        backup = self.request("/api/backup")
        self.request("/api/payments", "POST", {"student_id": student["id"], "date": "2026-09-08", "amount_cents": 50000})
        self.assertEqual(self.request("/api/state")["students"][0]["balance_cents"], 35000)
        self.request("/api/restore", "POST", {"backup": backup})
        self.assertEqual(self.request("/api/state")["students"][0]["balance_cents"], -15000)

    def test_invalid_restore_leaves_live_state_unchanged(self):
        self.request("/api/students", "POST", {"name": "恢复示例", "rates": {"数学": 10000}})
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/restore", "POST", {"backup": {"schema_version": 1}})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(len(self.request("/api/state")["students"]), 1)
        with caught.exception as response:
            error = json.load(response)
        self.assertIn("缺少", error["error"])

    def test_regular_duration_and_pending_period_over_http(self):
        student = self.request("/api/students", "POST", {"name": "常规课长示例", "default_duration_minutes": 180})
        self.assertEqual(student["default_duration_minutes"], 180)
        period = self.request("/api/periods", "POST", {"name": "下学期待定", "range_kind": "pending"})
        self.assertEqual((period["start"], period["end"]), ("", ""))
        for path, body in ((f"/api/students/{student['id']}", {"default_duration_minutes": 90}), (f"/api/periods/{period['id']}", {"range_kind": "term"})):
            with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                self.request(path, "PATCH", body)
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()
        backup = self.request("/api/backup")
        self.request(f"/api/periods/{period['id']}", "PATCH", {"range_kind": "term", "start": "2026-09-01", "end": "2027-01-31"})
        self.request("/api/restore", "POST", {"backup": backup})
        state = self.request("/api/state")
        self.assertEqual(state["periods"], [period])
        self.assertEqual(state["students"][0]["default_duration_minutes"], 180)

    def test_batch_cancel_preview_commit_and_repeat_over_http(self):
        student = self.request("/api/students", "POST", {"name": "停课示例"})
        courses = self.request("/api/courses", "POST", {"student_id": student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120, "repeat_until": "2026-09-21"})["created"]
        path = f"/api/courses/{courses[1]}/cancel"
        preview = self.request(path, "POST", {"scope": "following", "preview": True})
        self.assertEqual(preview["count"], 2)
        self.assertTrue(all(c["status"] == "scheduled" for c in self.request("/api/state")["courses"]))
        self.assertEqual(self.request(path, "POST", {"scope": "following"}), {"count": 2})
        self.assertEqual(self.request(path, "POST", {"scope": "following"}), {"count": 0})

    def test_makeup_reason_and_selected_copy_over_http(self):
        student = self.request("/api/students", "POST", {"name": "补课示例", "rates": {"数学": 10000}})
        body = {"student_id": student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120, "notes": "原备注"}
        source = self.request("/api/courses", "POST", body)["created"][0]
        self.request(f"/api/courses/{source}/cancel", "POST", {"scope": "one", "reason": "学生请假"})
        makeup = self.request("/api/courses", "POST", dict(body, date="2026-09-08", makeup_for_id=source))["created"][0]
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/courses", "POST", dict(body, makeup_for_id=source))
        self.assertEqual(caught.exception.code, 400)
        caught.exception.close()
        rows = {c["id"]: c for c in self.request("/api/state")["courses"]}
        self.assertEqual(rows[source]["notes"], "请假原因：学生请假\n原备注")
        self.assertEqual(rows[makeup]["makeup_for_id"], source)
        copy_body = {"week_start": "2026-09-14", "source_ids": [makeup], "preview": True}
        candidate = self.request("/api/courses/copy-week", "POST", copy_body)["created"][0]
        self.assertEqual(candidate["source_course_id"], makeup)
        self.assertIsNone(candidate["makeup_for_id"])
        self.assertEqual(self.request("/api/courses/copy-week", "POST", dict(copy_body, preview=False, source_ids=[])), {"created": [], "skipped": 0})
        created = self.request("/api/courses/copy-week", "POST", dict(copy_body, preview=False))["created"]
        self.assertEqual(len(created), 1)

    def test_local_backup_list_preview_restore_and_corrupt_errors_over_http(self):
        self.request("/api/students", "POST", {"name": "本机备份示例"})
        self.request("/api/backup")
        backup = self.request("/api/backups")["backups"][0]
        path = f"/api/backups/{backup['filename']}"
        self.assertEqual(self.request(path + "/preview")["counts"]["students"], 1)
        self.request("/api/students", "POST", {"name": "恢复前示例"})
        self.assertEqual(self.request(path + "/restore", "POST", {}), {"ok": True})
        self.assertEqual(len(self.request("/api/state")["students"]), 1)
        (Path(self.tmp.name) / "backups" / "lessonmanager_corrupt.sqlite3").write_bytes(b"broken")
        for suffix, method, data in (("preview", "GET", None), ("restore", "POST", {})):
            with self.subTest(suffix=suffix), self.assertRaises(HTTPError) as caught:
                self.request(f"/api/backups/lessonmanager_corrupt.sqlite3/{suffix}", method, data)
            self.assertEqual(caught.exception.code, 400)
            with caught.exception as response:
                self.assertIn("损坏", json.load(response)["error"])
        self.assertEqual(len(self.request("/api/state")["students"]), 1)

    def test_copy_preview_and_period_source_range_over_http(self):
        student = self.request("/api/students", "POST", {"name": "复制示例"})
        self.request("/api/courses", "POST", {"student_id": student["id"], "subject": "数学", "date": "2026-09-07", "start_time": "18:00", "duration_minutes": 120})
        body = {"week_start": "2026-09-14", "student_id": student["id"], "status": "scheduled", "preview": True}
        preview = self.request("/api/courses/copy-week", "POST", body)
        self.assertEqual(len(self.request("/api/state")["courses"]), 1)
        self.assertEqual(preview["created"][0]["date"], "2026-09-14")
        result = self.request("/api/courses/copy-week", "POST", dict(body, preview=False))
        self.assertIsInstance(result["created"][0], str)
        self.assertEqual(len(self.request("/api/state")["courses"]), 2)
        period = self.request("/api/periods", "POST", {"name": "导入日期", "start": "2026-09-07", "end": "2026-10-28", "range_kind": "coverage", "source_start": "2026-09-07", "source_end": "2026-10-28"})
        period = self.request(f"/api/periods/{period['id']}", "PATCH", {"range_kind": "term", "start": "2026-09-01", "end": "2027-01-31"})
        self.assertEqual((period["range_kind"], period["source_start"], period["source_end"]), ("term", "2026-09-07", "2026-10-28"))

    def test_historical_review_cannot_hide_missing_date_over_http(self):
        student = self.request("/api/students", "POST", {"name": "历史核对示例"})
        backup = self.request("/api/backup")
        backup["courses"] = [dict(id="historical", student_id=student["id"], date=None, start_time="18:00", subject="英语", duration_minutes=120,
                                   actual_minutes=None, hourly_rate_cents=None, status="completed", source="示例.xlsx / B2", needs_review=True)]
        backup["reviews"] = [dict(id="missing", student_id=student["id"], course_id="historical", kind="missing_course_fields", source="示例.xlsx / B2")]
        self.request("/api/restore", "POST", {"backup": backup})
        course = self.request("/api/courses/historical", "PATCH", {"actual_minutes": 120, "hourly_rate_cents": 15000, "needs_review": False})
        self.assertIsNone(course["fee_cents"])
        self.assertEqual(self.request("/api/state")["reviews"][0]["status"], "pending")
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/reviews/missing", "PATCH", {"status": "resolved", "resolution": "已确认时长单价"})
        self.assertEqual(caught.exception.code, 400)
        with caught.exception as response:
            self.assertIn("日期", json.load(response)["error"])
        with self.assertRaises(HTTPError) as caught:
            self.request(f"/api/students/{student['id']}/reconcile", "POST", {"balance_cents": 0, "note": "原账核对"})
        with caught.exception as response:
            self.assertIn("核对", json.load(response)["error"])
        self.request("/api/courses/historical", "PATCH", {"date": "2024-08-05", "needs_review": False})
        self.assertEqual(self.request("/api/state")["reviews"][0]["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
