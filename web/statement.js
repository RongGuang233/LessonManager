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
  // Current balance depends on confirmed amounts, while period balances also need reliable dates.
  const currentRows = all.filter(entry => !entry.settled && entry.type !== 'settlement');
  const currentBalanceReliable = Boolean((settlement || student.balance_verified === true)
    && currentRows.every(entry => entry.amount != null && !entry.record.needs_review));
  const currentBalanceCents = currentBalanceReliable
    ? sum([settlement ? settlement.balance_cents : 0, ...currentRows.map(entry => entry.amount)]) : null;
  Object.assign(summary, {currentBalanceCents, currentBalanceReliable});
  const notices = [];
  if (!balanceReliable) notices.push('本期合计按已记录明细统计，期初、期末余额暂无法确定。');
  if (within.some(entry => entry.settled)) notices.push(`标注“已结转”的旧账已纳入 ${settlement.confirmed_on} 确认结余，不重复影响当前余额。`);
  const visibleUndated = undatedSource.filter(entry => !entry.settled);
  if (visibleUndated.length) notices.push(`${visibleUndated.length} 笔日期待核对记录未计入本期合计。`);
  if (payment.unknown + refund.unknown + adjustment.unknown + fee.unknown) notices.push('待核对金额未计入合计。');
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
  const totalValue = total => total.unknown
    ? `${total.cents ? `已知 ${money(total.cents)}，另有 ` : ''}${total.unknown} 笔金额待核对`
    : money(total.cents);
  const metrics = [
    ['本期收款', totalValue(payment)],
    ['本期上课', `${courses.length} 次 · ${unknownMinutes ? `${knownMinutes ? `已知 ${hours(knownMinutes)}，` : ''}${unknownMinutes} 次时长待核对` : hours(knownMinutes)}`],
    ['本期扣费', totalValue(fee)],
    ...(refund.cents || refund.unknown ? [['本期退款', totalValue(refund)]] : []),
    ...(adjustment.cents || adjustment.unknown ? [['本期调整', totalValue(adjustment)]] : []),
  ];
  const currentLabel = currentBalanceReliable ? (currentBalanceCents < 0 ? '当前已确认欠费' : '当前已确认余额') : '当前余额待核对';
  const currentValue = currentBalanceCents == null ? '待核对' : money(Math.abs(currentBalanceCents));
  const periodLine = balanceReliable ? `期初结余 ${money(summary.openingCents)} · 期末结余 ${money(summary.closingCents)}` : '';
  const parentEntries = entries.filter(entry => entry.type !== 'settlement');
  const parentUndated = undated.filter(entry => !entry.settled);
  const amountLabel = entry => entry.type === 'course' ? '扣费' : entry.type === 'payment' ? '收款' : labels[entry.type] || '金额';
  const entryAmount = entry => entry.amount == null ? '待核对' : entry.type === 'adjustment' ? signedMoney(entry.amount) : money(Math.abs(entry.amount));
  const lineFor = entry => [entry.date || '日期待核对', entry.time, entry.label, entry.subject,
    entry.type === 'course' ? entry.detail : '', `${amountLabel(entry)} ${entryAmount(entry)}`,
    entry.settled ? '已结转' : '', entry.needsReview ? '记录待核对' : ''].filter(Boolean).join(' · ');
  const text = [`${student.name ?? ''} · 课时与费用对账单`, `${currentLabel}：${currentValue}`, '',
    `本期：${start} 至 ${end}`, ...metrics.map(([label, value]) => `${label}：${value}`),
    ...(periodLine ? [periodLine] : []), '', '本期明细',
    ...(parentEntries.length ? parentEntries.map(lineFor) : ['本期无已完成课程或收付款记录。']),
    ...(parentUndated.length ? ['', '日期待核对记录', ...parentUndated.map(lineFor)] : []),
    ...(notices.length ? ['', ...notices] : [])].join('\n');
  const tableFor = rows => `<table><thead><tr><th>日期 / 事项</th><th>课时 × 单价</th><th class="number">收款 / 扣费</th></tr></thead><tbody>${rows.map(entry => `<tr><td>${esc(entry.date || '日期待核对')}${entry.time ? ` ${esc(entry.time)}` : ''}<strong>${esc(entry.label)}${entry.subject ? ` · ${esc(entry.subject)}` : ''}</strong>${entry.settled ? '<small>已结转</small>' : ''}${entry.needsReview ? '<small>记录待核对</small>' : ''}</td><td>${esc(entry.detail)}</td><td class="number">${esc(amountLabel(entry))}<strong>${esc(entryAmount(entry))}</strong></td></tr>`).join('')}</tbody></table>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(student.name)} · 课时与费用对账单</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f5f2eb;color:#302e29;font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:880px;margin:16px auto;padding:24px;background:#fffdf8}header{padding-bottom:16px}h1{font-size:24px;margin:0 0 16px;font-weight:600}h2{font-size:18px;margin:28px 0 12px}p{margin:8px 0}.balance{padding:20px 24px;background:#f4f1e8}.balance span{display:block;color:#615e55}.balance strong{font-size:36px;line-height:1.4;font-weight:600;font-variant-numeric:tabular-nums}.range,.explain{color:#615e55}.range{padding-top:16px;border-top:1px solid #d9d5ca}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px 24px;margin-top:16px}.summary p{margin:0}.summary span{display:block;color:#615e55;font-size:12px}.summary strong{display:block;font-size:17px;font-weight:500;font-variant-numeric:tabular-nums}.period{margin-top:16px;font-size:12px;color:#615e55}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:12px 8px;text-align:left;border-bottom:1px solid #d9d5ca;vertical-align:top;overflow-wrap:anywhere}th{font-size:12px;color:#59554c;border-top:1px solid #a39b89}th:first-child{width:42%}th:nth-child(2){width:30%}td strong,td small{display:block}td strong{font-weight:500}small{font-size:12px;color:#686357}.number{text-align:right;font-variant-numeric:tabular-nums}.explain{font-size:12px;margin-top:20px}.explain p{margin:4px 0}.empty{padding:16px 0;color:#615e55}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}footer{margin-top:28px;border-top:1px solid #d9d5ca;padding-top:8px;font-size:12px;color:#686357}@page{size:A4;margin:15mm}@media print{body,main{background:white;color:black;font-family:"Songti SC","STSong",serif}main{margin:0;padding:0;max-width:none}.balance{background:white;border:1px solid #aaa}.range,.explain,small,th,footer{color:#333}table{font-size:11px}th,td{padding:8px 6px}h1{font-size:22px}header{padding-bottom:16px}}@media(max-width:600px){main{padding:20px;margin:0}h1{font-size:20px}.balance{padding:16px}.balance strong{font-size:32px}.summary{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}.summary strong{font-size:16px}th,td{padding:8px 4px;font-size:12px}}
  </style></head><body><main><header><h1>${esc(student.name)} · 课时与费用对账单</h1><div class="balance"><span>${esc(currentLabel)}</span><strong>${esc(currentValue)}</strong></div></header><p class="range">本期：${esc(start)} 至 ${esc(end)}</p><section class="summary">${metrics.map(([label,value]) => `<p><span>${esc(label)}</span><strong>${esc(value)}</strong></p>`).join('')}</section>${periodLine ? `<p class="period">${esc(periodLine)}</p>` : ''}<h2>本期明细</h2>${parentEntries.length ? tableFor(parentEntries) : '<p class="empty">本期无已完成课程或收付款记录。</p>'}${parentUndated.length ? `<h2>日期待核对记录</h2>${tableFor(parentUndated)}` : ''}${notices.length ? `<aside class="explain">${notices.map(notice => `<p>${esc(notice)}</p>`).join('')}</aside>` : ''}<footer>课时簿 · 家长对账单</footer></main></body></html>`;
  return {text, html, summary, entries, undated, notices, settlement};
}
