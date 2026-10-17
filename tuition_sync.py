"""Optional, manual tuition publishing. No lesson data or credentials on the relay."""
from __future__ import annotations

import base64
import ctypes
import datetime as dt
import json
import os
import sys
import threading
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError

AAD = b"RenewBoard tuition v1"
MAX_BYTES = 2_000_000


class SyncError(Exception):
    pass


def decode_key(value):
    try:
        key = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise SyncError("加密密钥必须是 Base64 格式的 32 字节密钥") from None
    if len(key) != 32:
        raise SyncError("加密密钥必须是 Base64 格式的 32 字节密钥")
    return key


def summary(state, published_at):
    students = []
    for student in state["students"]:
        covered = set((student.get("settlement") or {}).get("course_ids", []))
        current = [c for c in state["courses"] if c["student_id"] == student["id"]
                   and c["status"] == "completed" and c["id"] not in covered]
        current_ids = {c["id"] for c in current}
        verified = bool(student["balance_verified"]) and all(
            c.get("fee_cents") is not None and not c.get("needs_review") for c in current)
        verified = verified and not any(r["status"] == "pending" and r.get("course_id") in current_ids
                                        for r in state["reviews"])
        students.append({"id": student["id"], "name": student["name"], "status": student["status"],
                         "balanceCents": student["balance_cents"], "verified": verified})
    return {"version": 1, "publishedAt": published_at, "students": students}


def encrypt(document, key, nonce=None):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise SyncError("请先按学费同步说明安装 requirements-sync.txt 中的可选加密依赖") from None
    nonce = os.urandom(12) if nonce is None else nonce
    raw = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, raw, AAD)
    envelope = {"version": 1, "nonce": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(ciphertext).decode()}
    body = json.dumps(envelope, separators=(",", ":")).encode()
    if len(body) > MAX_BYTES:
        raise SyncError("学费摘要超过 2 MB，未上传")
    return body


class MacKeychain:
    """One generic-password item per local ledger. Never passes secrets via argv."""
    def __init__(self, account):
        self.account = str(account).encode()
        self.service = b"cn.lessonmanager.tuition-sync"

    def _api(self):
        if sys.platform != "darwin":
            raise SyncError("学费同步凭据存储目前需要 macOS 钥匙串")
        lib = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        ptr, uint = ctypes.c_void_p, ctypes.c_uint32
        lib.SecKeychainFindGenericPassword.argtypes = [ptr, uint, ctypes.c_char_p, uint, ctypes.c_char_p,
                                                      ctypes.POINTER(uint), ctypes.POINTER(ptr), ctypes.POINTER(ptr)]
        lib.SecKeychainAddGenericPassword.argtypes = [ptr, uint, ctypes.c_char_p, uint, ctypes.c_char_p,
                                                     uint, ctypes.c_void_p, ctypes.POINTER(ptr)]
        lib.SecKeychainItemModifyAttributesAndData.argtypes = [ptr, ptr, uint, ptr]
        lib.SecKeychainItemFreeContent.argtypes = [ptr, ptr]
        return lib

    def _find(self, lib):
        length, data, item = ctypes.c_uint32(), ctypes.c_void_p(), ctypes.c_void_p()
        result = lib.SecKeychainFindGenericPassword(None, len(self.service), self.service,
            len(self.account), self.account, ctypes.byref(length), ctypes.byref(data), ctypes.byref(item))
        if result == -25300:
            return None, None
        if result != 0:
            raise SyncError("无法读取 macOS 钥匙串，请解锁钥匙串并允许课时簿访问")
        try:
            value = json.loads(ctypes.string_at(data, length.value))
        except (ValueError, TypeError):
            self._release(item)
            raise SyncError("学费同步连接信息无法读取，请重新配置") from None
        finally:
            lib.SecKeychainItemFreeContent(None, data)
        return value, item

    @staticmethod
    def _release(item):
        if item:
            core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
            core.CFRelease.argtypes = [ctypes.c_void_p]
            core.CFRelease(item)

    def load(self):
        value, item = self._find(self._api())
        self._release(item)
        return value or {}

    def save(self, value):
        lib = self._api()
        _, item = self._find(lib)
        raw = json.dumps(value, ensure_ascii=False).encode()
        try:
            if item:
                result = lib.SecKeychainItemModifyAttributesAndData(item, None, len(raw), raw)
            else:
                result = lib.SecKeychainAddGenericPassword(None, len(self.service), self.service,
                    len(self.account), self.account, len(raw), raw, None)
            if result != 0:
                raise SyncError("连接未保存：无法写入 macOS 钥匙串")
        finally:
            self._release(item)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def upload(endpoint, token, body):
    request = Request(endpoint, data=body, method="PUT", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            if response.status not in (201, 204):
                raise SyncError("服务返回了未知结果，未确认发布成功")
    except HTTPError as exc:
        status = exc.code
        exc.close()
        if status in (401, 403):
            raise SyncError("上传认证失败，请检查上传令牌") from None
        raise SyncError("发布失败，请检查服务地址和服务状态；未自动重试") from None
    except (URLError, OSError, TimeoutError):
        raise SyncError("无法确认发布结果，请检查网络后手动重试") from None


class Publisher:
    def __init__(self, store, credentials=None, uploader=upload, clock=None):
        self.store = store
        self.credentials = credentials if credentials is not None else MacKeychain(store.data_dir)
        self.uploader = uploader
        self.clock = clock or (lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"))
        self.lock = threading.Lock()

    def status(self):
        config = self.credentials.load()
        return {"configured": bool(config.get("key")), "endpoint": config.get("endpoint", ""),
                "lastPublishedAt": config.get("lastPublishedAt")}

    def configure(self, body):
        with self.lock:
            previous = self.credentials.load()
            config = {key: str(body.get(key) or previous.get(key, "")).strip()
                      for key in ("endpoint", "uploadToken", "key")}
            parts = urlsplit(config["endpoint"])
            if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.fragment or parts.query:
                raise SyncError("请填写完整 HTTPS 接口地址，不含账号、查询参数或片段")
            token = config["uploadToken"]
            if not token or len(token) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
                raise SyncError("请填写有效的上传令牌")
            decode_key(config["key"])
            if all(previous.get(key) == config[key] for key in config):
                config["lastPublishedAt"] = previous.get("lastPublishedAt")
            self.credentials.save(config)
        return self.status()

    def pairing(self):
        config = self.credentials.load()
        if not config.get("key"):
            raise SyncError("请先保存学费同步连接")
        return {"endpoint": config["endpoint"], "key": config["key"]}

    def publish(self):
        if not self.lock.acquire(blocking=False):
            raise SyncError("正在发布学费余额，请等待本次完成")
        try:
            config = self.credentials.load()
            if not config.get("key"):
                raise SyncError("请先配置学费同步连接")
            published_at = self.clock()
            if config.get("lastPublishedAt") and published_at <= config["lastPublishedAt"]:
                raise SyncError("本机时间早于上次发布，请校准系统时间后重试")
            document = summary(self.store.state(), published_at)
            self.uploader(config["endpoint"], config["uploadToken"], encrypt(document, decode_key(config["key"])))
            config["lastPublishedAt"] = published_at
            try:
                self.credentials.save(config)
                saved = True
            except SyncError:
                saved = False
            return {"publishedAt": published_at, "students": len(document["students"]),
                    "unverified": sum(not s["verified"] for s in document["students"]),
                    "statusSaved": saved}
        finally:
            self.lock.release()
