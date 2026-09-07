import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStatement} from './statement.js';

const base = () => ({students:[{id:'s1', name:'小林', balance_verified:true, balance_cents:999999, rates:{数学:99999}}, {id:'s2',name:'另一位学生',balance_verified:true}], payments:[], courses:[]});
const payment = (id,date,amount_cents,kind='payment',student_id='s1') => ({id,date,amount_cents,kind,student_id});
const course = (id,date,fields={}) => ({id,student_id:'s1',date,status:'completed',subject:'数学',start_time:'10:00',actual_minutes:90,hourly_rate_cents:10001,fee_cents:15002,needs_review:false,...fields});

test('首尾日期均包含；期初来自以前流水，期末不取当前余额或未来流水', () => {
  const state=base();
  state.payments=[payment('prior','2026-08-31',100000),payment('start','2026-09-01',10000),payment('end','2026-09-30',20000),payment('future','2026-10-01',50000)];
  state.courses=[course('previous','2026-08-30'),course('in','2026-09-01')];
  const before=structuredClone(state);
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.deepEqual(result.entries.map(e=>e.id),['start','in','end']);
  assert.equal(result.summary.openingCents,84998);
  assert.equal(result.summary.closingCents,99996);
  assert.equal(result.summary.paymentCents,30000);
  assert.equal(result.entries[1].amount,-15002);
  assert.match(result.entries[1].detail,/1.5 小时/);
  assert.match(result.entries[1].detail,/100.01/);
  assert.doesNotMatch(result.entries[1].detail,/999.99/);
  assert.deepEqual(state,before);
});

test('退款和正负余额调整分别统计，取消课程不扣费', () => {
  const state=base();
  state.payments=[payment('p','2026-09-01',50000),payment('r','2026-09-01',-5000,'refund'),payment('a','2026-09-01',3000,'adjustment'),payment('a2','2026-09-01',-1000,'adjustment')];
  state.courses=[course('done','2026-09-01'),course('cancel','2026-09-01',{status:'cancelled'})];
  const result=buildStatement(state,'s1','2026-09-01','2026-09-01');
  assert.equal(result.summary.refundCents,5000);
  assert.equal(result.summary.netReceivedCents,45000);
  assert.equal(result.summary.adjustmentCents,2000);
  assert.equal(result.summary.feeCents,15002);
  assert.equal(result.summary.closingCents,31998);
  assert.deepEqual(result.entries.map(e=>e.label),['缴费','退款','余额调整','余额调整','课程扣费']);
  assert.match(result.text,/不代表实际发生先后/);
});

test('未知费用、时长和日期保留，不纳入已知统计或编造可靠结余', () => {
  const state=base();state.students[0].balance_verified=false;
  state.payments=[payment('p','2026-08-01',100000),payment('unknown-payment','2026-09-01',null),payment('no-date',null,5000)];
  state.courses=[course('unknown','2026-09-02',{fee_cents:null,actual_minutes:null,hourly_rate_cents:null,needs_review:true}),course('undated',null),course('dated','2026-09-03')];
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.equal(result.summary.openingCents,null);
  assert.equal(result.summary.closingCents,null);
  assert.equal(result.summary.recordedOpeningCents,100000);
  assert.equal(result.summary.feeCents,15002);
  assert.equal(result.summary.knownMinutes,90);
  assert.equal(result.summary.unknownMinutes,1);
  assert.equal(result.summary.unknownFeeAmounts,1);
  assert.equal(result.summary.unknownPaymentAmounts,1);
  assert.equal(result.undated.length,2);
  assert.ok(result.entries.every(e=>e.balance===null));
  assert.equal(result.entries.find(e=>e.id==='unknown').amount,null);
  assert.match(result.entries.find(e=>e.id==='unknown').detail,/待核对 × 待核对/);
  assert.match(result.text,/未知金额未按零计算/);
  assert.match(result.text,/未纳入本期课时、缴费、退款、调整和课费统计/);
});

test('已核实标志也不能覆盖未知日期或未知费用，区间外未知流水有提示', () => {
  for (const entry of [payment('u',null,10000),payment('u','2026-10-01',null)]) {
    const state=base();state.payments=[entry];
    const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
    assert.equal(result.summary.balanceReliable,false);
    assert.equal(result.summary.closingCents,null);
    assert.match(result.text,/余额待核对/);
  }
});

test('目标学生隔离，HTML转义，无脚本、外部资源或学生私密档案', () => {
  const state=base();state.students[0].name='<img src=x onerror=alert(1)> & "小林"';state.students[0].notes='档案内部备注';
  state.payments=[payment('other','2026-09-01',777777,'payment','s2')];
  state.courses=[course('own','2026-09-01',{subject:'<数学>',notes:'<script>alert("x")</script>'}),course('othercourse','2026-09-01',{student_id:'s2',notes:'另一学生秘密'})];
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.equal(result.entries.length,1);
  assert.doesNotMatch(JSON.stringify(result),/另一学生秘密|另一位学生|档案内部备注|777777/);
  assert.match(result.html,/&lt;script&gt;/);
  assert.match(result.html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(result.html,/<script|<img|<link|<iframe|https?:\/\//i);
  assert.match(result.html,/@page\{size:A4/);
  assert.match(result.html,/thead\{display:table-header-group\}/);
});

test('空区间与参数验证，失效记录日期进入待核对段', () => {
  const state=base();
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.equal(result.summary.closingCents,0);
  assert.match(result.text,/本期无已完成课程或账户流水/);
  assert.throws(()=>buildStatement(state,'missing','2026-09-01','2026-09-30'),/选择学生/);
  assert.throws(()=>buildStatement(state,'s1','2026-09-30','2026-09-01'),/有效/);
  assert.throws(()=>buildStatement(state,'s1','2026-02-30','2026-09-01'),/有效/);
  state.payments=[payment('bad','2026-02-30',10000)];
  assert.equal(buildStatement(state,'s1','2026-09-01','2026-09-30').undated.length,1);
});
