import json
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
