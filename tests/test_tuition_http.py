import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from lessonmanager import Store, make_handler
from tuition_sync import Publisher
from test_tuition_sync import MemoryCredentials


class TuitionHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(self.tmp.name)
        self.sent=[]
        self.publisher=Publisher(self.store,MemoryCredentials(),lambda *args:self.sent.append(args))
        self.http=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.store,self.publisher))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()

    def request(self,path,body=None):
        request=Request(self.url+path,data=json.dumps(body).encode() if body is not None else None,
                        headers={'Content-Type':'application/json'})
        with urlopen(request) as response:return json.load(response)

    def test_connect_pair_publish_and_backup_boundaries(self):
        self.assertFalse(self.request('/api/tuition-sync')['configured'])
        config={'endpoint':'https://example.invalid/tuition','uploadToken':'test-token',
                'key':'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='}
        status=self.request('/api/tuition-sync',config)
        self.assertTrue(status['configured']);self.assertNotIn('key',status)
        self.assertEqual(self.request('/api/tuition-sync/pairing',{})['key'],config['key'])
        result=self.request('/api/tuition-sync/publish',{})
        self.assertEqual(result['students'],0);self.assertEqual(len(self.sent),1)
        self.assertNotIn(config['key'],json.dumps(self.request('/api/backup')))
        self.assertEqual(self.request('/api/tuition-sync')['lastPublishedAt'],result['publishedAt'])

    def test_unconfigured_error_is_json(self):
        with self.assertRaises(HTTPError) as caught:self.request('/api/tuition-sync/publish',{})
        with caught.exception as response:
            self.assertEqual(response.code,400)
            self.assertIn('先配置',json.load(response)['error'])


if __name__=='__main__':unittest.main()
