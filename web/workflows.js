import {addDays, minutes, today} from './utils.js';

export function estimatedFee(course, student) {
  const rate = student?.rates?.[course.subject];
  return rate == null ? null : Math.round(rate * course.duration_minutes / 60);
}
export function attentionFor(student, courses, date = today()) {
  if (!student.balance_verified) return 'unverified';
  if (student.balance_cents < 0) return 'debt';
  const next = courses.filter(c => c.student_id === student.id && c.status === 'scheduled' && c.date >= date)
    .sort((a,b) => a.date.localeCompare(b.date) || (a.start_time || '').localeCompare(b.start_time || ''))[0];
  const expected = next ? estimatedFee(next, student) : null;
  return expected != null && student.balance_cents < expected ? 'low' : 'normal';
}
export function courseChangePayload(course, form) {
  const payload = {date:form.date || null};
  if (form.start_time !== undefined && (form.start_time || null) !== (course.start_time || null)) payload.start_time = form.start_time || null;
  if (form.duration_hours !== undefined) {
    const duration = Math.round(Number(form.duration_hours) * 60);
    if (duration !== course.duration_minutes) payload.duration_minutes = duration;
  }
  if (form.notes !== undefined && form.notes !== (course.notes ?? '')) payload.notes = form.notes;
  return payload;
}

export function contextualStudentId(route, {selectedStudent, filterStudent, statsStudent}, students) {
  const id = route === 'students' ? selectedStudent : route === 'schedule' ? filterStudent : route === 'stats' ? statsStudent : '';
  return id && students.some(student => student.id === id) ? id : '';
}

const plannerViewKey = 'lesson-manager.planner-view';
const plannerViews = ['list', 'week', 'month'];
export function readPlannerView(storage) {
  try {
    const view = storage?.getItem(plannerViewKey);
    return plannerViews.includes(view) ? view : 'list';
  } catch { return 'list'; }
}
export function savePlannerView(storage, view) {
  if (!plannerViews.includes(view)) return;
  try { storage?.setItem(plannerViewKey, view); } catch { /* View preferences are optional. */ }
}

export function plannedChanges(courses, course, form) {
  if (course) {
    const following = form.scope === 'following' && course.series_id && course.status === 'scheduled' && course.date;
    const originals = following ? courses.filter(c => c.series_id === course.series_id && c.date >= course.date && c.status === 'scheduled') : [course];
    const shift = course.date && form.date ? Math.round((new Date(form.date+'T12:00:00') - new Date(course.date+'T12:00:00')) / 86400000) : 0;
    const payload = courseChangePayload(course, form);
    return originals.map(c => ({...c, ...payload, date:following ? addDays(c.date, shift) : payload.date}));
  }
  if (!form.date || !form.start_time) return [];
  const end = form.repeat_until || form.date;
  if (end < form.date || end > addDays(form.date, 366)) return [];
  const result=[];
  for (let date=form.date; date<=end; date=addDays(date,7)) result.push({id:'draft-'+date,student_id:form.student_id,subject:form.subject,date,start_time:form.start_time,duration_minutes:Number(form.duration_hours)*60,status:'scheduled'});
  return result;
}
export function scheduleConflicts(courses, changes) {
  const replaced = new Set(changes.map(c=>c.id));
  const all = [...courses.filter(c=>!replaced.has(c.id)),...changes];
  const pairs=[];
  const seen=new Set();
  for (const change of changes) {
    if (change.status==='cancelled' || !change.date || !change.start_time) continue;
    const begin=minutes(change.start_time), finish=begin+(change.status==='completed'?(change.actual_minutes??change.duration_minutes):change.duration_minutes);
    for (const other of all) {
      if (other.id===change.id || other.status==='cancelled' || other.date!==change.date || !other.start_time) continue;
      const otherBegin=minutes(other.start_time), otherFinish=otherBegin+(other.status==='completed'?(other.actual_minutes??other.duration_minutes):other.duration_minutes);
      const key=[change.id,other.id].sort().join('|');
      if(begin<otherFinish && otherBegin<finish && !seen.has(key)){seen.add(key);pairs.push({change,other});}
    }
  }
  return pairs;
}
export function reviewCategory(review) {
  const text = review.kind+' '+review.message;
  if (/payment|缴费|款项|充值/.test(text)) return '款项';
  if (/date|日期|年份/.test(text)) return '日期';
  if (/rate|price|单价|金额|课费/.test(text)) return '费用';
  if (/time|时长|时间|课时/.test(text)) return '课时';
  return '其他';
}

export function lessonCredit(student, courses, date = today()) {
  if (!student.balance_verified || student.balance_cents < 0) return null;
  const next = courses.filter(c => c.student_id === student.id && c.status === 'scheduled' && c.date >= date)
    .sort((a,b) => a.date.localeCompare(b.date) || (a.start_time || '').localeCompare(b.start_time || ''))[0];
  const rates = Object.entries(student.rates || {}).filter(([,rate]) => rate != null);
  const subject = next?.subject || (rates.length === 1 ? rates[0][0] : null);
  const rate = student.rates?.[subject], duration = next?.duration_minutes || 120;
  if (rate == null || rate <= 0) return null;
  return {count:Math.floor(student.balance_cents / (rate * duration / 60) * 100) / 100, subject, duration};
}

export function impactsCurrentAccount(review, students, courses) {
  const student = students.find(s => s.id === review.student_id);
  if (!student || student.status !== 'active') return false;
  if (!student.balance_verified) return true;
  const course = courses.find(c => c.id === review.course_id);
  return Boolean(course && course.status === 'completed' && !student.settlement?.course_ids?.includes(course.id));
}

export function courseHasEnded(course, date = today(), currentMinutes = new Date().getHours()*60+new Date().getMinutes()) {
  return Boolean(course.date && (course.date < date || (course.date === date && course.start_time && minutes(course.start_time) + course.duration_minutes <= currentMinutes)));
}

export function backupSummary(doc) {
  if (!doc || doc.schema_version !== 1 || !['students','courses','payments','reviews','periods'].every(key => Array.isArray(doc[key]))) {
    throw new Error('请选择完整的课时簿备份。');
  }
  return {date:doc.meta?.last_backup_at, students:doc.students.length, courses:doc.courses.length, payments:doc.payments.length};
}
