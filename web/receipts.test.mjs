import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPaymentReceipt as buildReceipt} from './receipts.js';

const buildPaymentReceipt = (payment, student, courses = []) => buildReceipt(payment, student, courses, '2026-09-08');

const student = (extra = {}) => ({id:'fictional-student', name:'虚构小溪', balance_cents:60000, balance_verified:true, rates:{数学:10000}, ...extra});
const payment = (extra = {}) => ({id:'fictional-payment', student_id:'fictional-student', kind:'payment', amount_cents:40000, date:'2026-09-08', ...extra});
const course = (extra = {}) => ({id:'fictional-course', student_id:'fictional-student', status:'scheduled', subject:'数学', date:'2026-09-09', duration_minutes:90, ...extra});

test('回执使用本次金额和保存后余额，按明确科目时长估算且不改变输入', () => {
  const p=payment({notes:'内部备注', source:'内部来源'}), s=student({notes:'学生内部记录'}), courses=[course()];
  const before=structuredClone({p,s,courses});
  const text=buildPaymentReceipt(p,s,courses);
  assert.match(text,/收到缴费：¥400\.00/);
  assert.match(text,/缴费日期：2026-09-08/);
  assert.match(text,/当前余额：¥600\.00/);
  assert.match(text,/按数学每节 1\.5 小时估算，当前余额约可上 4 节/);
  assert.doesNotMatch(text,/内部/);
  assert.deepEqual({p,s,courses},before);
});

test('已核实欠费与未核实账面余额不折算节数', () => {
  const debt=buildPaymentReceipt(payment(),student({balance_cents:-2000}),[course()]);
  assert.match(debt,/当前欠费：¥20\.00/);
  assert.doesNotMatch(debt,/约可上|当前余额/);
  for (const balance of [60000,-2000]) {
    const text=buildPaymentReceipt(payment(),student({balance_verified:false,balance_cents:balance}),[course()]);
    assert.match(text,/账面金额，待核对/);
    assert.match(text,balance < 0 ? /当前欠费：¥20\.00/ : /当前余额：¥600\.00/);
    assert.doesNotMatch(text,/约可上/);
  }
});

test('零价、未知价和未明确科目的多价学生仅显示金额', () => {
  for (const rates of [{数学:0},{数学:null},{数学:10000,物理:12000}]) {
    const text=buildPaymentReceipt(payment(),student({rates}),[]);
    assert.match(text,/当前余额：¥600\.00/);
    assert.doesNotMatch(text,/约可上|每节|Infinity|NaN/);
  }
});

test('多科按下一次明确课程折算，不拿其他学生或已完成课程推算', () => {
  const text=buildPaymentReceipt(payment(),student({rates:{数学:10000,物理:12000}}),[
    course({student_id:'someone-else', date:'2026-09-08', duration_minutes:60}),
    course({status:'completed', date:'2026-09-08', duration_minutes:60}),
    course({subject:'物理', duration_minutes:120})]);
  assert.match(text,/按物理每节 2 小时估算，当前余额约可上 2.5 节/);
});

test('退款、调整、历史收款核对不冒充新缴费，金额未知或学生不匹配不生成回执', () => {
  for (const kind of ['refund','adjustment','receipt_correction']) assert.equal(buildPaymentReceipt(payment({kind}),student()),'');
  for (const amount_cents of [0,-100,null,1.2]) assert.equal(buildPaymentReceipt(payment({amount_cents}),student()),'');
  assert.equal(buildPaymentReceipt(payment(),student({id:'another'})),'');
});

test('余额未知不伪造金额，缺日期保留待核对提示', () => {
  const unknown=buildPaymentReceipt(payment(),student({balance_cents:null}),[course()]);
  assert.match(unknown,/当前余额：待核对/);
  assert.doesNotMatch(unknown,/约可上/);
  const undated=buildPaymentReceipt(payment({date:null}),student(),[course()]);
  assert.match(undated,/缴费日期：待核对/);
});

test('补录以前缴费时仍按当前未来排课折算', () => {
  const text=buildPaymentReceipt(payment({date:'2026-08-01'}),student(),[
    course({date:'2026-08-02',duration_minutes:60}),course({date:'2026-09-09',duration_minutes:120})]);
  assert.match(text,/缴费日期：2026-08-01/);
  assert.match(text,/每节 2 小时估算，当前余额约可上 3 节/);
  assert.match(text,/余额截至：2026-09-08/);
});

test('历史回执标记推测日期，但不泄露完整核对依据或内部备注', () => {
  const text=buildPaymentReceipt(payment({date:'2026-07-01',notes:'内部备注\n【推测日期】earliest=2026-06-01，源文件核对依据'}),student(),[course()]);
  assert.match(text,/缴费日期：2026-07-01（推测日期）/);
  assert.match(text,/余额截至：2026-09-08/);
  assert.doesNotMatch(text,/内部备注|earliest|源文件核对依据/);
  assert.match(text,/当前余额：¥600\.00/);
});

test('日期缺失或无效时即便备注有推测依据也不编造日期', () => {
  for (const date of [null,'','2026-02-30','not-a-date']) {
    const text=buildPaymentReceipt(payment({date,notes:'【推测日期】可能在暑假'}),student());
    assert.match(text,/缴费日期：待核对/);
    assert.doesNotMatch(text,/可能在暑假|缴费日期：.*推测日期/);
  }
});
