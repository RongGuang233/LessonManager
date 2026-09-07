"""LessonManager: 本机课表和课费账本，仅依赖 Python 标准库。"""
from __future__ import annotations

import argparse
import errno
import datetime as dt
import json
import os
import signal
from pathlib import Path
import sqlite3
import threading
import uuid
from decimal import Decimal, ROUND_HALF_UP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from urllib.request import urlopen
import webbrowser
from contextlib import closing, contextmanager

VERSION = "1.2.0"
ROOT = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = Path.home() / "Library" / "Application Support" / "LessonManager"
TABLES = ("students", "courses", "payments", "reviews", "periods")
FIELDS = {
    "students": ("id", "name", "status", "grade", "notes", "rates", "balance_verified"),
    "courses": ("id", "student_id", "subject", "date", "start_time", "duration_minutes", "actual_minutes", "hourly_rate_cents", "status", "notes", "series_id", "source", "needs_review"),
    "payments": ("id", "student_id", "date", "kind", "amount_cents", "notes", "source"),
    "reviews": ("id", "student_id", "course_id", "kind", "message", "source", "status", "resolution"),
    "periods": ("id", "name", "start", "end"),
}


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def today():
    return dt.date.today().isoformat()


def stamp():
    return dt.datetime.now().isoformat(timespec="seconds")


def new_id():
    return str(uuid.uuid4())


def require_date(value, optional=False):
    if optional and value in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(value).isoformat()
    except (TypeError, ValueError):
        raise AppError("日期格式不正确")


