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


if __name__ == "__main__":
    unittest.main()
