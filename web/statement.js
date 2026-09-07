import {accountEntries, esc, money, hours} from './utils.js';

const labels = {payment:'缴费', refund:'退款', adjustment:'余额调整', course:'课程扣费', settlement:'历史余额结转'};
const integer = value => Number.isSafeInteger(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
const sum = values => values.reduce((total, value) => {
  const result = total + value;
  if (!integer(result)) throw new Error('账目合计超出可精确计算范围，请先核对记录。');
  return result;
}, 0);
const signedMoney = value => value == null ? '待核对' : `${value > 0 ? '+' : ''}${money(value)}`;

/** Inclusive calendar range. Pure: does not modify state or open a window. */
export function buildStatement(state, studentId, start, end) {
  const student = state.students.find(s => s.id === studentId);
  if (!student) throw new Error('请先选择学生。');
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('请选择有效的起止日期，开始日期不能晚于结束日期。');
  const ledger = accountEntries(state, studentId);
  const settlement = ledger.settlement;
  const afterSettlement = settlement && start >= settlement.confirmed_on;
  const all = [...ledger.dated, ...ledger.undated].map(entry => ({...entry, amount:integer(entry.amount) ? entry.amount : null}));
  const dated = all.filter(entry => validDate(entry.date));
  const undatedSource = all.filter(entry => !validDate(entry.date));
  const before = dated.filter(entry => entry.date < start);
  const within = dated.filter(entry => entry.date >= start && entry.date <= end);
  const after = dated.filter(entry => entry.date > end);
  const uncertainAmounts = all.filter(entry => entry.amount == null).length;
  const flagged = all.some(entry => entry.record.needs_review);
  const balanceReliable = settlement
    ? Boolean(afterSettlement && !ledger.uncertain)
    : student.balance_verified === true && !undatedSource.length && !uncertainAmounts && !flagged;
  const contributes = entry => entry.amount != null && (!afterSettlement || !entry.settled);
  const recordedOpeningCents = sum([afterSettlement ? settlement.balance_cents : 0, ...before.filter(contributes).map(entry => entry.amount)]);
  const recordedClosingCents = sum([recordedOpeningCents, ...within.filter(contributes).map(entry => entry.amount)]);
  const totalsFor = type => {
    const rows = within.filter(entry => entry.type === type);
    return {cents:sum(rows.filter(entry => entry.amount != null).map(entry => type === 'course' || type === 'refund' ? -entry.amount : entry.amount)), unknown:rows.filter(entry => entry.amount == null).length};
  };
  const payment = totalsFor('payment'), refund = totalsFor('refund'), adjustment = totalsFor('adjustment'), fee = totalsFor('course');
  const courses = within.filter(entry => entry.type === 'course');
  const knownMinutes = sum(courses.filter(entry => integer(entry.record.actual_minutes) && entry.record.actual_minutes >= 0).map(entry => entry.record.actual_minutes));
  const unknownMinutes = courses.filter(entry => !integer(entry.record.actual_minutes) || entry.record.actual_minutes < 0).length;
  const summary = {
    start, end, studentName:String(student.name ?? ''), balanceReliable,
    openingCents:balanceReliable ? recordedOpeningCents : null,
    closingCents:balanceReliable ? recordedClosingCents : null,
    recordedOpeningCents, recordedClosingCents,
    paymentCents:payment.cents, refundCents:refund.cents, adjustmentCents:adjustment.cents, feeCents:fee.cents,
    netReceivedCents:sum([payment.cents, -refund.cents]), knownMinutes, unknownMinutes,
    unknownPaymentAmounts:payment.unknown, unknownRefundAmounts:refund.unknown, unknownAdjustmentAmounts:adjustment.unknown, unknownFeeAmounts:fee.unknown,
    entryCount:within.length, courseCount:courses.length, undatedCount:undatedSource.length,
    beforeCount:before.length, afterCount:after.length,
  };
  const notices = [
    '本单按所选日期统计已完成课程和账户流水；待上课及已取消课程不计入。',
    '同日未记录时刻的缴费、退款与余额调整先列，课程按开始时间排列；本笔后结余按展示顺序计算，不代表实际发生先后。',
    '课费采用本次课程已记录的扣费金额；小时价采用当时记录，未使用当前价格重算。余额调整不计入缴费或退款。',
  ];
  if (settlement) notices.push(`历史账目于 ${settlement.confirmed_on} ${settlement.balance_cents === 0 ? '确认结清' : '确认历史余额结转'}，确认结余为 ${money(settlement.balance_cents)}。这是历史余额确认，不是新增缴费、退款或现金收入；原明细中未知的费用、日期和历史逐笔结余仍保持待核对。确认范围内明细继续用于所属日期的历史统计，已纳入历史余额核对，不再影响当前余额。`);
  if (balanceReliable && settlement) notices.push('期初、期末从已确认的历史结余加新流水计算；确认范围内的历史未知项不影响新账余额。同日历史余额确认先于新流水列示。');
  else if (balanceReliable) notices.push('期初为开始日期之前全部账户流水的净额；期末为期初加本期流水净额，与当前余额分别计算。');
  else if (settlement) notices.push('该区间涉及历史余额确认前的记录，或新流水存在日期、金额缺项，无法还原准确的期间及逐笔结余；这不否定已经确认的历史结余，当前余额或欠费应以账户当前状态为准。');
  else notices.push('余额待核对：账户尚未核实，或存在日期、金额、记录待核对项。本单不提供确定的期初、期末及逐笔结余；已记录合计不代表完整应收或可用余额。');
  if (before.length || after.length) notices.push(`区间外有 ${before.length} 笔区间前流水、${after.length} 笔区间后流水，未计入本期合计；区间前已知流水仅用于期初计算。`);
  if (undatedSource.length) notices.push(`有 ${undatedSource.length} 笔日期缺失或无效的记录，单独列于下方，未纳入本期课时、缴费、退款、调整和课费统计，无法判断所属期间。`);
  if (uncertainAmounts) notices.push(`该学生全部账目中有 ${uncertainAmounts} 笔金额待核对；未知金额未按零计算，所有合计仅包含已知金额。`);
  if (unknownMinutes) notices.push(`本期有 ${unknownMinutes} 节课程实际时长待核对，未计入已记录课时。`);
  if (within.some(entry => entry.record.needs_review)) notices.push('标有“记录待核对”的明细仍需核实；已知金额虽列入已记录合计，不代表已经确认。');
  const displayEntry = (entry, balance) => {
    const course = entry.type === 'course';
    const duration = integer(entry.record.actual_minutes) && entry.record.actual_minutes >= 0 ? entry.record.actual_minutes : null;
    const rate = integer(entry.record.hourly_rate_cents) && entry.record.hourly_rate_cents >= 0 ? entry.record.hourly_rate_cents : null;
    return {
      id:entry.id, date:validDate(entry.date) ? entry.date : null,
      time:course ? String(entry.time ?? '') : '', type:entry.type,
      label:entry.type === 'settlement' && settlement.balance_cents === 0 ? '旧账结清' : labels[entry.type] || '账户记录', subject:course ? String(entry.record.subject ?? '') : '',
      detail:course ? `${hours(duration)} × ${money(rate)} / 小时` : '—',
      amount:entry.amount, balance, settled:Boolean(entry.settled), needsReview:Boolean(entry.record.needs_review),
      notes:String(entry.notes ?? ''),
    };
  };
  let running = recordedOpeningCents;
  const entries = within.map(entry => {
    if (contributes(entry)) running = sum([running, entry.amount]);
    return displayEntry(entry, entry.type === 'settlement' ? settlement.balance_cents : balanceReliable && !entry.settled ? running : null);
  });
  const undated = undatedSource.map(entry => displayEntry(entry, null));
  const totalLabel = (label, total) => `${label}：${money(total.cents)}${total.unknown ? `（另有 ${total.unknown} 笔金额待核对）` : ''}`;
  const summaryLines = [
    `期初结余：${money(summary.openingCents)}`,
    `已记录课时：${hours(knownMinutes)}${unknownMinutes ? `（另有 ${unknownMinutes} 节时长待核对）` : ''}`,
    totalLabel('已记录缴费', payment), totalLabel('已记录退款', refund),
    `已记录净收款：${money(summary.netReceivedCents)}${payment.unknown + refund.unknown ? '（不含待核对金额）' : ''}`,
    totalLabel('已记录余额调整', adjustment), totalLabel('已记录课费', fee),
    `期末结余：${money(summary.closingCents)}`,
  ];
  const lineFor = entry => [entry.date || '日期待核对', entry.time, entry.label, entry.subject, entry.type === 'course' ? entry.detail : '', `${entry.type === 'settlement' ? '确认结余' : entry.settled ? '历史金额（已纳入历史余额核对，不再影响当前余额）' : '账户变动'} ${signedMoney(entry.type === 'settlement' ? entry.balance : entry.amount)}`, `本笔后结余 ${money(entry.balance)}`, entry.needsReview ? '记录待核对' : '', entry.notes].filter(Boolean).join(' · ');
  const text = [`${student.name ?? ''} · 课时与费用对账单`, `${start} 至 ${end}（含首尾日期）`, '', ...summaryLines, '', '本期明细', ...(entries.length ? entries.map(lineFor) : ['本期无已完成课程或账户流水。']), ...(undated.length ? ['', '日期待核对记录（未纳入时段统计）', ...undated.map(lineFor)] : []), '', '统计说明', ...notices].join('\n');
  const tableFor = rows => `<table><thead><tr><th>日期 / 事项</th><th>课时 × 当时单价</th><th class="number">账户变动</th><th class="number">本笔后结余</th></tr></thead><tbody>${rows.map(entry => `<tr><td>${esc(entry.date || '日期待核对')}${entry.time ? ` ${esc(entry.time)}` : ''}<strong>${esc(entry.label)}${entry.subject ? ` · ${esc(entry.subject)}` : ''}</strong>${entry.settled ? '<small>已纳入历史余额核对，不再影响当前余额</small>' : ''}${entry.needsReview ? '<small>记录待核对</small>' : ''}${entry.notes ? `<small class="notes">${esc(entry.notes)}</small>` : ''}</td><td>${esc(entry.detail)}</td><td class="number">${entry.type === 'settlement' ? '确认结余 ' : entry.settled ? '历史金额 ' : ''}${esc(signedMoney(entry.type === 'settlement' ? entry.balance : entry.amount))}</td><td class="number">${esc(money(entry.balance))}</td></tr>`).join('')}</tbody></table>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(student.name)} · 课时与费用对账单</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f5f2eb;color:#302e29;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:980px;margin:32px auto;padding:42px;background:#fffdf8}header{border-bottom:2px solid #555044;padding-bottom:22px;margin-bottom:24px}h1{font-size:27px;margin:0 0 8px;font-weight:600}h2{font-size:18px;margin:28px 0 12px}p{margin:8px 0}.range,.explain{color:#615e55}.summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 26px;padding:18px;background:#f4f1e8}.summary p{margin:0}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:12px 10px;text-align:left;border-bottom:1px solid #d9d5ca;vertical-align:top;overflow-wrap:anywhere}th{font-size:12px;color:#59554c;border-top:1px solid #a39b89}th:first-child{width:36%}th:nth-child(2){width:27%}td strong,td small{display:block}td strong{font-weight:500}small{font-size:12px;color:#686357}.number{text-align:right;font-variant-numeric:tabular-nums}.notes{white-space:pre-wrap}.explain{font-size:12px}.explain li{margin:6px 0}.empty{padding:18px;border:1px solid #d9d5ca}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}footer{margin-top:28px;border-top:1px solid #d9d5ca;padding-top:10px;font-size:12px;color:#686357}@page{size:A4;margin:15mm}@media print{body,main{background:white;color:black;font-family:"Songti SC","STSong",serif}main{margin:0;padding:0;max-width:none}.summary{background:white;border:1px solid #aaa}.range,.explain,small,th,footer{color:#333}table{font-size:11px}th,td{padding:8px 6px}h1{font-size:22px}header{padding-bottom:12px;margin-bottom:18px}}@media(max-width:600px){main{padding:20px;margin:0}.summary{grid-template-columns:1fr}th,td{padding:8px 4px;font-size:12px}}
  </style></head><body><main><header><h1>${esc(student.name)} · 课时与费用对账单</h1><p class="range">${esc(start)} 至 ${esc(end)}（含首尾日期）</p></header><section class="summary">${summaryLines.map(line => `<p>${esc(line)}</p>`).join('')}</section><h2>本期明细</h2>${entries.length ? tableFor(entries) : '<p class="empty">本期无已完成课程或账户流水。</p>'}${undated.length ? `<h2>日期待核对记录</h2><p class="explain">以下记录未纳入时段统计，无法判断所属期间。</p>${tableFor(undated)}` : ''}<h2>统计说明</h2><ul class="explain">${notices.map(notice => `<li>${esc(notice)}</li>`).join('')}</ul><footer>课时簿 · 家长对账预览</footer></main></body></html>`;
  return {text, html, summary, entries, undated, notices, settlement};
}
