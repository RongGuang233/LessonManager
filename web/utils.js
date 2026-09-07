export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money = cents => cents == null ? '待核对' : new Intl.NumberFormat('zh-CN', {style:'currency',currency:'CNY',maximumFractionDigits:2}).format(cents / 100);
export const hours = minutes => minutes == null ? '待核对' : `${Number((minutes / 60).toFixed(2))} 小时`;
export const dateKey = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
export const today = () => dateKey(new Date());
export const addDays = (day, n) => {const d = new Date(`${day}T12:00:00`);d.setDate(d.getDate()+n);return dateKey(d);};
export const monday = day => {const d = new Date(`${day}T12:00:00`);return addDays(day,-((d.getDay()+6)%7));};
export const minutes = time => {const [h,m] = (time || '09:00').split(':').map(Number);return h*60+m;};
export const timeLabel = mins => `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
export const statusText = status => ({scheduled:'待上课',completed:'已上课',cancelled:'请假 / 取消',active:'在读',paused:'暂停',archived:'已归档'}[status] || status);
export const subjectClass = subject => subject === '数学' ? 'math' : subject === '物理' ? 'physics' : 'other';
export function statsFor(state,start,end,studentId='') {
  const courses=state.courses.filter(c=>c.status==='completed' && c.date>=start && c.date<=end && (!studentId||c.student_id===studentId));
  const payments=state.payments.filter(p=>p.date>=start && p.date<=end && (!studentId||p.student_id===studentId));
  return {minutes:courses.reduce((sum,c)=>sum+(c.actual_minutes??0),0),fee:courses.reduce((sum,c)=>sum+(c.fee_cents??0),0),received:payments.filter(p=>p.kind!=='adjustment').reduce((sum,p)=>sum+p.amount_cents,0),receiptCorrection:payments.filter(p=>p.kind==='receipt_correction').reduce((sum,p)=>sum+p.amount_cents,0),adjusted:payments.filter(p=>p.kind==='adjustment').reduce((sum,p)=>sum+p.amount_cents,0),undatedCourses:state.courses.filter(c=>c.status==='completed'&&!c.date&&(!studentId||c.student_id===studentId)).length,undatedPayments:state.payments.filter(p=>!p.date&&(!studentId||p.student_id===studentId)).length,unknown:courses.filter(c=>c.actual_minutes==null||c.fee_cents==null||c.needs_review).length,courses,payments};
}

export function accountEntries(state,studentId) {
  const settlement=state.students?.find(s=>s.id===studentId)?.settlement ?? state.meta?.account_settlements?.[studentId] ?? null;
  const settledCourses=new Set(settlement?.course_ids || []);
  const settledPayments=new Set(settlement?.payment_ids || []);
  const entries=[
    ...state.payments.filter(p=>p.student_id===studentId).map(p=>({id:p.id,date:p.date,time:'',type:p.kind,settled:settledPayments.has(p.id),amount:p.amount_cents,notes:p.notes,source:p.source,record:p})),
    ...state.courses.filter(c=>c.student_id===studentId&&c.status==='completed').map(c=>({id:c.id,date:c.date,time:c.start_time||'',type:'course',settled:settledCourses.has(c.id),amount:c.fee_cents==null?null:-c.fee_cents,notes:c.notes,source:c.source,record:c})),
  ];
  const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
  const uncertain=settlement
    ? entries.some(e=>!e.settled&&(!validDate(e.date)||e.date<settlement.confirmed_on||!Number.isSafeInteger(e.amount)||e.record.needs_review))
    : entries.some(e=>!e.date||e.amount==null);
  if(settlement) entries.push({id:`settlement:${studentId}`,date:settlement.confirmed_on,time:'',type:'settlement',settled:false,amount:0,notes:`历史账目于 ${settlement.confirmed_on} ${settlement.balance_cents===0?'确认结清':'确认历史余额结转'}，确认结余为 ${money(settlement.balance_cents)}；不代表新增缴费、退款或现金收入。${settlement.note ? ` ${settlement.note}` : ''}`,record:{...settlement,id:`settlement:${studentId}`,student_id:studentId}});
  const order=e=>e.settled?0:e.type==='settlement'?1:e.type==='course'?3:2;
  const dated=entries.filter(e=>e.date).sort((a,b)=>a.date.localeCompare(b.date)||order(a)-order(b)||a.time.localeCompare(b.time));
  const undated=entries.filter(e=>!e.date);
  let balance=0;
  for(const e of dated){
    if(e.type==='settlement'){balance=settlement.balance_cents;e.balance=balance;continue;}
    if(e.settled){e.balance=null;continue;}
    balance+=e.amount??0;e.balance=uncertain?null:balance;
  }
  for(const e of undated)e.balance=null;
  return {dated,undated,uncertain,settlement};
}
