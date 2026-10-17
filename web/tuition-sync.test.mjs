import test from 'node:test';
import assert from 'node:assert/strict';
import {newTuitionKey, publicationMessage} from './tuition-sync.js';

test('pairing uses all 32 random bytes', () => {
  const key = newTuitionKey({getRandomValues(bytes) { bytes.set(Array.from({length:32}, (_,i)=>i));return bytes;}});
  assert.equal(Buffer.from(key,'base64').length,32);
  assert.equal(Buffer.from(key,'base64')[31],31);
});
test('publication explains unverified balances and next manual step', () => {
  assert.match(publicationMessage({students:3,unverified:1,statusSaved:true}),/1 位仍待核对/);
  assert.match(publicationMessage({students:3,unverified:0,statusSaved:false}),/未能保存/);
  assert.match(publicationMessage({students:3}),/刷新学费余额/);
});
