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
export function plannedChanges(courses, course, form) {
  if (course) {
    const following = form.scope === 'following' && course.series_id && course.status === 'scheduled' && course.date;
    const originals = following ? courses.filter(c => c.series_id === course.series_id && c.date >= course.date && c.status === 'scheduled') : [course];
    const shift = course.date && form.date ? Math.round((new Date(form.date+'T12:00:00') - new Date(course.date+'T12:00:00')) / 86400000) : 0;
    return originals.map(c => ({...c, date:following ? addDays(c.date, shift) : form.date, start_time:form.start_time, duration_minutes:Number(form.duration_hours)*60}));
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
