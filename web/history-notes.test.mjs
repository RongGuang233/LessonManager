import test from 'node:test';
import assert from 'node:assert/strict';
import {splitHistoryNotes} from './history-notes.js';

test('拆分推测日期标记后的完整核对依据，普通备注仍显示', () => {
  const notes = '微信收款，暑期课程\n【推测日期】依据首末课日期，earliest=2026-07-01\nlatest=2026-08-01；待后续核对';
  const split = splitHistoryNotes(notes);
  assert.equal(split.note, '微信收款，暑期课程');
  assert.equal(split.evidence, '【推测日期】依据首末课日期，earliest=2026-07-01\nlatest=2026-08-01；待后续核对');
  assert.equal(split.inferred, true);
  assert.equal(`${split.note}\n${split.evidence}`, notes);
});

test('仅有核对依据时不制造备注，重复标记完整保留', () => {
  const notes = '【日期推测】第一条\n【推测日期】后续核对';
  assert.deepEqual(splitHistoryNotes(notes), {note:'', evidence:notes, inferred:true});
});

test('空备注和普通文字不误标为日期推测', () => {
  for (const notes of [null, undefined, '']) assert.deepEqual(splitHistoryNotes(notes), {note:'',evidence:'',inferred:false});
  const notes = '家长确认实际日期，不用推测日期。';
  assert.deepEqual(splitHistoryNotes(notes), {note:notes,evidence:'',inferred:false});
});
