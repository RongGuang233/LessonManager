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
  return {minutes:courses.reduce((sum,c)=>sum+(c.actual_minutes??0),0),fee:courses.reduce((sum,c)=>sum+(c.fee_cents??0),0),received:payments.filter(p=>p.kind!=='adjustment').reduce((sum,p)=>sum+p.amount_cents,0),adjusted:payments.filter(p=>p.kind==='adjustment').reduce((sum,p)=>sum+p.amount_cents,0),undatedCourses:state.courses.filter(c=>c.status==='completed'&&!c.date&&(!studentId||c.student_id===studentId)).length,undatedPayments:state.payments.filter(p=>!p.date&&(!studentId||p.student_id===studentId)).length,unknown:courses.filter(c=>c.actual_minutes==null||c.fee_cents==null||c.needs_review).length,courses,payments};
}

export function accountEntries(state,studentId) {
  const entries=[
    ...state.payments.filter(p=>p.student_id===studentId).map(p=>({id:p.id,date:p.date,time:'',type:p.kind,amount:p.amount_cents,notes:p.notes,source:p.source,record:p})),
    ...state.courses.filter(c=>c.student_id===studentId&&c.status==='completed').map(c=>({id:c.id,date:c.date,time:c.start_time||'',type:'course',amount:c.fee_cents==null?null:-c.fee_cents,notes:c.notes,source:c.source,record:c})),
  ];
  const uncertain=entries.some(e=>!e.date||e.amount==null);
  const dated=entries.filter(e=>e.date).sort((a,b)=>a.date.localeCompare(b.date)||(a.type==='course'?1:0)-(b.type==='course'?1:0)||a.time.localeCompare(b.time));
  const undated=entries.filter(e=>!e.date);
  let balance=0;
  for(const e of dated){balance+=e.amount??0;e.balance=uncertain?null:balance;}
  for(const e of undated)e.balance=null;
  return {dated,undated,uncertain};
}
