import base64
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from lessonmanager import Store
from tuition_sync import AAD, Publisher, SyncError, decode_key, encrypt, summary, upload


class MemoryCredentials:
    def __init__(self):
        self.value = {}
    def load(self):
        return copy.deepcopy(self.value)
    def save(self, value):
        self.value = copy.deepcopy(value)


class TuitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name)
        self.credentials = MemoryCredentials()
        self.sent = []
        self.publisher = Publisher(self.store, self.credentials,
            lambda *args: self.sent.append(args), lambda: '2026-10-17T06:00:00.000000Z')
        self.config = {'endpoint':'https://example.invalid/tuition','uploadToken':'test-upload-token',
                       'key':base64.b64encode(bytes(range(32))).decode()}

    def test_minimal_summary_uses_current_settlement_balance(self):
        student = self.store.mutate('POST','/api/students',{'name':'示例','rates':{'数学':10000}})
        self.store.mutate('POST','/api/payments',{'student_id':student['id'],'amount_cents':20000,'date':'2026-10-17'})
        course = self.store.mutate('POST','/api/courses',{'student_id':student['id'],'subject':'数学','date':'2026-10-17','start_time':'10:00','duration_minutes':120})['created'][0]
        self.store.mutate('PATCH','/api/courses/'+course,{'status':'completed','actual_minutes':60})
        state = self.store.state()
        before = self.store.export()
        payload = summary(state,'2026-10-17T06:00:00Z')
        self.assertEqual(payload['students'][0]['balanceCents'],10000)
        self.assertEqual(set(payload['students'][0]),{'id','name','status','balanceCents','verified'})
        self.assertNotIn('notes',json.dumps(payload))
        self.assertEqual(before['students'],self.store.export()['students'])

    def test_covered_historical_issues_do_not_invalidate_current_balance(self):
        state={'students':[{'id':'s','name':'示例','status':'archived','balance_verified':True,'balance_cents':999,
                           'settlement':{'course_ids':['old']}}],
               'courses':[{'id':'old','student_id':'s','status':'completed','fee_cents':None,'needs_review':True}],
               'reviews':[{'status':'pending','course_id':'old'}]}
        self.assertTrue(summary(state,'now')['students'][0]['verified'])
        state['courses'][0]['id']='new'
        self.assertFalse(summary(state,'now')['students'][0]['verified'])
        state['courses'][0].update(fee_cents=100,needs_review=False)
        state['reviews'][0]['course_id']='new'
        self.assertFalse(summary(state,'now')['students'][0]['verified'])
        state['courses'][0]['status']='scheduled'
        self.assertTrue(summary(state,'now')['students'][0]['verified'])
        state['students'][0]['balance_verified']=False
        self.assertFalse(summary(state,'now')['students'][0]['verified'])

    def test_fixed_cross_platform_vector_and_tampering(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.exceptions import InvalidTag
        vector=json.loads((Path(__file__).parent/'fixtures/tuition-vector.json').read_text())
        key=decode_key(vector['key']); env=vector['envelope']
        nonce=base64.b64decode(env['nonce']);cipher=base64.b64decode(env['ciphertext'])
        self.assertEqual(json.loads(encrypt(vector['plaintext'],key,nonce)),env)
        self.assertEqual(json.loads(AESGCM(key).decrypt(nonce,cipher,AAD)),vector['plaintext'])
        with self.assertRaises(InvalidTag):
            AESGCM(key).decrypt(nonce,cipher[:-1]+bytes([cipher[-1]^1]),AAD)
        self.assertNotEqual(encrypt(vector['plaintext'],key),encrypt(vector['plaintext'],key))

    def test_configuration_keeps_secrets_out_of_status_and_backup(self):
        status=self.publisher.configure(self.config)
        self.assertTrue(status['configured'])
        self.assertNotIn('key',status)
        self.assertNotIn('uploadToken',status)
        self.publisher.configure({'endpoint':self.config['endpoint'],'key':'','uploadToken':''})
        self.assertEqual(self.credentials.value['key'],self.config['key'])
        self.assertEqual(self.publisher.pairing(),{'endpoint':self.config['endpoint'],'key':self.config['key']})
        backup=json.dumps(self.store.export())
        self.assertNotIn(self.config['key'],backup)
        self.assertNotIn(self.config['uploadToken'],backup)
        for url in ('http://example.invalid/tuition','https://name:pass@example.invalid/tuition','https://example.invalid/tuition?key=secret'):
            with self.assertRaises(SyncError):
                self.publisher.configure({**self.config,'endpoint':url})

    def test_publish_failure_does_not_update_last_success(self):
        self.publisher.configure(self.config)
        before=self.store.state()
        self.publisher.uploader=lambda *args: (_ for _ in ()).throw(SyncError('失败'))
        with self.assertRaises(SyncError):
            self.publisher.publish()
        self.assertIsNone(self.publisher.status()['lastPublishedAt'])
        self.assertEqual(before,self.store.state())
        self.publisher.uploader=lambda *args:self.sent.append(args)
        result=self.publisher.publish()
        self.assertTrue(result['statusSaved'])
        self.assertEqual(self.publisher.status()['lastPublishedAt'],result['publishedAt'])
        self.assertEqual(len(self.sent),1)
        with self.assertRaises(SyncError):
            self.publisher.publish()  # Same/older source clock must not overwrite.
        self.assertEqual(len(self.sent),1)

    def test_concurrent_publish_is_rejected_without_upload(self):
        self.publisher.configure(self.config)
        self.publisher.lock.acquire()
        try:
            with self.assertRaises(SyncError):self.publisher.publish()
            self.assertFalse(self.sent)
        finally:self.publisher.lock.release()

    def local_upload_server(self, statuses):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                requests.append((self.path, self.headers.get('Authorization'), body))
                status = statuses.pop(0) if statuses else 500
                self.send_response(status)
                if status == 302:
                    self.send_header('Location', '/redirected')
                self.send_header('Content-Length', '0')
                self.end_headers()

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.addCleanup(close)
        # Only the in-memory test credential bypasses production's HTTPS config rule.
        self.publisher.configure(self.config)
        self.credentials.value['endpoint'] = f'http://127.0.0.1:{server.server_port}/tuition'
        self.publisher.uploader = upload
        return requests

    def test_dav_creation_and_replacement_confirm_publication_over_http(self):
        requests = self.local_upload_server([201, 204])
        times = iter(['2026-10-17T06:00:00.000000Z', '2026-10-17T06:01:00.000000Z'])
        self.publisher.clock = lambda: next(times)
        for expected in ('2026-10-17T06:00:00.000000Z', '2026-10-17T06:01:00.000000Z'):
            result = self.publisher.publish()
            self.assertEqual(result['publishedAt'], expected)
            self.assertEqual(self.publisher.status()['lastPublishedAt'], expected)
        self.assertEqual(len(requests), 2)
        for path, auth, body in requests:
            self.assertEqual(path, '/tuition')
            self.assertEqual(auth, 'Bearer ' + self.config['uploadToken'])
            self.assertEqual(set(json.loads(body)), {'version', 'nonce', 'ciphertext'})

    def test_http_failures_preserve_last_success_without_retry_or_redirect(self):
        statuses = [401, 403, 413, 500, 200, 302]
        requests = self.local_upload_server(statuses.copy())
        previous = '2026-10-17T05:00:00.000000Z'
        self.credentials.value['lastPublishedAt'] = previous
        before = self.store.state()
        for index, status in enumerate(statuses, 1):
            with self.subTest(status=status):
                with self.assertRaises(SyncError):
                    self.publisher.publish()
                self.assertEqual(self.publisher.status()['lastPublishedAt'], previous)
                self.assertEqual(len(requests), index)
                self.assertEqual(requests[-1][0], '/tuition')
        self.assertEqual(before, self.store.state())

    def test_network_errors_do_not_leak_tokens_or_retry(self):
        for error in (URLError('secret-token'),HTTPError(self.config['endpoint'],401,'secret-token',{},None)):
            with patch('tuition_sync.build_opener') as opener:
                opener.return_value.open.side_effect=error
                with self.assertRaises(SyncError) as caught:upload(self.config['endpoint'],'secret-token',b'{}')
                self.assertNotIn('secret-token',str(caught.exception))
                self.assertEqual(opener.return_value.open.call_count,1)


if __name__=='__main__':unittest.main()