def integer(value, label, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise AppError(f"{label}必须是整数")
    result = int(value)
    if minimum is not None and result < minimum:
        raise AppError(f"{label}不能小于{minimum}")
    return result


def fee(course):
    if course["status"] != "completed":
        return 0
    if course["hourly_rate_cents"] is None or course["actual_minutes"] is None or course["needs_review"]:
        return None
    return int((Decimal(course["hourly_rate_cents"]) * Decimal(course["actual_minutes"]) / 60).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def missing_course_fields(course):
    missing = []
    for field, label in (("date", "日期"), ("start_time", "开始时间")):
        if not course[field]:
            missing.append(label)
    if str(course["subject"] or "").strip() in ("", "待确认"):
        missing.append("科目")
    if course["status"] == "completed":
        for field, label in (("actual_minutes", "实际时长"), ("hourly_rate_cents", "历史单价")):
            if course[field] is None:
                missing.append(label)
    return missing


def account_balance(courses, payments, settlement=None):
    closed_courses = set(settlement["course_ids"]) if settlement else set()
    closed_payments = set(settlement["payment_ids"]) if settlement else set()
    return (settlement["balance_cents"] if settlement else 0) + sum(
        p["amount_cents"] for p in payments if p["id"] not in closed_payments
    ) - sum(fee(c) or 0 for c in courses if c["id"] not in closed_courses)


def normalize_record(table, raw, historical=False):
    if not isinstance(raw, dict):
        raise AppError("数据记录必须是对象")
    record = {key: raw.get(key) for key in FIELDS[table]}
    record["id"] = str(record["id"] or new_id())
    for key in ("notes", "source", "resolution", "grade"):
        if key in record:
            record[key] = str(record[key] or "")
    if table == "students":
        record["name"] = str(record["name"] or "").strip()
        if not record["name"]:
            raise AppError("请填写学生姓名")
        record["status"] = record["status"] or "active"
        if record["status"] not in ("active", "paused", "archived"):
            raise AppError("学生状态不正确")
        rates = record["rates"] or {}
        if not isinstance(rates, dict):
            raise AppError("科目单价格式不正确")
        record["rates"] = {str(k): None if v is None else integer(v, "单价（分）", 0) for k, v in rates.items()}
        record["balance_verified"] = bool(record["balance_verified"])
    elif table == "courses":
        record["subject"] = str(record["subject"] or "待确认")
        record["date"] = require_date(record["date"], optional=historical)
        if record["start_time"]:
            try:
                parsed = dt.time.fromisoformat(record["start_time"])
                if parsed.second or parsed.microsecond:
                    raise ValueError()
                record["start_time"] = parsed.strftime("%H:%M")
            except (TypeError, ValueError):
                raise AppError("开始时间格式不正确")
        else:
            record["start_time"] = None
            if not historical:
                raise AppError("请选择开始时间")
        record["duration_minutes"] = integer(record["duration_minutes"] or 120, "预计时长", 1)
        if record["actual_minutes"] is not None:
            record["actual_minutes"] = integer(record["actual_minutes"], "实际时长", 1)
        if not historical and (record["duration_minutes"] % 60 or (record["actual_minutes"] or 0) % 60):
            raise AppError("新课程按正整数小时登记")
        if record["hourly_rate_cents"] is not None:
            record["hourly_rate_cents"] = integer(record["hourly_rate_cents"], "小时单价（分）", 0)
        record["status"] = record["status"] or "scheduled"
        if record["status"] not in ("scheduled", "completed", "cancelled"):
            raise AppError("课程状态不正确")
        record["series_id"] = record["series_id"] or None
        record["needs_review"] = bool(record["needs_review"])
    elif table == "payments":
        record["date"] = require_date(record["date"], optional=historical)
        record["kind"] = record["kind"] or "payment"
        if record["kind"] not in ("payment", "refund", "adjustment"):
            raise AppError("款项类型不正确")
        record["amount_cents"] = integer(record["amount_cents"], "金额（分）")
        if record["kind"] == "refund":
            record["amount_cents"] = -abs(record["amount_cents"])
        if record["kind"] == "payment" and record["amount_cents"] <= 0:
            raise AppError("缴费金额应大于零")
    elif table == "reviews":
        record["student_id"] = record["student_id"] or None
        record["course_id"] = record["course_id"] or None
        record["kind"] = str(record["kind"] or "历史记录")
        record["message"] = str(record["message"] or "")
        record["status"] = record["status"] or "pending"
        if record["status"] not in ("pending", "resolved"):
            raise AppError("核对状态不正确")
    else:
        record["name"] = str(record["name"] or "").strip()
        record["start"] = require_date(record["start"])
        record["end"] = require_date(record["end"])
        if not record["name"] or record["end"] < record["start"]:
            raise AppError("请填写名称，结束日期不能早于开始日期")
    return record


class Store:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).expanduser().resolve()
        if self.data_dir == ROOT or ROOT in self.data_dir.parents:
            raise AppError("真实数据目录必须位于代码仓库之外")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / "lessonmanager.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as conn:
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise AppError("此数据库版本较新，请使用对应版本程序")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS students (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, grade TEXT NOT NULL,
                    notes TEXT NOT NULL, rates TEXT NOT NULL, balance_verified INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS courses (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), subject TEXT NOT NULL,
                    date TEXT, start_time TEXT, duration_minutes INTEGER NOT NULL, actual_minutes INTEGER,
                    hourly_rate_cents INTEGER, status TEXT NOT NULL, notes TEXT NOT NULL, series_id TEXT,
                    source TEXT NOT NULL, needs_review INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS payments (
                    id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id), date TEXT,
                    kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, notes TEXT NOT NULL, source TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS reviews (
                    id TEXT PRIMARY KEY, student_id TEXT REFERENCES students(id), course_id TEXT REFERENCES courses(id),
                    kind TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, resolution TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS periods (id TEXT PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS courses_student_date ON courses(student_id,date);
                CREATE INDEX IF NOT EXISTS courses_series ON courses(series_id,date);
                PRAGMA user_version=1;
            """)
        self.backup_database(daily=True)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @staticmethod
    def decode(row):
        record = dict(row)
        if "rates" in record:
            record["rates"] = json.loads(record["rates"])
        for key in ("balance_verified", "needs_review"):
            if key in record:
                record[key] = bool(record[key])
        return record

    def find(self, conn, table, record_id):
        row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (record_id,)).fetchone()
        if row is None:
            raise AppError("记录不存在，请刷新后重试", 404)
        return self.decode(row)

    @staticmethod
    def write(conn, table, record, replace=False):
        values = [json.dumps(record[k], ensure_ascii=False) if k == "rates" else record[k] for k in FIELDS[table]]
        if replace:
            keys = FIELDS[table][1:]
            conn.execute(f"UPDATE {table} SET " + ",".join(f"{k}=?" for k in keys) + " WHERE id=?", values[1:] + values[:1])
        else:
            conn.execute(f"INSERT INTO {table} ({','.join(FIELDS[table])}) VALUES ({','.join('?' for _ in values)})", values)

    def raw(self, conn):
        result = {table: [self.decode(row) for row in conn.execute(f"SELECT * FROM {table}")] for table in TABLES}
        result["meta"] = {r["key"]: json.loads(r["value"]) for r in conn.execute("SELECT * FROM meta")}
        result["schema_version"] = 1
        return result

    def payment_for_review(self, conn, review):
        if review["course_id"] or not review["source"]:
            raise AppError("此核对事项缺少明确款项关联，请先核实原始来源")
        payments = conn.execute("SELECT * FROM payments WHERE student_id=? AND source=?", (review["student_id"], review["source"])).fetchall()
        if len(payments) != 1:
            raise AppError("无法唯一确定此事项对应的缴费或退款，请先核实原始来源")
        return self.decode(payments[0])

    @staticmethod
    def set_meta(conn, key, value):
        conn.execute("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value, ensure_ascii=False)))

    @staticmethod
    def settlements(conn):
        row = conn.execute("SELECT value FROM meta WHERE key='account_settlements'").fetchone()
        return json.loads(row[0]) if row else {}

    def state(self):
        with self.connect() as conn:
            conn.execute("BEGIN")
            data = self.raw(conn)
        data["meta"].update(data_dir=str(self.data_dir), app_version=VERSION)
        for course in data["courses"]:
            course["fee_cents"] = fee(course)
            course["conflict"] = False
        groups = {}
        for c in data["courses"]:
            if c["status"] != "cancelled" and c["date"] and c["start_time"]:
                groups.setdefault(c["date"], []).append(c)
        for items in groups.values():
            items.sort(key=lambda c: c["start_time"])
            for i, a in enumerate(items):
                start_a = int(a["start_time"][:2]) * 60 + int(a["start_time"][3:])
                end_a = start_a + (a["actual_minutes"] if a["status"] == "completed" and a["actual_minutes"] else a["duration_minutes"])
                for b in items[i + 1:]:
                    start_b = int(b["start_time"][:2]) * 60 + int(b["start_time"][3:])
                    if start_b >= end_a:
                        break
                    a["conflict"] = b["conflict"] = True
        for student in data["students"]:
            courses = [c for c in data["courses"] if c["student_id"] == student["id"]]
            payments = [p for p in data["payments"] if p["student_id"] == student["id"]]
            student["paid_cents"] = sum(p["amount_cents"] for p in payments)
            student["charged_cents"] = sum(c["fee_cents"] or 0 for c in courses)
            student["settlement"] = data["meta"].get("account_settlements", {}).get(student["id"])
            student["balance_cents"] = account_balance(courses, payments, student["settlement"])
            student["completed_minutes"] = sum(c["actual_minutes"] or 0 for c in courses if c["status"] == "completed")
            student["pending_count"] = sum(r["status"] == "pending" and r["student_id"] == student["id"] for r in data["reviews"])
        return data

    def backup_database(self, daily=False):
        with self.lock:
            folder = self.data_dir / "backups"
            folder.mkdir(exist_ok=True)
            suffix = today() if daily else dt.datetime.now().strftime("%Y-%m-%d_%H%M%S_%f")
            target = folder / f"lessonmanager_{suffix}.sqlite3"
            if target.exists():
                return target
            with self.connect() as source, closing(sqlite3.connect(target)) as dest:
                source.backup(dest)
            with self.connect() as conn:
                self.set_meta(conn, "last_backup_at", stamp())
            for old in sorted(folder.glob("lessonmanager_*.sqlite3"), key=lambda p: p.stat().st_mtime, reverse=True)[30:]:
                old.unlink()
            return target

    def export(self):
        with self.lock:
            self.backup_database()
            with self.connect() as conn:
                conn.execute("BEGIN")
                return self.raw(conn)

    def validate_backup(self, doc):
        if not isinstance(doc, dict) or doc.get("schema_version") != 1:
            raise AppError("请选择 LessonManager v1 JSON 备份")
        clean = {}
        for table in TABLES:
            if not isinstance(doc.get(table), list):
                raise AppError(f"备份缺少 {table} 数据")
            clean[table] = [normalize_record(table, r, historical=True) for r in doc[table]]
            if len({r["id"] for r in clean[table]}) != len(clean[table]):
                raise AppError("备份含重复记录编号")
        students = {r["id"] for r in clean["students"]}
        courses = {r["id"] for r in clean["courses"]}
        for table in ("courses", "payments", "reviews"):
            for row in clean[table]:
                if row["student_id"] is not None and row["student_id"] not in students:
                    raise AppError("备份中的学生关联不完整")
                if table != "reviews" and row["student_id"] is None:
                    raise AppError("课程或缴费缺少学生")
                if table == "reviews" and row["course_id"] and row["course_id"] not in courses:
                    raise AppError("备份中的课程关联不完整")
        clean["meta"] = doc.get("meta", {})
        if not isinstance(clean["meta"], dict):
            raise AppError("备份设置格式不正确")
        settlements = clean["meta"].get("account_settlements", {})
        if not isinstance(settlements, dict):
            raise AppError("备份中的旧账结清记录格式不正确")
        for sid, settlement in settlements.items():
            if sid not in students or not isinstance(settlement, dict):
                raise AppError("旧账结清记录缺少对应学生")
            require_date(settlement.get("confirmed_on"))
            integer(settlement.get("balance_cents"), "已确认余额（分）")
            if not isinstance(settlement.get("note"), str) or not settlement["note"].strip():
                raise AppError("历史余额核对必须记录确认依据")
            for table, key in (("courses", "course_ids"), ("payments", "payment_ids")):
                ids = settlement.get(key)
                if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
                    raise AppError("旧账结清的明细编号格式不正确")
                owned = {r["id"] for r in clean[table] if r["student_id"] == sid}
                if not set(ids) <= owned:
                    raise AppError("旧账结清的明细关联不完整")
        return clean

    def restore(self, doc, initial=False):
        clean = self.validate_backup(doc)
        with self.lock:
            self.backup_database()
            with self.connect() as conn:
                if not initial:
                    for table in ("reviews", "payments", "courses", "students", "periods", "meta"):
                        conn.execute(f"DELETE FROM {table}")
                for table in TABLES:
                    for record in clean[table]:
                        if initial and conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (record["id"],)).fetchone():
                            continue
                        self.write(conn, table, record)
                for key, value in clean["meta"].items():
                    if key not in ("data_dir", "app_version"):
                        if initial and key == "account_settlements":
                            value = {**value, **self.settlements(conn)}
                        self.set_meta(conn, key, value)
                self.set_meta(conn, "last_backup_at", stamp())
        return {"ok": True}

    def mutate(self, method, path, body):
        if path == "/api/restore" and method == "POST":
            return self.restore(body.get("backup"))
        parts = path.strip("/").split("/")
        if len(parts) < 2 or parts[0] != "api" or parts[1] not in TABLES:
            raise AppError("接口不存在", 404)
        table = parts[1]
        with self.lock, self.connect() as conn:
            if table == "courses" and len(parts) == 3 and parts[2] == "copy-week" and method == "POST":
                target = dt.date.fromisoformat(require_date(body.get("week_start")))
                target -= dt.timedelta(days=target.weekday())
                previous = target - dt.timedelta(days=7)
                rows = [self.decode(r) for r in conn.execute("SELECT * FROM courses WHERE date>=? AND date<? AND status!='cancelled'", (previous.isoformat(), target.isoformat()))]
                created, skipped = [], 0
                for c in rows:
                    if not c["start_time"] or c["duration_minutes"] % 60:
                        skipped += 1
                        continue
                    date = (dt.date.fromisoformat(c["date"]) + dt.timedelta(days=7)).isoformat()
                    if conn.execute("SELECT 1 FROM courses WHERE student_id=? AND subject=? AND date=? AND start_time=?", (c["student_id"], c["subject"], date, c["start_time"])).fetchone():
                        skipped += 1
                        continue
                    c.update(id=new_id(), date=date, status="scheduled", actual_minutes=None, hourly_rate_cents=None, source="", needs_review=False, series_id=None)
                    self.write(conn, "courses", c)
                    created.append(c["id"])
                return {"created": created, "skipped": skipped}
            if len(parts) == 4 and table == "students" and parts[3] == "settle-history" and method == "POST":
                student = self.find(conn, "students", parts[2])
                settlements = self.settlements(conn)
                if student["id"] in settlements:
                    return settlements[student["id"]]
                note = str(body.get("note") or "").strip()
                if not note:
                    raise AppError("请记录已知历史结余的核对依据")
                settlement = {"confirmed_on": today(), "balance_cents": integer(body.get("balance_cents", 0), "已确认余额（分）"), "note": note}
                for scope_table, key in (("courses", "course_ids"), ("payments", "payment_ids")):
                    ids = body.get(key)
                    if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
                        raise AppError("请选择本次结清的历史明细")
                    for record_id in ids:
                        record = self.find(conn, scope_table, record_id)
                        if record["student_id"] != student["id"]:
                            raise AppError("结清明细必须属于该学生")
                        if record["date"] and record["date"] > today() or scope_table == "courses" and record["status"] == "scheduled":
                            raise AppError("未来记录和待上课程不能纳入历史结清")
                    settlement[key] = ids
                settlements[student["id"]] = settlement
                self.set_meta(conn, "account_settlements", settlements)
                student["balance_verified"] = True
                self.write(conn, "students", student, replace=True)
                return settlement
            if len(parts) == 4 and table == "students" and parts[3] == "reconcile" and method == "POST":
                student = self.find(conn, "students", parts[2])
                target = integer(body.get("balance_cents"), "余额（分）")
                notes = str(body.get("note") or "").strip()
                if not notes:
                    raise AppError("请记录余额核对依据")
                courses = [self.decode(r) for r in conn.execute("SELECT * FROM courses WHERE student_id=?", (student["id"],))]
                settlement = self.settlements(conn).get(student["id"])
                closed = set(settlement["course_ids"]) if settlement else set()
                if any(fee(c) is None for c in courses if c["id"] not in closed):
                    raise AppError("请先补齐已上课程的时长、单价并完成课程核对，再确认余额")
                payments = [self.decode(r) for r in conn.execute("SELECT * FROM payments WHERE student_id=?", (student["id"],))]
                current = account_balance(courses, payments, settlement)
                adjustment = normalize_record("payments", {"student_id": student["id"], "date": today(), "kind": "adjustment", "amount_cents": target - current, "notes": "余额核对：" + notes})
                self.write(conn, "payments", adjustment)
                student["balance_verified"] = True
                self.write(conn, "students", student, replace=True)
                return student
            if len(parts) == 2 and method == "POST":
                if table == "reviews":
                    raise AppError("核对记录由历史导入产生")
                raw = dict(body)
                raw["id"] = new_id()
                if table == "students":
                    raw["balance_verified"] = True
                if table == "courses":
                    raw.update(status="scheduled", source="", needs_review=False, actual_minutes=None)
                if table == "payments":
                    raw["source"] = ""
                record = normalize_record(table, raw)
                if table in ("courses", "payments"):
                    self.find(conn, "students", record["student_id"])
                if table == "courses":
                    start = dt.date.fromisoformat(record["date"])
                    until = dt.date.fromisoformat(require_date(body.get("repeat_until"))) if body.get("repeat_until") else start
                    if until < start or (until - start).days > 366:
                        raise AppError("重复课截止日期需在开始日期后一年内")
                    series = new_id() if until > start else None
                    ids = []
                    while start <= until:
                        c = dict(record, id=new_id(), date=start.isoformat(), series_id=series)
                        self.write(conn, table, c)
                        ids.append(c["id"])
                        start += dt.timedelta(days=7)
                    return {"created": ids}
                self.write(conn, table, record)
                return record
            if len(parts) != 3:
                raise AppError("接口不存在", 404)
            old = self.find(conn, table, parts[2])
            settlement = self.settlements(conn).get(old.get("student_id"))
            settled = settlement and old["id"] in settlement.get("course_ids" if table == "courses" else "payment_ids" if table == "payments" else "", [])
            if method == "DELETE":
                if table not in ("courses", "payments", "periods"):
                    raise AppError("此记录不能删除")
                if table == "courses" and (old["status"] != "scheduled" or old["source"]):
                    raise AppError("已上或历史课程请通过更正状态保留记录")
                if settled:
                    raise AppError("已结清的历史明细请更正信息，保留原记录")
                conn.execute(f"DELETE FROM {table} WHERE id=?", (old["id"],))
                return {"ok": True}
            if method != "PATCH":
                raise AppError("不支持此操作", 405)
            allowed = set(FIELDS[table]) - {"id", "source", "series_id", "balance_verified"}
            if table == "reviews":
                allowed = {"status", "resolution"}
            raw = dict(old)
            raw.update({k: v for k, v in body.items() if k in allowed})
            if settled and raw["student_id"] != old["student_id"]:
                raise AppError("已结清的历史明细不能改到其他学生账户")
            if table == "courses":
                self.find(conn, "students", raw["student_id"])
                if raw["status"] == "completed" and not old["source"]:
                    if raw["actual_minutes"] is None:
                        raw["actual_minutes"] = raw["duration_minutes"]
                    if raw["hourly_rate_cents"] is None:
                        student = self.find(conn, "students", raw["student_id"])
                        raw["hourly_rate_cents"] = student["rates"].get(raw["subject"])
                    if raw["hourly_rate_cents"] is None:
                        raise AppError("请先设置该科小时单价")
                elif raw["status"] == "completed" and not raw["needs_review"]:
                    if raw["actual_minutes"] is None or raw["hourly_rate_cents"] is None:
                        raise AppError("请明确填写历史课程的实际时长和当时单价后完成核对")
            if table == "reviews" and raw["status"] == "resolved" and not str(raw["resolution"] or "").strip():
                raise AppError("请填写核对结果")
            historical = bool(old.get("source")) or (table == "payments" and old["date"] is None)
            record = normalize_record(table, raw, historical=historical)
            if table == "reviews" and record["status"] == "resolved":
                if record["course_id"]:
                    course = self.find(conn, "courses", record["course_id"])
                    missing = missing_course_fields(course)
                    if missing:
                        raise AppError("关联课程仍缺少" + "、".join(missing) + "，请先在课程编辑中补齐，再完成核对")
                if record["kind"] == "payment_date_missing" and not self.payment_for_review(conn, record)["date"]:
                    raise AppError("关联缴费或退款仍缺少日期，请先补填实际发生日期")
            if table == "payments" and "review_ids" in body:
                review_ids = body["review_ids"]
                if not isinstance(review_ids, list) or any(not isinstance(item, str) for item in review_ids):
                    raise AppError("请选择要完成核对的事项")
                for review_id in review_ids:
                    review = self.find(conn, "reviews", review_id)
                    if review["kind"] != "payment_date_missing" or self.payment_for_review(conn, review)["id"] != record["id"]:
                        raise AppError("所选核对事项与此缴费或退款的原始来源不一致")
                    if not record["date"]:
                        raise AppError("请先补填实际发生日期，再完成缴费日期核对")
                    conn.execute("UPDATE reviews SET status='resolved',resolution='已在款项编辑中补填实际发生日期' WHERE id=?", (review_id,))
            if table == "courses" and body.get("scope") == "following":
                if old["status"] != "scheduled" or not old["series_id"] or not old["date"]:
                    raise AppError("只能批量调整固定周课中尚未上课的课程")
                shift = (dt.date.fromisoformat(record["date"]) - dt.date.fromisoformat(old["date"])).days
                rows = conn.execute("SELECT * FROM courses WHERE series_id=? AND date>=? AND status='scheduled'", (old["series_id"], old["date"])).fetchall()
                for row in rows:
                    c = self.decode(row)
                    c["date"] = (dt.date.fromisoformat(c["date"]) + dt.timedelta(days=shift)).isoformat()
                    for key in ("start_time", "duration_minutes", "notes"):
                        if key in body:
                            c[key] = record[key]
                    self.write(conn, table, c, replace=True)
                return record
            if table == "courses":
                if body.get("needs_review") is False:
                    missing = missing_course_fields(record)
                    reviews = conn.execute("SELECT * FROM reviews WHERE course_id=? AND status='pending'", (record["id"],)).fetchall()
                    for review in reviews:
                        kind = review["kind"]
                        resolved = (kind in ("missing_course_fields", "legacy_incomplete") and not missing
                                    or kind == "zero_rate" and record["hourly_rate_cents"] is not None
                                    or kind in ("time_typo", "merged_lesson") and record["actual_minutes"] is not None)
                        if resolved:
                            conn.execute("UPDATE reviews SET status='resolved',resolution='已在课程编辑中核对对应字段' WHERE id=?", (review["id"],))
                    pending = conn.execute("SELECT 1 FROM reviews WHERE course_id=? AND status='pending'", (record["id"],)).fetchone()
                    record["needs_review"] = bool(missing or pending)
            self.write(conn, table, record, replace=True)
            if table == "courses":
                record["fee_cents"] = fee(record)
            elif table == "reviews" and record["course_id"]:
                course = self.find(conn, "courses", record["course_id"])
                pending = conn.execute("SELECT 1 FROM reviews WHERE course_id=? AND status='pending'", (course["id"],)).fetchone()
                course["needs_review"] = bool(pending or missing_course_fields(course))
                self.write(conn, "courses", course, replace=True)
            return record


def make_handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # 不在终端打印姓名、请求内容或业务数据。

        def send_json(self, value, status=200, download=False):
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="LessonManager-backup-{today()}.json"')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlparse(self.path).path
            try:
                if path == "/api/health":
                    return self.send_json({"app": "LessonManager", "version": VERSION})
                if path == "/api/state":
                    return self.send_json(store.state())
                if path == "/api/backup":
                    return self.send_json(store.export(), download=True)
                if path.startswith("/api/"):
                    raise AppError("接口不存在", 404)
                file = (ROOT / "web" / (path.lstrip("/") or "index.html")).resolve()
                if ROOT / "web" not in file.parents or not file.is_file():
                    raise AppError("页面不存在", 404)
                content = file.read_bytes()
                mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}.get(file.suffix, "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", mime + "; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(content)
            except AppError as exc:
                self.send_json({"error": str(exc)}, exc.status)

        def change(self):
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 20_000_000:
                    raise AppError("文件过大，请选择本系统 JSON 备份")
                if not self.headers.get("Content-Type", "").startswith("application/json"):
                    raise AppError("请求格式必须是 JSON")
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise AppError("请求内容必须是对象")
                result = store.mutate(self.command, urlparse(self.path).path, body)
                self.send_json(result)
            except AppError as exc:
                self.send_json({"error": str(exc)}, exc.status)
            except (ValueError, TypeError, KeyError):
                self.send_json({"error": "输入内容不完整或格式不正确"}, 400)
            except sqlite3.IntegrityError:
                self.send_json({"error": "记录关联不完整，请刷新后重试"}, 409)
            except sqlite3.Error:
                self.send_json({"error": "本地数据库暂时无法写入，请稍后重试"}, 503)

        do_POST = change
        do_PATCH = change
        do_DELETE = change
    return Handler


def main():
    parser = argparse.ArgumentParser(description="LessonManager Mac 本地课时管理")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("LESSONMANAGER_DATA_DIR", DEFAULT_DATA_DIR)))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="打开浏览器")
    parser.add_argument("--import", dest="import_file", type=Path, help="将本地导入器结果写入数据库；已有同ID记录保留")
    parser.add_argument("--import-only", action="store_true")
    args = parser.parse_args()
    store = Store(args.data_dir)
    if args.import_file:
        store.restore(json.loads(args.import_file.read_text(encoding="utf-8")), initial=True)
        print("历史数据已载入；重复编号保留数据库现有记录。")
    if args.import_only:
        return
    url = f"http://127.0.0.1:{args.port}"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store))
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE:
            raise SystemExit(f"无法启动本地服务：{exc}")
        try:
            with urlopen(url + "/api/health", timeout=2) as response:
                existing = json.load(response)
            if existing.get("app") == "LessonManager":
                print(f"LessonManager 已在运行：{url}")
                if args.open:
                    webbrowser.open(url)
                return
        except Exception:
            pass
        raise SystemExit(f"端口 {args.port} 已被占用，请使用 --port 指定其他端口。")
    print(f"LessonManager 已启动：{url}\n数据保存在本机，关闭此窗口即可停止。")
    def stop(_signum, _frame):
        raise KeyboardInterrupt
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, stop)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.backup_database()


if __name__ == "__main__":
    main()
