import test from 'node:test';
import assert from 'node:assert/strict';
import {monday,addDays,statsFor,esc,money,hours,accountEntries} from './utils.js';

test('周一边界与跨月日期按本地日历处理',()=>{
  assert.equal(monday('2026-09-06'),'2026-08-31');
  assert.equal(monday('2026-09-07'),'2026-09-07');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
});
test('课时课费实收分开，未知费用不作确定课费，余额调整不作收入',()=>{
 const data={courses:[
 {student_id:'s1',status:'completed',date:'2026-09-07',actual_minutes:120,fee_cents:30000,needs_review:false},
 {student_id:'s1',status:'completed',date:'2026-09-08',actual_minutes:null,fee_cents:null,needs_review:true},
 {student_id:'s1',status:'cancelled',date:'2026-09-09',actual_minutes:120,fee_cents:0},
 {student_id:'s2',status:'completed',date:'2026-09-08',actual_minutes:60,fee_cents:10000}],payments:[
 {student_id:'s1',date:'2026-09-07',kind:'payment',amount_cents:50000},
 {student_id:'s1',date:'2026-09-08',kind:'refund',amount_cents:-5000},
 {student_id:'s1',date:'2026-09-09',kind:'adjustment',amount_cents:2000},
 {student_id:'s1',date:'2026-08-31',kind:'payment',amount_cents:100000}]};
 const actual=statsFor(data,'2026-09-01','2026-09-30','s1');
 assert.equal(actual.minutes,120);assert.equal(actual.fee,30000);
 assert.equal(actual.received,45000);assert.equal(actual.adjusted,2000);assert.equal(actual.unknown,1);
});
test('未知值明确显示待核对，来源文本转义',()=>{
 assert.equal(money(null),'待核对');assert.equal(hours(null),'待核对');
 assert.equal(esc('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
});

test('账户流水按日期累计扣费和缴费，缺日期时不编造逐笔余额',()=>{
 const data={payments:[{id:'p',student_id:'s',date:'2026-09-01',kind:'payment',amount_cents:100000},{id:'r',student_id:'s',date:'2026-09-04',kind:'refund',amount_cents:-10000}],courses:[{id:'c',student_id:'s',date:'2026-09-02',status:'completed',fee_cents:30000,start_time:'09:00'}]};
 const ledger=accountEntries(data,'s');
 assert.deepEqual(ledger.dated.map(e=>e.id),['p','c','r']);assert.deepEqual(ledger.dated.map(e=>e.balance),[100000,70000,60000]);
 data.payments.push({id:'unknown',student_id:'s',date:null,kind:'payment',amount_cents:5000});
 const incomplete=accountEntries(data,'s');assert.equal(incomplete.undated.length,1);assert.ok(incomplete.dated.every(e=>e.balance===null));
});
