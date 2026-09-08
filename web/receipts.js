import {hours, money, today} from './utils.js';
import {lessonCredit} from './workflows.js';

/** Parent-facing copy for a newly saved payment, using the reloaded student balance. */
export function buildPaymentReceipt(payment, student, courses = [], asOf = today()) {
  if (!student || payment?.student_id !== student.id || payment.kind !== 'payment'
      || !Number.isSafeInteger(payment.amount_cents) || payment.amount_cents <= 0) return '';
  const balance = Number.isSafeInteger(student.balance_cents) ? student.balance_cents : null;
  const verified = student.balance_verified === true;
  const balanceLabel = balance < 0 ? '当前欠费' : '当前余额';
  const text = [`${student.name ?? ''} · 缴费回执`,
    `收到缴费：${money(payment.amount_cents)}`,
    `缴费日期：${payment.date || '待核对'}`,
    `${balanceLabel}：${balance == null ? '待核对' : money(Math.abs(balance))}${!verified && balance != null ? '（账面金额，待核对）' : ''}`];
  const credit = verified && balance != null
    ? lessonCredit(student, courses, asOf) : null;
  if (credit && credit.subject && Number.isFinite(credit.count) && credit.count >= 0
      && Number.isFinite(credit.duration) && credit.duration > 0) {
    text.push(`按${credit.subject}每节 ${hours(credit.duration)}估算，当前余额约可上 ${credit.count} 节。`);
  }
  return text.join('\n');
}
