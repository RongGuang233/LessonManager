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
  assert.match(result.text,/本期退款：¥50\.00/);
  assert.match(result.text,/本期调整：¥20\.00/);
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
  assert.match(result.text,/待核对金额未计入合计/);
  assert.doesNotMatch(result.text,/本期收款：¥0\.00/);
  assert.match(result.text,/2 笔日期待核对记录未计入本期合计/);
});

test('已核实标志也不能覆盖未知日期或未知费用，区间外未知流水有提示', () => {
  for (const entry of [payment('u',null,10000),payment('u','2026-10-01',null)]) {
    const state=base();state.payments=[entry];
    const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
    assert.equal(result.summary.balanceReliable,false);
    assert.equal(result.summary.closingCents,null);
    assert.match(result.text,/期初、期末余额暂无法确定/);
    assert.equal(result.summary.currentBalanceCents,entry.amount_cents == null ? null : entry.amount_cents);
  }
});

test('目标学生隔离，HTML转义，无脚本、外部资源或学生私密档案', () => {
  const state=base();state.students[0].name='<img src=x onerror=alert(1)> & "小林"';state.students[0].notes='档案内部备注';
  state.payments=[payment('other','2026-09-01',777777,'payment','s2')];
  state.courses=[course('own','2026-09-01',{subject:'<数学>',notes:'<script>alert("x")</script>'}),course('othercourse','2026-09-01',{student_id:'s2',notes:'另一学生秘密'})];
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.equal(result.entries.length,1);
  assert.doesNotMatch(JSON.stringify(result),/另一学生秘密|另一位学生|档案内部备注|777777/);
  assert.doesNotMatch(result.text+result.html,/alert\("x"\)|&lt;script&gt;/);
  assert.match(result.html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(result.html,/<script|<img|<link|<iframe|https?:\/\//i);
  assert.match(result.html,/@page\{size:A4/);
  assert.match(result.html,/thead\{display:table-header-group\}/);
});

test('空区间与参数验证，失效记录日期进入待核对段', () => {
  const state=base();
  const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
  assert.equal(result.summary.closingCents,0);
  assert.match(result.text,/本期无已完成课程或收付款记录/);
  assert.throws(()=>buildStatement(state,'missing','2026-09-01','2026-09-30'),/选择学生/);
  assert.throws(()=>buildStatement(state,'s1','2026-09-30','2026-09-01'),/有效/);
  assert.throws(()=>buildStatement(state,'s1','2026-02-30','2026-09-01'),/有效/);
  state.payments=[payment('bad','2026-02-30',10000)];
  assert.equal(buildStatement(state,'s1','2026-09-01','2026-09-30').undated.length,1);
});

const settledState = () => {
 const state=base();
 state.students[0].balance_verified=false;
 state.students[0].settlement={confirmed_on:'2026-09-08',balance_cents:0,note:'虚构历史结清',course_ids:['old','old-same-day'],payment_ids:['oldpay']};
 state.courses=[course('old',null,{fee_cents:null,actual_minutes:null,needs_review:true}),course('old-same-day','2026-09-08',{fee_cents:12000}),course('new','2026-09-09',{fee_cents:20000})];
 state.payments=[payment('oldpay','2026-09-01',10000),payment('newpay','2026-09-10',25000)];
 return state;
};

test('结清后新账从零核算，旧未知不阻塞，同日历史金额不再次扣费',()=>{
 const state=settledState(),before=structuredClone(state);
 const result=buildStatement(state,'s1','2026-09-08','2026-09-30');
 assert.equal(result.summary.balanceReliable,true);
 assert.equal(result.summary.openingCents,0);
 assert.equal(result.summary.closingCents,5000);
 assert.equal(result.summary.feeCents,32000);
 assert.equal(result.summary.paymentCents,25000);
 assert.equal(result.summary.netReceivedCents,25000);
 assert.equal(result.summary.adjustmentCents,0);
 assert.deepEqual(result.entries.map(e=>[e.id,e.balance]),[['old-same-day',null],['settlement:s1',0],['new',-20000],['newpay',5000]]);
 assert.equal(result.undated[0].settled,true);
 assert.equal(result.undated[0].amount,null);
 assert.match(result.text,/已计入结余/);
 assert.match(result.text,/2026-09-08 确认结余/);
 assert.doesNotMatch(result.html,/不是新增缴费|虚构历史结清/);
 assert.match(result.html,/不重复影响当前余额/);
 const later=buildStatement(state,'s1','2026-09-10','2026-09-30');
 assert.equal(later.summary.openingCents,-20000);
 assert.equal(later.summary.closingCents,5000);
 assert.deepEqual(state,before);
});

test('结清前及跨结清日范围仍无确定历史期初期末，不回填未知金额',()=>{
 const state=settledState();
 for(const end of ['2026-09-07','2026-09-30']) {
   const result=buildStatement(state,'s1','2026-09-01',end);
   assert.equal(result.summary.openingCents,null);
   assert.equal(result.summary.closingCents,null);
   assert.equal(result.summary.paymentCents,end==='2026-09-07'?10000:35000);
   assert.ok(result.entries.filter(e=>e.type!=='settlement').every(e=>e.balance===null));
   assert.match(result.text,/2026-09-08 确认结余/);
   assert.equal(result.undated[0].amount,null);
 }
});

test('结清后新增反向补录、未知日期或金额使期间结余不确定',()=>{
 for(const row of [payment('backdated','2026-09-07',1000),payment('undated',null,1000),payment('unknown','2026-09-09',null)]) {
   const state=settledState();state.payments.push(row);
   const result=buildStatement(state,'s1','2026-09-08','2026-09-30');
   assert.equal(result.summary.balanceReliable,false);
   assert.equal(result.summary.closingCents,null);
   assert.ok(result.entries.filter(e=>e.type!=='settlement').every(e=>e.balance===null));
   assert.equal(result.entries.find(e=>e.type==='settlement').balance,0);
 }
});

test('其他学生结清范围及未知账不影响目标学生',()=>{
 const state=settledState();
 state.payments.push(payment('own','2026-09-09',5000,'payment','s2'));
 const result=buildStatement(state,'s2','2026-09-08','2026-09-30');
 assert.equal(result.settlement,null);
 assert.equal(result.summary.closingCents,5000);
 assert.doesNotMatch(result.text,/虚构历史结清|历史账目于/);
});

test('正4000和负900历史结余支持新扣费及缴费且不计作现金或调整',()=>{
 for(const balance of [400000,-90000]) {
   const state=settledState();state.students[0].settlement.balance_cents=balance;
   state.students[0].settlement.note='虚构余额依据';
   const result=buildStatement(state,'s1','2026-09-08','2026-09-30');
   assert.equal(result.summary.openingCents,balance);
   assert.equal(result.summary.closingCents,balance+5000);
   assert.equal(result.summary.recordedOpeningCents,balance);
   assert.equal(result.summary.recordedClosingCents,balance+5000);
   assert.deepEqual(result.entries.map(e=>e.balance),[null,balance,balance-20000,balance+5000]);
   assert.equal(result.entries[1].amount,0);
   assert.equal(result.entries[1].label,'历史余额结转');
   assert.equal(result.summary.paymentCents,25000);
   assert.equal(result.summary.netReceivedCents,25000);
   assert.equal(result.summary.refundCents,0);
   assert.equal(result.summary.adjustmentCents,0);
   assert.doesNotMatch(result.text+result.html,/结清|零结余|结余为零/);
   assert.match(result.text,/不重复影响当前余额/);
   const later=buildStatement(state,'s1','2026-09-10','2026-09-30');
   assert.equal(later.summary.openingCents,balance-20000);
   assert.equal(later.summary.closingCents,balance+5000);
   const historical=buildStatement(state,'s1','2026-09-01','2026-09-30');
   assert.equal(historical.summary.openingCents,null);
   assert.equal(historical.summary.closingCents,null);
   assert.match(historical.text,/当前(?:余额|欠费)/);
   assert.match(historical.text,/期初、期末余额暂无法确定/);
 }
});


test('家长版突出当前余额和本期三项，零退款及调整隐藏，内部备注不输出',()=>{
 const state=base();
 state.payments=[{...payment('p','2026-09-02',480000),notes:'老师内部收款备注',source:'原始来源私密'}];
 state.courses=[course('c','2026-09-03',{notes:'课程内部长备注',source:'原始课程核对依据'})];
 const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
 assert.equal(result.summary.currentBalanceCents,464998);
 assert.match(result.text,/当前余额：¥4,649\.98/);
 assert.match(result.text,/本期收款：¥4,800\.00/);
 assert.match(result.text,/本期上课：1 次 · 1\.5 小时/);
 assert.match(result.text,/本期扣费：¥150\.02/);
 assert.doesNotMatch(result.text+result.html,/本期退款|本期调整|本笔后结余|统计说明|老师内部收款备注|原始来源私密|课程内部长备注|原始课程核对依据|含推测日期/);
});

test('meta旧账范围与新收款分别统计，日期早于确认日仍展示已确认当前4800',()=>{
 const state=base();state.students[0].balance_verified=false;
 state.meta={account_settlements:{s1:{confirmed_on:'2026-09-08',balance_cents:0,course_ids:['old'],payment_ids:['oldpay'],note:'老师原始核对依据'}}};
 state.courses=[course('old',null,{fee_cents:null,needs_review:true})];
 state.payments=[payment('oldpay','2026-08-01',20000),payment('newpay','2026-09-02',480000)];
 const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
 assert.equal(result.summary.currentBalanceCents,480000);
 assert.equal(result.summary.balanceReliable,false);
 assert.equal(result.summary.openingCents,null);
 assert.equal(result.summary.closingCents,null);
 assert.equal(result.summary.paymentCents,480000);
 assert.equal(result.undated[0].amount,null);
 assert.match(result.text,/当前余额：¥4,800\.00/);
 assert.match(result.text,/本期收款：¥4,800\.00/);
 assert.doesNotMatch(result.text+result.html,/期初结余|期末结余|本笔后结余|老师原始核对依据|含推测日期|日期待核对记录/);
});

test('新账未知金额不能显示精确当前余额或零退款、零调整',()=>{
 const state=settledState();
 state.payments.push(payment('unknown-refund','2026-09-09',null,'refund'),payment('unknown-adjustment','2026-09-09',null,'adjustment'));
 const result=buildStatement(state,'s1','2026-09-08','2026-09-30');
 assert.equal(result.summary.currentBalanceCents,null);
 assert.match(result.text,/当前余额：待核对/);
 assert.match(result.text,/本期退款：1 笔金额待核对/);
 assert.match(result.text,/本期调整：1 笔金额待核对/);
 assert.doesNotMatch(result.text,/本期退款：¥0|本期调整：¥0|当前余额：¥|期初结余|期末结余/);
});

test('正负历史收款核对计入净收款，保留原缴费退款含义及展示符号',()=>{
 for(const [correction, displayed, net] of [[2000,'+¥20.00','¥470.00'],[-2000,'-¥20.00','¥430.00']]) {
   const state=base();
   state.payments=[payment('paid','2026-09-01',50000),payment('returned','2026-09-02',-5000,'refund'),payment('adjusted','2026-09-03',3000,'adjustment'),payment('checked','2026-09-04',correction,'receipt_correction')];
   const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
   assert.equal(result.summary.paymentCents,50000);
   assert.equal(result.summary.refundCents,5000);
   assert.equal(result.summary.adjustmentCents,3000);
   assert.equal(result.summary.receiptCorrectionCents,correction);
   assert.equal(result.summary.unknownReceiptCorrectionAmounts,0);
   assert.equal(result.summary.netReceivedCents,45000+correction);
   assert.equal(result.entries.find(e=>e.id==='checked').label,'历史收款核对');
   assert.ok(result.text.includes(`历史收款核对：${displayed}`));
   assert.ok(result.text.includes(`历史收款核对 ${displayed}`));
   assert.ok(result.html.includes(`<strong>${displayed}</strong>`));
   assert.ok(result.text.includes(`核对后净收款：${net}`));
   assert.match(result.text,/本期原缴费：¥500\.00/);
   assert.match(result.text,/本期退款：¥50\.00/);
   assert.match(result.text,/不代表本期新增收款/);
 }
});

test('未知历史收款核对保持未知，净收款只汇总已知金额并提示',()=>{
 const state=base();
 state.payments=[payment('paid','2026-09-01',10000),payment('known','2026-09-02',-2000,'receipt_correction'),payment('unknown','2026-09-03',null,'receipt_correction')];
 const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
 assert.equal(result.summary.receiptCorrectionCents,-2000);
 assert.equal(result.summary.unknownReceiptCorrectionAmounts,1);
 assert.equal(result.summary.netReceivedCents,8000);
 assert.equal(result.summary.currentBalanceCents,null);
 assert.equal(result.entries.find(e=>e.id==='unknown').amount,null);
 assert.match(result.text,/历史收款核对：已知 -¥20\.00，另有 1 笔金额待核对/);
 assert.match(result.text,/核对后净收款：已知 ¥80\.00，另有 1 笔金额待核对/);
 assert.match(result.text,/待核对金额未计入合计/);
 state.payments=[payment('unknown-only','2026-09-03',null,'receipt_correction')];
 const onlyUnknown=buildStatement(state,'s1','2026-09-01','2026-09-30');
 assert.match(onlyUnknown.text,/历史收款核对：1 笔金额待核对/);
 assert.match(onlyUnknown.text,/核对后净收款：1 笔金额待核对/);
});

test('已结转正负核对不改变确认余额及新账，历史范围仍统计收款差额',()=>{
 for(const balance of [60000,-8000]) {
   const state=settledState();
   state.students[0].settlement.balance_cents=balance;
   state.students[0].settlement.payment_ids.push('corrected-before','corrected-same-day','corrected-undated');
   state.payments.push(payment('corrected-before','2026-09-02',3000,'receipt_correction'),payment('corrected-same-day','2026-09-08',-1000,'receipt_correction'),payment('corrected-undated',null,null,'receipt_correction'));
   const before=structuredClone(state);
   const current=buildStatement(state,'s1','2026-09-08','2026-09-30');
   assert.equal(current.summary.currentBalanceCents,balance+5000);
   assert.equal(current.summary.openingCents,balance);
   assert.equal(current.summary.closingCents,balance+5000);
   assert.equal(current.summary.receiptCorrectionCents,-1000);
   assert.equal(current.summary.netReceivedCents,24000);
   assert.equal(current.entries.find(e=>e.id==='corrected-same-day').balance,null);
   assert.equal(current.entries.find(e=>e.id==='corrected-same-day').settled,true);
   assert.doesNotMatch(current.text,/日期待核对记录/);
   const later=buildStatement(state,'s1','2026-09-10','2026-09-30');
   assert.equal(later.summary.openingCents,balance-20000);
   assert.equal(later.summary.closingCents,balance+5000);
   assert.equal(later.summary.receiptCorrectionCents,0);
   assert.equal(later.summary.netReceivedCents,25000);
   assert.doesNotMatch(later.text,/历史收款核对|核对后净收款/);
   const historical=buildStatement(state,'s1','2026-09-01','2026-09-30');
   assert.equal(historical.summary.receiptCorrectionCents,2000);
   assert.equal(historical.summary.paymentCents,35000);
   assert.equal(historical.summary.netReceivedCents,37000);
   assert.equal(historical.summary.currentBalanceCents,balance+5000);
   assert.equal(historical.summary.closingCents,null);
   assert.deepEqual(state,before);
 }
});

test('正负核对相抵为零保留逐笔符号，汇总不显示多余零差额',()=>{
 const state=base();
 state.payments=[payment('plus','2026-09-01',1000,'receipt_correction'),payment('minus','2026-09-02',-1000,'receipt_correction')];
 const result=buildStatement(state,'s1','2026-09-01','2026-09-30');
 assert.equal(result.summary.receiptCorrectionCents,0);
 assert.equal(result.summary.netReceivedCents,0);
 assert.match(result.text,/历史收款核对 \+¥10\.00/);
 assert.match(result.text,/历史收款核对 -¥10\.00/);
 assert.doesNotMatch(result.text,/历史收款核对：/);
 assert.match(result.text,/核对后净收款：¥0\.00/);
});
