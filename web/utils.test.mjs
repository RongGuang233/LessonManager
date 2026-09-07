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

test('历史结清保留未知明细，新课程扣费与补缴从零累计，按学生隔离',()=>{
 const settlement={confirmed_on:'2026-09-08',balance_cents:0,note:'虚构测试结清',course_ids:['old'],payment_ids:['oldpay']};
 const state={students:[{id:'s',settlement},{id:'other'}],payments:[{id:'oldpay',student_id:'s',date:null,kind:'payment',amount_cents:null},{id:'newpay',student_id:'s',date:'2026-09-10',kind:'payment',amount_cents:25000}],courses:[{id:'old',student_id:'s',status:'completed',date:'2026-09-01',fee_cents:null,needs_review:true},{id:'new',student_id:'s',status:'completed',date:'2026-09-09',fee_cents:20000},{id:'other',student_id:'other',status:'completed',date:'2026-09-09',fee_cents:1000}]};
 const ledger=accountEntries(state,'s');
 assert.equal(ledger.uncertain,false);
 assert.deepEqual(ledger.dated.map(e=>[e.id,e.balance,e.settled]),[['old',null,true],['settlement:s',0,false],['new',-20000,false],['newpay',5000,false]]);
 assert.equal(ledger.undated[0].settled,true);
 assert.equal(ledger.undated[0].balance,null);
 assert.deepEqual(accountEntries(state,'other').dated.map(e=>[e.id,e.balance]),[['other',-1000]]);
 for(const date of ['2026-09-07',null,'2026-02-30']) {
   const copy=structuredClone(state);copy.payments.push({id:'new-uncertain',student_id:'s',date,kind:'payment',amount_cents:1000});
   const uncertain=accountEntries(copy,'s');
   assert.equal(uncertain.uncertain,true);
   assert.ok(uncertain.dated.filter(e=>e.type!=='settlement').every(e=>e.balance===null));
 }
});

test('正负历史余额结转只作为起点，不制造现金流水',()=>{
 for(const balance of [400000,-90000]) {
   const settlement={confirmed_on:'2026-09-08',balance_cents:balance,note:'虚构余额依据',course_ids:['old'],payment_ids:[]};
   const state={students:[{id:'s',settlement}],courses:[{id:'old',student_id:'s',status:'completed',date:null,fee_cents:null},{id:'new',student_id:'s',status:'completed',date:'2026-09-09',fee_cents:20000}],payments:[{id:'pay',student_id:'s',kind:'payment',date:'2026-09-10',amount_cents:30000}]};
   const ledger=accountEntries(state,'s');
   assert.deepEqual(ledger.dated.map(e=>e.balance),[balance,balance-20000,balance+10000]);
   assert.equal(ledger.dated[0].amount,0);
   assert.match(ledger.dated[0].notes,/确认历史余额结转/);
   assert.doesNotMatch(ledger.dated[0].notes,/结清|结余为零/);
 }
});

test('历史收款核对差额计入净收款，正负保留，按学生和日期筛选',()=>{
 const state={courses:[],payments:[
  {id:'p',student_id:'s',date:'2025-08-01',kind:'payment',amount_cents:10000},
  {id:'r',student_id:'s',date:'2025-08-01',kind:'refund',amount_cents:-2000},
  {id:'c1',student_id:'s',date:'2025-08-02',kind:'receipt_correction',amount_cents:7000},
  {id:'c2',student_id:'s',date:'2025-08-03',kind:'receipt_correction',amount_cents:-1000},
  {id:'a',student_id:'s',date:'2025-08-03',kind:'adjustment',amount_cents:500},
  {id:'other',student_id:'other',date:'2025-08-03',kind:'receipt_correction',amount_cents:9000},
  {id:'later',student_id:'s',date:'2025-09-03',kind:'receipt_correction',amount_cents:4000},
 ]};
 const result=statsFor(state,'2025-08-01','2025-08-31','s');
 assert.equal(result.received,14000);assert.equal(result.receiptCorrection,6000);assert.equal(result.adjusted,500);
 assert.equal(accountEntries(state,'s').dated.find(e=>e.id==='c2').amount,-1000);
});

test('全部区间跨学期且包含无日期记录，仍排除未上课程并保留学生筛选',()=>{
 const state={courses:[
  {student_id:'s',status:'completed',date:'2024-01-01',actual_minutes:60,fee_cents:0},
  {student_id:'s',status:'completed',date:'2026-09-01',actual_minutes:120,fee_cents:30000},
  {student_id:'s',status:'completed',date:null,actual_minutes:60,fee_cents:10000},
  {student_id:'s',status:'scheduled',date:'2026-09-15',actual_minutes:120,fee_cents:30000},
  {student_id:'s',status:'cancelled',date:'2026-09-16',actual_minutes:120,fee_cents:30000},
  {student_id:'other',status:'completed',date:'2025-01-01',actual_minutes:60,fee_cents:50000},
 ],payments:[
  {student_id:'s',date:'2024-01-01',kind:'payment',amount_cents:20000},
  {student_id:'s',date:null,kind:'receipt_correction',amount_cents:10000},
  {student_id:'s',date:'2026-09-01',kind:'refund',amount_cents:-1000},
  {student_id:'s',date:null,kind:'adjustment',amount_cents:500},
 ]};
 const all=statsFor(state,'','','s');
 assert.equal(all.courses.length,3);assert.equal(all.minutes,240);assert.equal(all.fee,40000);
 assert.equal(all.received,29000);assert.equal(all.adjusted,500);
 assert.equal(all.undatedCourses,1);assert.equal(all.undatedPayments,2);
 assert.equal(statsFor(state,'2026-09-01','2026-09-30','s').received,-1000);
 assert.equal(statsFor(state,'','').fee,90000);
 assert.equal(statsFor({courses:[],payments:[]},'','').received,0);
});
