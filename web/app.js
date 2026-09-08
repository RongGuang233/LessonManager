import {esc,money,hours,today,addDays,monday,minutes,timeLabel,statusText,subjectClass,dateKey,statsFor,accountEntries} from './utils.js';
import {estimatedFee,regularDuration,attentionFor,plannedChanges,scheduleConflicts,reviewCategory,lessonCredit,impactsCurrentAccount,courseHasEnded,backupSummary,courseChangePayload,contextualStudentId,readPlannerView,savePlannerView,readStudentLocation,saveStudentLocation,makeupLinks} from './workflows.js';
import {buildStatement} from './statement.js';
import {buildPaymentReceipt} from './receipts.js';
import {splitHistoryNotes} from './history-notes.js';
const main=document.querySelector('#main'), dialog=document.querySelector('#dialog');
let state={students:[],courses:[],payments:[],reviews:[],periods:[],meta:{}}, loaded=false;
let plannerStorage;try{plannerStorage=window.localStorage;}catch{}
const studentLocation=readStudentLocation(plannerStorage);
let route=location.hash.slice(1)||'schedule', anchor=today(), view=readPlannerView(plannerStorage), selectedStudent=studentLocation.studentId, studentSearch='', studentStatus='active';
let filterStudent='',filterStatus='',statsMode='month',statsStart=today().slice(0,7)+'-01',statsEnd=today(),statsStudent='';
let studentAttention='',studentTab=studentLocation.tab,recordMode='recent',recordStart=addDays(today(),-30),recordEnd=today();
let reviewStudent='',reviewType='',reviewStatus='pending',reviewPage=0,reviewScope='current',agendaMode='today',showFilters=false;
let toastTimer;
const formDrafts=new Map();
let dialogDraftKey='';
const dialogParents=[];
let recordKind='',courseStatus='',statsOrigin='';
const calendarPositions=new Map();
const studentBy=id=>state.students.find(s=>s.id===id);
const courseBy=id=>state.courses.find(c=>c.id===id);
const displayMinutes=c=>c.status==='completed'&&c.actual_minutes!=null?c.actual_minutes:c.duration_minutes;
const option=(value,label,selected)=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`;
const studentOptions=(selected,all=false)=>`${all?option('','所有学生',selected):''}${[...state.students].sort((a,b)=>(a.status!=='active')-(b.status!=='active')||a.name.localeCompare(b.name,'zh-CN')).map(s=>option(s.id,s.name+(s.status!=='active'?`（${statusText(s.status)}）`:''),selected)).join('')}`;
const notice=(text,tone='')=>`<div class="notice ${tone}">${text}</div>`;
const empty=(text,action='')=>`<div class="empty"><p>${text}</p>${action}</div>`;
const button=(action,text,id='',cls='')=>`<button type="button" data-action="${action}" ${id?`data-id="${esc(id)}"`:''} class="${cls}">${text}</button>`;
const field=(label,control,cls='')=>`<label class="field ${cls}"><span>${label}</span>${control}</label>`;
const input=(name,type,value='',attrs='')=>`<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}>`;
const dateShort=d=>d?`${Number(d.slice(5,7))}月${Number(d.slice(8,10))}日`:'日期待核对';
const attentionLabels={debt:'已欠费',low:'不足下次课费',unverified:'余额待核对',normal:''};
const isSettledCourse=c=>Boolean(studentBy(c.student_id)?.settlement?.course_ids.includes(c.id));
const isSettledPayment=p=>Boolean(p&&studentBy(p.student_id)?.settlement?.payment_ids.includes(p.id));
const balanceHTML=s=>`<span class="${s.balance_cents<0?'negative':''}">${s.balance_cents<0&&s.balance_verified?'欠费 '+money(-s.balance_cents):money(s.balance_cents)}</span>${!s.balance_verified?'<small class="unverified">已记录 · 待核对</small>':''}`;
const feeHTML=c=>c.status==='scheduled'?`预计 ${money(estimatedFee(c,studentBy(c.student_id)))}`:c.status==='cancelled'?'不扣费':c.fee_cents==null&&!c.needs_review?'未留存':money(c.fee_cents);
function toast(message,undo=null){const el=document.querySelector('#toast');el.replaceChildren(document.createTextNode(message));if(undo){const b=document.createElement('button');b.textContent='撤销本次记课';b.onclick=async()=>{b.disabled=true;try{await undo();toast('已撤销本次记课，余额已恢复');}catch(e){toast(e.message);}};el.append(b);}el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},undo?12000:4500);}
async function api(path,method='GET',body){let response;try{response=await fetch(`/api${path}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});}catch{throw new Error('无法连接本地服务，请确认课时簿仍在运行。');}let data;try{data=await response.json();}catch{throw new Error('本地服务返回了无法读取的内容，请稍后重试。');}if(!response.ok)throw new Error(data.error||'保存失败，请重试。');return data;}
async function refresh(){state=await api('/state');loaded=true;render();}
async function mutate(path,method,body,message='已保存'){const result=await api(path,method,body);await refresh();toast(message);return result;}
function saveDialogDraft(){
 if(!dialogDraftKey)return;
 const values={};dialog.querySelectorAll('input[name],select[name],textarea[name]').forEach(el=>{if(el.type!=='file')values[el.name]=el.type==='checkbox'?el.checked:el.value;});
 formDrafts.set(dialogDraftKey,values);
}
dialog.addEventListener('cancel',()=>{saveDialogDraft();dialogParents.length=0;});
function closeDialog(){dialogParents.length=0;dialog.close();}
function backDialog(){
 saveDialogDraft();const parent=dialogParents.pop();if(!parent){closeDialog();return;}
 dialog.replaceChildren(...parent.nodes);dialog.className=parent.className;dialogDraftKey=parent.draftKey;
 const body=dialog.querySelector('.dialog-body');if(body)body.scrollTop=parent.scroll;
 if(parent.focus?.isConnected)parent.focus.focus({preventScroll:true});
}
function openDialog(title,body,onSubmit,footer='保存',wide=false,draftKey=''){
 if(dialog.open){saveDialogDraft();dialogParents.push({nodes:[...dialog.childNodes],className:dialog.className,draftKey:dialogDraftKey,scroll:dialog.querySelector('.dialog-body')?.scrollTop||0,focus:document.activeElement});}else dialogParents.length=0;dialogDraftKey=draftKey;dialog.classList.toggle('wide',wide);dialog.classList.toggle('statement-dialog',title==='家长对账');
 dialog.innerHTML=`<form><header class="dialog-head"><h2 id="dialog-title">${title}</h2><button type="button" data-close aria-label="关闭对话框" class="icon-button">×</button></header><div class="dialog-body">${body}<p class="form-error" role="alert" hidden></p></div><footer class="dialog-foot"><button type="button" ${dialogParents.length?'data-back':'data-close'}>${dialogParents.length?'返回':'关闭'}</button>${onSubmit?`<button type="submit" class="primary">${footer}</button>`:''}</footer></form>`;
 const form=dialog.querySelector('form');
 dialog.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{saveDialogDraft();closeDialog();});const back=dialog.querySelector('[data-back]');if(back)back.onclick=backDialog;if(!dialog.open)dialog.showModal();
 form.addEventListener('input',saveDialogDraft);form.addEventListener('change',saveDialogDraft);
 form.onsubmit=async e=>{e.preventDefault();const submit=e.submitter,error=form.querySelector('.form-error');error.hidden=true;if(submit)submit.disabled=true;try{const result=await onSubmit(Object.fromEntries(new FormData(form)));if(result!==false){formDrafts.delete(draftKey);dialogDraftKey='';closeDialog();if(typeof result==='function')result();}}catch(err){error.textContent=err.message;error.hidden=false;}finally{if(submit)submit.disabled=false;}};
 const draft=formDrafts.get(draftKey);
 if(draft)queueMicrotask(()=>{
  if(dialog.querySelector('form')!==form)return;
  for(const el of form.querySelectorAll('input[name],select[name],textarea[name]')){
   if(!(el.name in draft)||el.type==='file')continue;
   if(el.type==='checkbox')el.checked=draft[el.name];else el.value=draft[el.name];
   el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));
  }
  toast('已恢复未保存的内容');
 });
}
function confirmAction(title,content,action,label='确认'){openDialog(title,content,action,label);}
function header(_eyebrow,title,subtitle,actions=''){return `<header class="page-head"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="actions">${route==='settings'||(route==='students'&&selectedStudent)?'':button('global-payment','＋ 记缴费')}${actions}</div></header>`;}
function render(){
 const calendar=main.querySelector('.calendar-scroll');if(calendar)calendarPositions.set(calendar.dataset.key,calendar.scrollTop);
 document.querySelectorAll('[data-nav]').forEach(a=>{a.classList.toggle('active',a.dataset.nav===route||(route==='reviews'&&a.dataset.nav==='settings'));if(a.dataset.nav===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
 const count=document.querySelector('#review-count');count.textContent=state.reviews.filter(r=>r.status==='pending'&&impactsCurrentAccount(r,state.students,state.courses)).length||'';
 if(!loaded)return;if(route==='students')renderStudents();else if(route==='stats')renderStats();else if(route==='settings')renderSettings();else if(route==='reviews')renderReviews();else renderSchedule();
}
function filteredCourses(){return state.courses.filter(c=>(!filterStudent||c.student_id===filterStudent)&&(!filterStatus||c.status===filterStatus));}
function agenda(){
 const relevant=state.courses.filter(c=>!filterStudent||c.student_id===filterStudent);
 const pending=relevant.filter(c=>c.status==='scheduled'&&courseHasEnded(c));
 const daily=relevant.filter(c=>c.date===today()&&c.status!=='cancelled');
 const next=relevant.filter(c=>c.status==='scheduled'&&c.date>=today()&&!courseHasEnded(c)).sort((a,b)=>a.date.localeCompare(b.date)||(a.start_time||'').localeCompare(b.start_time||''))[0];
 const list=(agendaMode==='pending'?pending:daily.length?daily:next?[next]:[]).sort((a,b)=>a.date.localeCompare(b.date)||(a.start_time||'').localeCompare(b.start_time||''));
 return `<section class="agenda" aria-label="今日工作台"><div class="agenda-heading"><div class="actions"><button data-action="agenda-today" class="text-button ${agendaMode==='today'?'current':''}">${daily.length?'今日 '+daily.length+' 节':'下一次课'}</button><button data-action="agenda-pending" class="text-button ${agendaMode==='pending'?'current':''}">待记课 ${pending.length}</button></div></div><div class="agenda-list">${list.length?list.map(c=>`<article class="agenda-item ${c.status}"><div class="agenda-time">${c.date!==today()?`<small>${dateShort(c.date)}</small>`:''}${c.start_time||'时间待核对'}</div><div class="agenda-person"><strong>${esc(studentBy(c.student_id)?.name)}</strong><span>${esc(c.subject)} · ${hours(displayMinutes(c))}</span></div><div class="agenda-fee">${feeHTML(c)}</div><div class="actions">${c.status==='scheduled'&&courseHasEnded(c)?button('complete-course','记课',c.id,'primary'):c.status==='completed'?'<span class="done-label">✓ 已记课</span>':''}${button('course',courseHasEnded(c)?'详情':'查看课程',c.id,'text-button')}</div></article>`).join(''):`<p class="agenda-empty">${agendaMode==='pending'?'没有待确认的课程。':'暂无排课。'}</p>`}</div></section>`;
}
function lessonDays(start,courses){
 const list=courses.filter(c=>c.date>=start&&c.date<=addDays(start,6)).sort((a,b)=>a.date.localeCompare(b.date)||(a.start_time||'').localeCompare(b.start_time||''));
 const days=[...new Set(list.map(c=>c.date))];
 return `<div class="lesson-days">${days.length?days.map(d=>`<section class="lesson-day"><div class="lesson-day-heading"><h2>${dateShort(d)} <span>周${'日一二三四五六'[new Date(d+'T12:00:00').getDay()]}</span></h2>${button('day-course','安排课程',d,'text-button')}</div>${list.filter(c=>c.date===d).map(c=>`<article class="lesson-list-row ${c.status}"><span class="lesson-list-time">${c.start_time?c.start_time+'–'+timeLabel(minutes(c.start_time)+displayMinutes(c)):'时间待定'}</span><div><strong>${esc(studentBy(c.student_id)?.name)}</strong><span>${esc(c.subject)} · ${hours(displayMinutes(c))}</span></div><span class="lesson-list-fee">${feeHTML(c)}</span>${button(c.status==='scheduled'&&courseHasEnded(c)?'complete-course':'course',c.status==='scheduled'&&courseHasEnded(c)?'记课':'查看',c.id,c.status==='scheduled'&&courseHasEnded(c)?'primary':'text-button')}</article>`).join('')}</section>`).join(''):empty('本周暂无符合条件的课程。',button('new-course','安排课程','','primary'))}</div>`;
}
function renderSchedule(){
 const start=monday(anchor),end=addDays(start,6),courses=filteredCourses();
 main.innerHTML=header('',view==='month'?'每月课表':view==='list'?'有课日':'每周课表',view!=='month'?`${dateShort(start)} — ${dateShort(end)}`:`${anchor.slice(0,4)} 年 ${Number(anchor.slice(5,7))} 月`,button('new-course','安排课程','','primary'))+
 agenda()+`<section class="planner"><div class="planner-toolbar"><div class="actions"><div class="segmented"><button data-action="view-list" aria-pressed="${view==='list'}">有课日</button><button data-action="view-week" aria-pressed="${view==='week'}">周</button><button data-action="view-month" aria-pressed="${view==='month'}">月</button></div><button data-action="prev" class="icon-button" aria-label="上一${view==='month'?'月':'周'}">‹</button><button data-action="today">今天</button><button data-action="next" class="icon-button" aria-label="下一${view==='month'?'月':'周'}">›</button><label class="sr-only" for="anchor">课表日期</label><input type="date" id="anchor" value="${anchor}"></div><div class="actions"><span class="legend-inline"><i class="done-swatch"></i> 已上课</span><button data-action="toggle-filters" aria-expanded="${showFilters}">筛选${filterStudent||filterStatus?' · 已启用':''}</button>${button('copy-week','复制上周')}</div></div><div class="planner-filters" ${showFilters?'':'hidden'}><label>学生 <select id="filter-student">${studentOptions(filterStudent,true)}</select></label><label>状态 <select id="filter-status">${option('','所有状态',filterStatus)}${['scheduled','completed','cancelled'].map(s=>option(s,statusText(s),filterStatus)).join('')}</select></label><span class="muted">点击空档排课 · 拖动待上课程调课</span></div>${view==='list'?lessonDays(start,courses):view==='week'?weekGrid(start,courses):monthGrid(courses)}</section>`;
 bindSchedule();
 const scroll=main.querySelector('.calendar-scroll');if(scroll){
  const key=monday(anchor);scroll.dataset.key=key;scroll.style.maxHeight=Math.max(320,innerHeight-(scroll.getBoundingClientRect().top+scrollY)-24)+'px';
  const week=courses.filter(c=>c.date>=start&&c.date<=end&&c.start_time&&c.status!=='cancelled');
  const focus=week.filter(c=>c.date===today());const times=(focus.length?focus:week).map(c=>minutes(c.start_time));
  const earliest=Math.min(8,...courses.filter(c=>c.date>=start&&c.date<=end&&c.start_time).map(c=>Math.floor(minutes(c.start_time)/60)));
  scroll.scrollTop=calendarPositions.get(key)??Math.max(0,((times.length?Math.min(...times):9*60)-earliest*60-30)/60*64);
 }
}
function courseChip(c,style=''){const s=studentBy(c.student_id);return `<button class="course ${subjectClass(c.subject)} ${c.status} ${c.conflict?'conflict':''}" data-action="${c.status==='scheduled'&&courseHasEnded(c)?'complete-course':'course'}" data-id="${esc(c.id)}" ${style?`style="${style}"`:''} draggable="${c.status==='scheduled'}" title="${esc(`${s?.name} · ${c.subject} · ${c.start_time||'时间待核对'} · ${statusText(c.status)}`)}"><span class="course-top"><strong>${esc(s?.name||'未知学生')}</strong><span class="subject-dot"></span></span><span>${esc(c.subject)} <span class="course-time">${c.start_time||'时间待核对'}${c.start_time?`–${timeLabel(minutes(c.start_time)+displayMinutes(c))}`:''}</span></span><small>${c.status==='completed'?`✓ 已上课 · ${hours(c.actual_minutes)}`:c.status==='cancelled'?'请假 / 取消':hours(c.duration_minutes)}${c.needs_review?' · 待核对':''}${c.conflict?' · 时间冲突':''}</small></button>`;}
function bindSchedule(){
 document.querySelector('#anchor').onchange=e=>{anchor=e.target.value||today();render();};
 document.querySelector('#filter-student').onchange=e=>{filterStudent=e.target.value;render();};document.querySelector('#filter-status').onchange=e=>{filterStatus=e.target.value;render();};
 main.querySelectorAll('.course[draggable="true"]').forEach(el=>el.ondragstart=e=>{e.dataTransfer.setData('text/plain',el.dataset.id);e.dataTransfer.effectAllowed='move';});
 main.querySelectorAll('[data-date]').forEach(el=>{el.ondragover=e=>{e.preventDefault();e.dataTransfer.dropEffect='move';};el.ondrop=e=>{e.preventDefault();e.stopPropagation();const c=courseBy(e.dataTransfer.getData('text/plain'));if(c?.status==='scheduled')courseForm(c,{date:el.dataset.date,start_time:el.dataset.time||c.start_time});};});
}
function studentPickerLabels(){
 const counts=new Map();state.students.forEach(s=>counts.set(s.name,(counts.get(s.name)||0)+1));
 return state.students.map(s=>({student:s,label:s.name+(s.grade?` · ${s.grade}`:'')+(s.status!=='active'?`（${statusText(s.status)}）`:'')+(counts.get(s.name)>1?` · 同名${state.students.filter(x=>x.name===s.name).findIndex(x=>x.id===s.id)+1}`:'')}));
}
function studentPicker(selected){
 const labels=studentPickerLabels(),current=labels.find(x=>x.student.id===selected),former=current&&current.student.status!=='active';
 return `<div class="student-picker full">${field('学生',input('student_query','search',current?.label||'','list="student-options" required placeholder="输入姓名，选择学生" autocomplete="off" role="combobox" aria-autocomplete="list"'))}${input('student_id','hidden',selected||'')}<datalist id="student-options"></datalist><details class="compact-details"><summary>往届学生</summary><label class="check"><input name="show_former" type="checkbox" ${former?'checked':''}>包含暂停、已归档学生</label></details></div>`;
}
function bindStudentPicker(onChange=()=>{}){
 const query=dialog.querySelector('[name="student_query"]'),selected=dialog.querySelector('[name="student_id"]'),former=dialog.querySelector('[name="show_former"]'),list=dialog.querySelector('#student-options');if(!query)return;
 const labels=studentPickerLabels();
 const update=()=>{
  const candidates=labels.filter(x=>former.checked||x.student.status==='active');
  list.innerHTML=candidates.map(x=>`<option value="${esc(x.label)}"></option>`).join('');
  const value=query.value.trim(),matches=candidates.filter(x=>x.label===value||x.student.name===value);
  selected.value=matches.length===1?matches[0].student.id:'';
  query.setCustomValidity(selected.value?'':'请从候选列表中选择一位学生。');onChange(selected.value);
 };
 query.addEventListener('input',update);query.addEventListener('change',update);former.addEventListener('change',update);selected.addEventListener('change',update);update();
}
function noteField(value=''){return `<details class="compact-details full"><summary>${value?'备注（已有内容）':'添加备注'}</summary>${field('备注',`<textarea name="notes" rows="2">${esc(value)}</textarea>`)}</details>`;}
function periodLabel(p){return p.name.replace(/课表$/,'')+(p.range_kind==='coverage'?' · 已录入范围':p.range_kind==='pending'?' · 日期待定':'');}
function changePreview(course,changes){
 const rows=changes.map(next=>{const old=courseBy(next.id);const changed=['date','start_time','duration_minutes','notes'].filter(key=>(old[key]??'')!==(next[key]??''));return {old,next,changed};}).filter(x=>x.changed.length);
 const value=(c,key)=>key==='date'?dateShort(c[key]):key==='duration_minutes'?hours(c[key]):key==='notes'?(c[key]||'无备注'):c[key]||'未填';
 const labels={date:'日期',start_time:'时间',duration_minutes:'时长',notes:'备注'};
 return `<section class="change-preview"><h3>${rows.length?'将修改 '+rows.length+' 节课程':'没有变动'}</h3><p class="muted small">未改动的字段保留每节课各自的安排。</p>${rows.length?`<div class="preview-list">${rows.map(({old,next,changed})=>`<article><strong>${esc(dateShort(old.date))}</strong><ul>${changed.map(key=>`<li>${labels[key]}：${esc(value(old,key))} → ${esc(value(next,key))}</li>`).join('')}</ul></article>`).join('')}</div>`:''}</section>`;
}
async function copyWeekForm(){
 let previewResult=null,previewNumber=0,selectedIds=new Set();
 const initialStudent=filterStudent,initialStatus=filterStatus;
 const params=()=>{const f=Object.fromEntries(new FormData(dialog.querySelector('form')));return {week_start:monday(anchor),student_id:f.copy_student||'',status:f.copy_status||''};};
 const selectedCourses=()=>previewResult?.created.filter(c=>selectedIds.has(c.source_course_id))||[];
 openDialog('复制上周',`<p class="detail-lead">${dateShort(addDays(monday(anchor),-7))}起的一周 → ${dateShort(monday(anchor))}起的一周</p><div class="form-grid">${field('复制学生',`<select name="copy_student">${studentOptions(initialStudent,true)}</select>`)}${field('上周课程状态',`<select name="copy_status">${option('','所有未取消课程',initialStatus)}${option('scheduled','待上课',initialStatus)}${option('completed','已上课',initialStatus)}${option('cancelled','请假 / 取消（不复制）',initialStatus)}</select>`)}</div><div id="copy-preview"></div>`,async f=>{
  const courses=selectedCourses();
  if(!courses.length)throw new Error('请至少选择一节课程。');
  if(scheduleConflicts(state.courses,courses).length&&!f.copy_overlap_ack)throw new Error('请先查看冲突并确认继续。');
  const r=await api('/courses/copy-week','POST',{...params(),source_ids:[...selectedIds]});await refresh();toast(`已复制 ${r.created.length} 节课，跳过 ${r.skipped} 节`);
 },'复制所选课程');
 const form=dialog.querySelector('form'),submit=form.querySelector('[type="submit"]');
 const updateSelection=()=>{
  const courses=selectedCourses(),conflicts=scheduleConflicts(state.courses,courses),all=form.querySelector('[name="copy_all"]');
  form.querySelector('#copy-count').textContent=`已选 ${courses.length} 节 · ${new Set(courses.map(c=>c.student_id)).size} 位学生`;
  if(all){all.checked=!!courses.length&&courses.length===previewResult.created.length;all.indeterminate=!!courses.length&&!all.checked;}
  form.querySelector('#copy-conflicts').innerHTML=conflicts.length?notice(`<strong>${conflicts.length} 处时间冲突</strong><ul>${conflicts.map(({change,other})=>`<li>${dateShort(change.date)} ${change.start_time} ${esc(studentBy(change.student_id)?.name)} 与 ${esc(studentBy(other.student_id)?.name)} ${other.start_time} 重叠</li>`).join('')}</ul><label class="check"><input name="copy_overlap_ack" type="checkbox">已知晓冲突，仍按此安排</label>`,'warning'):'';
  submit.textContent=`复制所选 ${courses.length} 节`;submit.disabled=!courses.length;
 };
 const update=async()=>{
  const revision=++previewNumber;previewResult=null;selectedIds.clear();submit.disabled=true;form.querySelector('#copy-preview').textContent='正在检查课程…';
  try{
   const result=await api('/courses/copy-week','POST',{...params(),preview:true});if(revision!==previewNumber||dialog.querySelector('form')!==form)return;
   previewResult=result;selectedIds=new Set(result.created.map(c=>c.source_course_id));
   form.querySelector('#copy-preview').innerHTML=`<section class="change-preview"><div class="copy-selection-head"><h3 id="copy-count" aria-live="polite"></h3>${result.created.length?'<label class="check"><input type="checkbox" name="copy_all" checked>全选</label>':''}</div>${!result.created.length?'<p class="muted">没有可复制的课程。</p>':''}${result.skipped?`<p class="muted small">${result.skipped} 节已有安排或信息不足，自动跳过。</p>`:''}<div class="preview-list copy-course-list">${result.created.map(c=>`<label class="copy-course-row"><input type="checkbox" data-copy-id="${esc(c.source_course_id)}" checked><span><strong>${esc(studentBy(c.student_id)?.name)}</strong><span>${dateShort(c.date)} ${c.start_time} · ${esc(c.subject)} · ${hours(c.duration_minutes)}</span></span></label>`).join('')}</div></section><div id="copy-conflicts" aria-live="polite"></div>`;
   form.querySelectorAll('[data-copy-id]').forEach(el=>el.onchange=()=>{if(el.checked)selectedIds.add(el.dataset.copyId);else selectedIds.delete(el.dataset.copyId);updateSelection();});
   const all=form.querySelector('[name="copy_all"]');if(all)all.onchange=()=>{form.querySelectorAll('[data-copy-id]').forEach(el=>{el.checked=all.checked;});selectedIds=new Set(all.checked?result.created.map(c=>c.source_course_id):[]);updateSelection();};
   updateSelection();
  }catch(err){if(revision!==previewNumber||dialog.querySelector('form')!==form)return;form.querySelector('#copy-preview').textContent=err.message;}
 };
 form.querySelectorAll('select').forEach(el=>el.onchange=update);await update();
}

function singleChangePreview(original,changed){
 if(!changed||!changed.date||!changed.start_time||!Number.isFinite(changed.duration_minutes)||changed.duration_minutes<=0)return '';
 if(original.date===changed.date&&original.start_time===changed.start_time&&original.duration_minutes===changed.duration_minutes)return '';
 const label=c=>`${dateShort(c.date)}${c.date?' 周'+'日一二三四五六'[new Date(c.date+'T12:00:00').getDay()]:''} ${c.start_time?c.start_time+'–'+timeLabel(minutes(c.start_time)+c.duration_minutes):'时间待核对'}`;
 return `<div class="change-summary"><span>${esc(label(original))} →</span><strong>${esc(label(changed))}</strong>${original.status==='scheduled'?`<span>预计课费 ${money(estimatedFee(original,studentBy(original.student_id)))} → ${money(estimatedFee(changed,studentBy(original.student_id)))}</span>`:original.status==='completed'?'<span>已完成课程的实际课时和扣费保持原记录。</span>':'<span>已取消课程不扣费。</span>'}</div>`;
}
function courseForm(c=null,defaults={}){
 if(!state.students.length){studentForm();return;}
 const item={student_id:filterStudent||selectedStudent||state.students.find(s=>s.status==='active')?.id||state.students[0].id,date:anchor,start_time:'18:00',duration_minutes:120,notes:'',...c,...defaults};
 const makeup=defaults.makeupFor;
 if(!c&&defaults.duration_minutes===undefined)item.duration_minutes=regularDuration(studentBy(item.student_id));
 const subjects=[...new Set([...Object.keys(studentBy(item.student_id)?.rates||{}),...(c?.source?['数学','物理',c.subject]:[])])];item.subject=item.subject||subjects[0];
 const historical=!!c?.source;
 openDialog(c?'编辑课程':makeup?'安排补课':'安排课程',`<div class="form-grid">${c||makeup?field('学生',`<strong>${esc(studentBy(item.student_id)?.name)}</strong>${!c?input('student_id','hidden',item.student_id):''}`):studentPicker(item.student_id)}${field('科目',`<select name="subject" ${c&&!historical?'disabled':''}>${subjects.map(s=>option(s,s,item.subject)).join('')}</select>`)}${field(historical?'日期（未知可留空）':'日期',input('date','date',item.date,historical?'':'required'))}${field(historical?'开始时间（未知可留空）':'开始时间',input('start_time','time',item.start_time,`${historical?'':'required'} step="60"`))}${field('计划时长（小时）',input('duration_hours','number',item.duration_minutes/60,`required min="${historical?'0.01':'1'}" max="24" step="${historical?'any':'1'}"`))}${!c&&!makeup?field('每周重复至（可不填）',input('repeat_until','date','','min="'+item.date+'"')):''}${c?.series_id&&c.status==='scheduled'?field('修改范围',`<select name="scope">${option('one','仅本次','one')}${option('following','本次及以后待上课程','one')}</select>`):''}${noteField(item.notes)}${c?.needs_review?field('核对已填写的信息','<span class="check"><input type="checkbox" name="reviewed">确认本次补充；仍缺失的事项继续保留</span>','full'):''}</div><div id="schedule-preview" aria-live="polite"></div>${historical?`<details><summary>原始来源</summary><p class="source">${esc(c.source)}</p></details>`:''}`,async f=>{
  const changes=plannedChanges(state.courses,c,f),conflicts=scheduleConflicts(state.courses,changes);
  if(conflicts.length&&!f.overlap_ack)throw new Error('此安排存在时间重叠，请查看下方冲突并确认继续。');
  const payload=c?courseChangePayload(c,f):{date:f.date||null,start_time:f.start_time||null,duration_minutes:Math.round(Number(f.duration_hours)*60),notes:f.notes};
  if(c){payload.scope=f.scope||'one';if(historical)payload.subject=f.subject;if(f.reviewed)payload.needs_review=false;await mutate(`/courses/${c.id}`,'PATCH',payload);}
  else{payload.student_id=f.student_id;payload.subject=f.subject;if(makeup)payload.makeup_for_id=makeup.id;if(f.repeat_until)payload.repeat_until=f.repeat_until;await mutate('/courses','POST',payload,'课程已安排');}
 },'保存',false,`course:${c?.id||(makeup?'makeup:'+makeup.id:item.student_id+':'+item.date+':'+item.start_time)}`);
 const preview=()=>{const f=Object.fromEntries(new FormData(dialog.querySelector('form'))),changes=plannedChanges(state.courses,c,f),conflicts=scheduleConflicts(state.courses,changes);dialog.querySelector('#schedule-preview').innerHTML=`${c?(f.scope==='following'?changePreview(c,changes):singleChangePreview(c,changes[0])):''}${changes.length>1&&!(c&&f.scope==='following')?notice(`将${c?'修改':'安排'} ${changes.length} 节课：${changes.slice(0,4).map(x=>dateShort(x.date)).join('、')}${changes.length>4?'等':''}。已完成课程保持原记录。`):''}${conflicts.length?notice(`<strong>有 ${conflicts.length} 处时间重叠</strong><ul>${conflicts.slice(0,5).map(({change,other})=>`<li>${dateShort(change.date)} ${change.start_time} 与 ${esc(studentBy(other.student_id)?.name)} ${other.start_time}–${timeLabel(minutes(other.start_time)+displayMinutes(other))} 重叠</li>`).join('')}</ul><label class="check"><input type="checkbox" name="overlap_ack">已知晓重叠，仍按此安排</label>`,'warning'):''}`;};
 dialog.querySelectorAll('[name="date"],[name="start_time"],[name="duration_hours"],[name="repeat_until"],[name="scope"],[name="notes"]').forEach(x=>x.addEventListener('input',preview));
 if(!c)bindStudentPicker(id=>{if(id!==item.student_id){dialog.querySelector('[name="duration_hours"]').value=regularDuration(studentBy(id))/60;item.student_id=id;}const select=dialog.querySelector('[name="subject"]');select.innerHTML=Object.keys(studentBy(id)?.rates||{}).map(s=>option(s,s,select.value)).join('');preview();});preview();
}
function makeupHTML(c){
 const {original,replacements}=makeupLinks(c,state.courses);
 const link=(course,label)=>`<div class="makeup-row"><span><strong>${label}</strong><span>${dateShort(course.date)} ${course.start_time||''} · ${esc(course.subject)}</span></span>${button('course','查看课程',course.id,'text-button')}</div>`;
 return original||replacements.length?`<section class="makeup-links" aria-label="补课关联">${original?link(original,'原请假课程'):''}${replacements.map(x=>link(x,x.status==='completed'?'已补课':x.status==='cancelled'?'补课已取消':'已安排补课')).join('')}</section>`:'';
}
function courseDetail(c){
 const s=studentBy(c.student_id),completed=c.status==='completed',cancelled=c.status==='cancelled',makeup=makeupLinks(c,state.courses);
 const fee=completed?feeHTML(c):estimatedFee(c,s)===0?'免费':money(estimatedFee(c,s));
 const duration=completed?c.actual_minutes:c.duration_minutes;
 const timing=c.start_time?c.start_time+(duration!=null?'–'+timeLabel(minutes(c.start_time)+duration):''):'时间待核对';
 const kv=(label,value)=>`<div><dt>${label}</dt><dd>${value}</dd></div>`;
 const rows=kv('状态',statusText(c.status))+(cancelled?'':kv(completed?'实际课时':'计划课时',hours(duration))+(completed&&c.actual_minutes!==c.duration_minutes?kv('原计划',hours(c.duration_minutes)):'')+kv(completed?'本次扣费':'预计课费',fee)+kv(s.balance_verified?'当前余额':'当前已记录余额',balanceHTML(s)));
 openDialog(`${esc(s?.name||'未知学生')} · ${esc(c.subject)}`,`<p class="detail-lead">${dateShort(c.date)} ${timing}${splitHistoryNotes(c.notes).inferred?' <span class="date-estimate">推测日期</span>':''}</p><dl class="key-values">${rows}</dl>${makeupHTML(c)}${c.conflict?notice('与其他课程时间重叠，请检查排期。','warning'):''}${c.needs_review?notice('历史信息尚未核对完整，待核对费用未计入确定账目。'):''}${historyNoteHTML(c.notes)}${c.source?`<details><summary>原始来源</summary><p class="source">${esc(c.source)}</p></details>`:''}<div class="dialog-actions">${cancelled?(makeup.active?'':button('makeup-course','安排补课',c.id,'primary')):completed?button('correct-course','更正课时 / 费用',c.id):button('complete-course',estimatedFee(c,s)===0?'确认已上课':'记课并扣费',c.id,'primary')}${button('edit-course','调整时间 / 备注',c.id)}${!cancelled?button('payment','记缴费',s.id):''}${button('open-student','学生账页',s.id)}</div><div class="dialog-actions">${cancelled?(makeup.active?'':button('reschedule-course','纠正误取消',c.id,'text-button')):completed?button('undo-course','撤销已上课',c.id,'text-button'):button('cancel-course','请假 / 取消',c.id)+(!c.source?button('delete-course','删除排课',c.id,'text-button danger'):'')}</div>`,null);
}

function completeForm(c,correct=false){
 const s=studentBy(c.student_id),settled=isSettledCourse(c),rate=correct?c.hourly_rate_cents:s?.rates?.[c.subject];
 openDialog(correct?'更正已完成课程':rate===0?'确认已上课':'记课并扣费',`<p class="detail-lead">${esc(s?.name)} · ${esc(c.subject)} <small>${dateShort(c.date)} ${c.start_time||''}</small></p>${!correct?button('course','课程详情 / 调课',c.id,'text-button'):''}<div class="form-grid">${field('实际时长（小时）',input('actual_hours','number',(c.actual_minutes??c.duration_minutes)/60,`required min="${c.source?'0.01':'1'}" max="24" step="${c.source?'any':'1'}"`))}<div class="hour-shortcuts actions"><button type="button" data-hours="1">1 小时</button><button type="button" data-hours="2">2 小时</button></div>${!correct?field('计价方式',`<span class="check"><input name="special_rate" type="checkbox">试听 / 本次特殊价格</span>`):''}<div class="rate-edit" ${correct?'':'hidden'}>${field('本次小时价（元）',input('rate','number',rate==null?'':rate/100,`required min="0" step="0.01" ${correct?'':'readonly'}`))}</div>${correct?'':`<p class="standard-rate">标准课价 <strong>${money(rate)} / 小时</strong></p>`}${noteField(c.notes)}</div>${c.source?`<details ${c.needs_review?'open':''}><summary>历史课程信息</summary><div class="form-grid">${field('日期（未知可留空）',input('date','date',c.date))}${field('开始时间（未知可留空）',input('start_time','time',c.start_time))}${field('科目',input('subject','text',c.subject,'required'))}</div><p class="source">${esc(c.source)}</p></details>`:''}${settled?notice('这节课已纳入历史余额核对。更正旧明细不会再次影响当前余额。'):''}<div id="completion-preview" class="completion-preview" aria-live="polite"></div>${!s?.balance_verified?notice('当前余额尚未核实，预览只反映已记录账目。'):''}${rate==null&&!correct?notice('该科目尚未设置单价，请先编辑学生档案。 '+button('edit-student','设置单价',s.id),'warning'):''}${c.needs_review?field('核对确认','<span class="check"><input type="checkbox" name="reviewed" required>已确认本次填写的时长和单价；未补齐的历史信息继续待核对</span>'):''}`,async f=>{
  const payload={status:'completed',actual_minutes:Math.round(Number(f.actual_hours)*60),notes:f.notes,hourly_rate_cents:Math.round(Number(f.rate)*100)};
  if(c.source)Object.assign(payload,{date:f.date||null,start_time:f.start_time||null,subject:f.subject});if(c.needs_review&&f.reviewed)payload.needs_review=false;
  const result=await api(`/courses/${c.id}`,'PATCH',payload);await refresh();
  if(correct){toast(settled?'旧账明细已更正，当前余额保持不变':result.needs_review?'已保存，仍有历史信息待核对':'已更正，余额已重新计算');return;}
  const after=studentBy(s.id);toast(`${s.name} · 已记 ${hours(payload.actual_minutes)}，${after.balance_cents<0?'欠费 '+money(-after.balance_cents):'余额 '+money(after.balance_cents)}`,async()=>{await api(`/courses/${c.id}`,'PATCH',{status:'scheduled',actual_minutes:c.actual_minutes,hourly_rate_cents:c.hourly_rate_cents});await refresh();});
 },correct?'保存更正':'确认扣费',false,`${correct?'correct':'complete'}:${c.id}`);
 const preview=()=>{const h=Number(dialog.querySelector('[name="actual_hours"]').value),rateValue=dialog.querySelector('[name="rate"]').value,r=Number(rateValue),cost=rateValue===''?null:Math.round(h*r*100),balance=settled?s.balance_cents:cost==null?null:s.balance_cents+(correct?(c.fee_cents||0):0)-cost;dialog.querySelector('#completion-preview').innerHTML=`<span>${h} 小时 × ${money(rateValue===''?null:Math.round(r*100))}</span><strong>${cost===0?'本次免费':`${correct?'更正后课费':'本次扣费'} ${money(cost)}`}</strong><span>${correct?'更正后':cost===0?'记课后':'扣费后'}${s.balance_verified?'余额':'已记录余额'} <b class="${balance<0?'negative':''}">${balance<0?'欠费 '+money(-balance):money(balance)}</b></span>${correct&&!settled&&c.fee_cents!=null&&cost!=null?`<span>原扣费 ${money(c.fee_cents)} · ${cost<c.fee_cents?'退回余额':'补扣'} ${money(Math.abs(cost-c.fee_cents))}</span>`:''}`;if(!correct)dialog.querySelector('[type="submit"]').textContent=cost===0?'确认已上课':'确认扣费';};
 const special=dialog.querySelector('[name="special_rate"]');if(special)special.onchange=()=>{const price=dialog.querySelector('[name="rate"]');price.readOnly=!special.checked;dialog.querySelector('.rate-edit').hidden=!special.checked;dialog.querySelector('.standard-rate').hidden=special.checked;if(!special.checked)price.value=rate==null?'':rate/100;dialog.querySelector('[type="submit"]').disabled=!special.checked&&rate==null;preview();};dialog.querySelectorAll('[data-hours]').forEach(b=>b.onclick=()=>{const hours=dialog.querySelector('[name="actual_hours"]');hours.value=b.dataset.hours;hours.dispatchEvent(new Event('input',{bubbles:true}));});dialog.querySelectorAll('input').forEach(i=>i.addEventListener('input',preview));preview();if(rate==null&&!correct)dialog.querySelector('[type="submit"]').disabled=true;
}
function rangeControls(){return `<div class="record-controls"><label>记录范围 <select id="record-mode">${option('recent','近 30 天',recordMode)}${option('all','全部记录',recordMode)}${state.periods.map(p=>option('period:'+p.id,periodLabel(p),recordMode)).join('')}${option('custom','自定义',recordMode)}</select></label>${recordMode!=='all'?`<label>从 <input id="record-start" type="date" value="${recordStart}"></label><label>至 <input id="record-end" type="date" value="${recordEnd}"></label>`:''}</div>`;}
const matchesRecordKind=e=>!recordKind||(recordKind==='receipts'?['payment','refund','receipt_correction'].includes(e.type):e.type===recordKind);
function recordTypeControls(){const ledger=studentTab==='ledger',value=ledger?recordKind:courseStatus,items=ledger?[['','全部流水'],['payment','缴费'],['course','扣费'],['refund','退款'],['receipts','收付款'],['receipt_correction','历史收款核对'],['adjustment','余额调整'],['settlement','余额确认']]:[['','全部课程'],['scheduled','待上课'],['completed','已上课'],['cancelled','已取消']];return `<label class="record-type">${ledger?'流水类型':'课程状态'} <select id="record-type">${items.map(([k,v])=>option(k,v,value)).join('')}</select></label>`;}
const inRecordRange=e=>recordMode==='all'||(e.date&&e.date>=recordStart&&e.date<=recordEnd);
let recordLimit=30;
function courseTable(courses){return courses.length?`<div class="table-scroll"><table><thead><tr><th>日期 / 科目</th><th>课时</th><th>状态</th><th class="number">课费</th><th></th></tr></thead><tbody>${courses.map(c=>`<tr><td>${esc(c.date||'日期待核对')}<small>${c.start_time||'时间待核对'} · ${esc(c.subject)}</small></td><td>${hours(displayMinutes(c))}</td><td><span class="status ${c.status}">${statusText(c.status)}</span>${c.needs_review?'<small>待核对</small>':''}</td><td class="number">${feeHTML(c)}</td><td>${button('course','查看',c.id,'text-button')}</td></tr>`).join('')}</tbody></table></div>`:empty('所选范围没有课程。');}
function accountTable(entries,undated=[],verified=true,compact=false){
 const all=[...entries,...(undated.length?[{divider:true},...undated]:[])];
 return `<div class="table-scroll"><table class="account-table"><thead><tr><th>日期 / 事项</th><th class="number">金额</th>${compact?'':`<th class="number">${verified?'结余':'已记录结余'}</th>`}<th></th></tr></thead><tbody>${all.map(e=>{
  if(e.divider)return `<tr class="record-divider"><th colspan="${compact?3:4}">未填日期</th></tr>`;
  const title=e.type==='course'?`${esc(e.record.subject)} · ${hours(e.record.actual_minutes)}`:({payment:'缴费',refund:'退款',adjustment:'余额调整',receipt_correction:'历史收款核对',settlement:'余额确认'}[e.type]);
  return `<tr><td><span class="record-title">${title}</span><small>${esc(e.date||'日期待补')}${splitHistoryNotes(e.notes).inferred?' · 推测':''}</small></td><td class="number ${e.amount<0?'negative':''}">${e.type==='settlement'?'—':e.amount==null?'待核对':`${e.amount>0?'+':''}${money(e.amount)}`}</td>${compact?'':`<td class="number ${e.balance<0?'negative':''}">${e.settled?'—':money(e.balance)}</td>`}<td>${button('entry-detail','详情',e.id,'text-button')}</td></tr>`;
 }).join('')}</tbody></table></div>`;
}
function historyNoteHTML(notes){
 const parts=splitHistoryNotes(notes);
 return `${parts.note?`<p class="preserve">${esc(parts.note)}</p>`:''}${parts.evidence?`<details class="history-evidence"><summary>历史核对依据</summary><p class="preserve muted">${esc(parts.evidence)}</p></details>`:''}`;
}
function entryDetail(id){
 const ledger=accountEntries(state,selectedStudent),e=[...ledger.dated,...ledger.undated].find(e=>e.id===id);
 if(!e)return;
 if(e.type==='course'){courseDetail(e.record);return;}
 const label={payment:'缴费',refund:'退款',adjustment:'余额调整',receipt_correction:'历史收款核对',settlement:'余额确认'}[e.type];
 openDialog(label,`<p class="detail-lead">${money(e.type==='settlement'?e.record.balance_cents:e.amount)}</p><dl class="key-values"><div><dt>日期</dt><dd>${esc(e.date||'待补充')}${splitHistoryNotes(e.notes).inferred?' <span class="date-estimate">推测日期</span>':''}</dd></div>${e.type==='settlement'?'<div><dt>类型</dt><dd>历史结余，不计入收款</dd></div>':''}</dl>${e.settled?'<p class="muted">已纳入历史余额核对。</p>':''}${historyNoteHTML(e.notes)}${e.source?`<details><summary>原始来源</summary><p class="source">${esc(e.source)}</p></details>`:''}${e.type==='settlement'?'':`<div class="dialog-actions">${e.type==='payment'&&e.amount>0?button('payment-receipt','复制回执',e.id,'primary'):''}${button('edit-payment','更正记录',e.id)}</div>`}`,null);
}
function studentProfile(s,pending){
 const settlement=s.settlement;
 return `<div class="profile-actions">${button('edit-student','编辑档案',s.id)}${button('reconcile','核对余额',s.id)}${button('student-reviews',`历史核对${pending.length?' · '+pending.length:''}`,s.id)}</div>${settlement?`<section class="profile-section"><h3>余额核对</h3><p>${settlement.confirmed_on} · 确认结余 ${money(settlement.balance_cents)}</p><p class="preserve muted">${esc(settlement.note)}</p></section>`:''}${s.notes?`<section class="profile-section"><h3>备注</h3><p class="preserve muted">${esc(s.balance_verified?s.notes.replace('历史导入，余额尚未核对','历史导入'):s.notes)}</p></section>`:''}${pending.length?`<p class="muted">${pending.length} 项历史资料待补，${s.balance_verified?'不影响已确认结余。':'余额仍需核实。'}</p>`:''}`;
}
function studentDetail(s){
 const ledger=accountEntries(state,s.id),courses=state.courses.filter(c=>c.student_id===s.id).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||(b.start_time||'').localeCompare(a.start_time||''));
 const pending=state.reviews.filter(r=>r.student_id===s.id&&r.status==='pending'),attention=attentionFor(s,state.courses);
 let content='';
 if(studentTab==='profile')content=studentProfile(s,pending);
 else if(studentTab==='overview'){
  const upcoming=courses.filter(c=>c.status==='scheduled'&&c.date>=today()).reverse().slice(0,1);
  const recent=[...ledger.dated.slice(-4).reverse(),...ledger.undated.filter(e=>!e.settled)].slice(0,5);
  const next=upcoming[0];
  const nextHTML=next?`<section class="next-lesson"><div><span class="muted">下一次课</span><strong>${dateShort(next.date)} <span>${next.start_time||'时间待定'}</span></strong><p>${esc(next.subject)} · ${hours(next.duration_minutes)} · 预计 ${money(estimatedFee(next,s))}</p></div><div class="actions">${button('course','查看课程',next.id)}${button('student-course','加一节课',s.id,'text-button')}</div></section>`:s.status==='active'?`<div class="next-empty"><span>暂无排课</span>${button('student-course','安排课程',s.id,'text-button')}</div>`:'';
  content=`${attention==='low'?'<p class="balance-hint negative">余额不足下一次课费</p>':''}${nextHTML}<div class="section-line"><h3>近期流水</h3>${button('all-student-records','查看全部','','text-button')}</div>${recent.length?accountTable(recent,[],s.balance_verified,true):'<p class="quiet-empty">暂无流水</p>'}`;
 }else{
  const pendingPeriod=state.periods.find(p=>recordMode==='period:'+p.id&&p.range_kind==='pending');
  const includeUndated=!pendingPeriod&&(recordMode==='all'||statsOrigin!==s.id);
  const dated=ledger.dated.filter(e=>inRecordRange(e)&&matchesRecordKind(e)).reverse(),undated=includeUndated?ledger.undated.filter(matchesRecordKind):[],filtered=courses.filter(c=>(!c.date?includeUndated:inRecordRange(c))&&(!courseStatus||c.status===courseStatus));
  content=`<div class="record-toolbar">${rangeControls()}${recordTypeControls()}</div>`+(recordStart>recordEnd&&recordMode!=='all'?notice('开始日期不能晚于结束日期。','warning'):'')+(studentTab==='ledger'?`<details class="record-help"><summary>记录说明</summary><p>有日期的记录按时间倒序显示；未填日期的记录单列。历史余额已核对的明细不重复影响当前余额，逐笔结余无法确定时不作推算。</p></details>${dated.length||undated.length?accountTable(dated.slice(0,recordLimit),undated,s.balance_verified):'<p class="quiet-empty">所选范围暂无流水</p>'}${dated.length>recordLimit?button('more-records',`再显示 30 条（共 ${dated.length} 条）`):''}`:courseTable(filtered.slice(0,recordLimit))+(filtered.length>recordLimit?button('more-records',`再显示 30 条（共 ${filtered.length} 条）`):''));
  if(pendingPeriod)content=`<div class="record-toolbar">${rangeControls()}</div>`+notice(`学期日期暂未确定，请设置日期或选择自定义范围。 ${button('edit-period','设置学期日期',pendingPeriod.id,'text-button')}`);
 }
 const credit=lessonCredit(s,state.courses);
 return `${statsOrigin===s.id?`<div class="stats-return">${button('return-stats','‹ 返回统计','','text-button')}<span>来自统计 · ${statsMode==='all'?'全部时间':statsStart+' — '+statsEnd}</span></div>`:''}<header class="student-detail-head"><div><div class="student-name"><h2>${esc(s.name)}</h2>${s.status!=='active'?`<span class="student-status">${statusText(s.status)}</span>`:''}${s.grade?`<span class="student-status">${esc(s.grade)}</span>`:''}</div><p class="student-rates">${Object.entries(s.rates||{}).map(([k,v])=>`${esc(k)} ${money(v)}/小时`).join(' · ')}</p></div></header><div class="balance-line"><div><span class="balance-label">${s.balance_verified?'账户余额':'已记录余额'}</span><strong class="balance-value">${balanceHTML(s)}${credit?`<small class="lesson-credit" title="按${esc(credit.subject)}常规每节${credit.duration/60}小时折算">（${credit.count}节课）</small>`:''}</strong></div><div class="actions">${button('payment','记缴费',s.id,'primary')}${button('statement','家长对账',s.id)}</div></div><div class="detail-tabs" aria-label="学生记录分类">${[['overview','概览'],['ledger','流水'],['courses','课程'],['profile','资料与核对']].map(([id,label])=>`<button data-action="student-tab" data-id="${id}" aria-pressed="${studentTab===id}">${label}</button>`).join('')}</div>${content}`;
}
function renderStudents(){
 const students=state.students.filter(s=>(!studentStatus||s.status===studentStatus)&&(!studentSearch||(s.name+' '+s.grade).includes(studentSearch))&&(!studentAttention||attentionFor(s,state.courses)===studentAttention));
 if(!students.some(s=>s.id===selectedStudent)){selectedStudent=students[0]?.id||'';studentTab='overview';}
 saveStudentLocation(plannerStorage,selectedStudent,studentTab);
 main.innerHTML=header('','学生账页',`${students.length} 位学生`,button('new-student','添加学生'))+`<div class="attention-filters"><button data-action="attention" data-id="" aria-pressed="${!studentAttention}">全部</button>${['debt','low','unverified'].map(k=>({key:k,count:state.students.filter(s=>(!studentStatus||s.status===studentStatus)&&(!studentSearch||(s.name+' '+s.grade).includes(studentSearch))&&attentionFor(s,state.courses)===k).length})).filter(x=>x.count||x.key===studentAttention).map(x=>`<button data-action="attention" data-id="${x.key}" aria-pressed="${studentAttention===x.key}">${attentionLabels[x.key]} <b>${x.count}</b></button>`).join('')}</div><div class="students-layout"><section class="student-index"><div class="student-controls"><label class="sr-only" for="student-search">搜索姓名或年级</label><input id="student-search" type="search" placeholder="搜索姓名或年级" value="${esc(studentSearch)}"><label class="sr-only" for="student-status">学生状态</label><select id="student-status">${option('','全部状态',studentStatus)}${['active','paused','archived'].map(s=>option(s,statusText(s),studentStatus)).join('')}</select><label class="sr-only" for="student-select">选择学生</label><select id="student-select">${students.map(s=>option(s.id,`${s.name} · ${s.balance_verified&&s.balance_cents<0?'欠费 '+money(-s.balance_cents):money(s.balance_cents)}${s.balance_verified?'':' · 待核对'}`,selectedStudent)).join('')}</select></div><div class="student-list">${students.map(s=>`<button class="student-row ${s.id===selectedStudent?'selected':''}" data-action="select-student" data-id="${esc(s.id)}"><span><strong>${esc(s.name)}</strong>${s.grade||s.status!=='active'?`<small>${[s.grade,s.status!=='active'?statusText(s.status):''].filter(Boolean).map(esc).join(' · ')}</small>`:''}</span><span class="student-balance">${balanceHTML(s)}${attentionFor(s,state.courses)==='low'?'<small class="negative">不足下次课费</small>':''}</span></button>`).join('')||empty('没有符合条件的学生。')}</div></section><section class="student-detail">${selectedStudent?studentDetail(studentBy(selectedStudent)):empty('添加学生后即可安排课程、记缴费。')}</section></div>`;
 document.querySelector('#student-search').oninput=e=>{studentSearch=e.target.value;const pos=e.target.selectionStart;renderStudents();const el=document.querySelector('#student-search');el.focus();el.setSelectionRange(pos,pos);};
 document.querySelector('#student-status').onchange=e=>{studentStatus=e.target.value;render();};
 document.querySelector('#student-select').onchange=e=>{statsOrigin='';recordKind='';courseStatus='';selectedStudent=e.target.value;studentTab='overview';recordLimit=30;render();window.scrollTo(0,0);};
 const type=document.querySelector('#record-type');if(type)type.onchange=e=>{if(studentTab==='ledger')recordKind=e.target.value;else courseStatus=e.target.value;recordLimit=30;render();};
 const mode=document.querySelector('#record-mode');if(mode)mode.onchange=e=>{recordMode=e.target.value;recordLimit=30;if(recordMode==='recent'){recordStart=addDays(today(),-30);recordEnd=today();}else if(recordMode.startsWith('period:')){const p=state.periods.find(p=>p.id===recordMode.slice(7));recordStart=p.start;recordEnd=p.end;}render();};
 for(const key of ['start','end']){const el=document.querySelector('#record-'+key);if(el)el.onchange=e=>{if(key==='start')recordStart=e.target.value||today();else recordEnd=e.target.value||today();recordMode='custom';recordLimit=30;render();};}
}
function studentForm(s=null){
 const subjects=[...new Set(['数学','物理',...Object.keys(s?.rates||{})])],chosen=s?Object.keys(s.rates||{}):['数学'];
 openDialog(s?'编辑学生档案':'添加学生',`<div class="form-grid">${field('姓名',input('name','text',s?.name||'','required maxlength="80"'))}${field('年级',input('grade','text',s?.grade||'','maxlength="80"'))}${field('状态',`<select name="status">${['active','paused','archived'].map(v=>option(v,statusText(v),s?.status||'active')).join('')}</select>`)}${field('常规课长（小时 / 节）',input('default_duration_hours','number',regularDuration(s)/60,'required min="1" max="24" step="1"'))}</div><fieldset class="subject-fields"><legend>学习科目与小时价</legend><p class="muted small">勾选实际学习的科目，再填写价格。</p>${subjects.map((subject,i)=>`<div class="subject-rate"><label class="check"><input name="subject_${i}" type="checkbox" value="${esc(subject)}" ${chosen.includes(subject)?'checked':''}>${esc(subject)}</label>${field(`${esc(subject)}小时价（元）`,input('rate_'+i,'number',s?.rates?.[subject]==null?'':s.rates[subject]/100,`min="0" step="0.01" ${chosen.includes(subject)?'required':'disabled'}`))}</div>`).join('')}</fieldset>${field('备注',`<textarea name="notes" rows="2">${esc(s?.notes||'')}</textarea>`)}<p class="muted small">调价用于今后确认的课程，已完成课费保留当时价格。</p>`,async f=>{
  const rates={};subjects.forEach((subject,i)=>{if(f['subject_'+i])rates[subject]=Math.round(Number(f['rate_'+i])*100);});if(!Object.keys(rates).length)throw new Error('请至少选择一个学习科目。');
  const result=await api(s?`/students/${s.id}`:'/students',s?'PATCH':'POST',{name:f.name.trim(),grade:f.grade,status:f.status,notes:f.notes,rates,default_duration_minutes:Number(f.default_duration_hours)*60});selectedStudent=result.id;studentSearch='';studentAttention='';studentStatus=result.status;await refresh();toast('学生档案已保存');
 },'保存',false,`student:${s?.id||'new'}`);
 dialog.querySelectorAll('[name^="subject_"]').forEach(el=>el.onchange=()=>{const rate=dialog.querySelector('[name="rate_'+el.name.split('_')[1]+'"]');rate.disabled=!el.checked;rate.required=el.checked;});
}
function paymentReceiptForm(text,title='缴费已记录'){
 openDialog(title,`<p class="muted small">可复制下面的回执，粘贴给家长。</p>${field('收款回执',`<textarea id="payment-receipt" readonly rows="4">${esc(text)}</textarea>`)}<div class="actions"><button type="button" id="copy-receipt" class="primary">复制收款回执</button></div>`,null);
 dialog.querySelector('#copy-receipt').onclick=async()=>{try{await navigator.clipboard.writeText(text);toast('回执已复制，可粘贴给家长');}catch{dialog.querySelector('#payment-receipt').select();const err=dialog.querySelector('.form-error');err.textContent='请复制已选中的回执文字。';err.hidden=false;}};
}
async function cancelCourseForm(c){
 let preview=null,revision=0;
 openDialog('请假 / 停课',`<p class="detail-lead">${esc(studentBy(c.student_id)?.name)} · ${dateShort(c.date)}</p>${field('停课范围',`<select name="scope">${option('one','仅本次','one')}${option('range','该学生指定日期内的待上课程','one')}${c.series_id?option('following','本次及以后同系列待上课程','one'):''}</select>`)}<div class="form-grid" id="cancel-dates" hidden>${field('从',input('start','date',c.date||today(),'required'))}${field('至',input('end','date',c.date||today(),'required'))}</div>${field('请假原因（选填）','<textarea name="reason" rows="2" placeholder="例如：临时有事，下周再约"></textarea>')}<div id="cancel-preview" aria-live="polite"></div>`,async()=>{
  if(!preview?.count)throw new Error('没有可停课的课程。');
  const result=await api(`/courses/${c.id}/cancel`,'POST',params());await refresh();toast(`已停课 ${result.count} 节，不扣课费`);
 },'确认停课');
 const form=dialog.querySelector('form'),submit=form.querySelector('[type="submit"]');
 const params=()=>{const f=Object.fromEntries(new FormData(form));return {scope:f.scope,reason:f.reason||'',...(f.scope==='range'?{start:f.start,end:f.end}:{})};};
 const update=async()=>{const n=++revision;preview=null;submit.disabled=true;const range=form.querySelector('[name="scope"]').value==='range';form.querySelector('#cancel-dates').hidden=!range;form.querySelectorAll('#cancel-dates input').forEach(el=>el.disabled=!range);const body=params(),area=form.querySelector('#cancel-preview');area.textContent='正在检查课程…';
  try{const result=await api(`/courses/${c.id}/cancel`,'POST',{...body,preview:true});if(n!==revision||dialog.querySelector('form')!==form)return;preview=result;
   area.innerHTML=`<section class="change-preview"><h3>${result.count?'将停课 '+result.count+' 节':'没有可停课的课程'}</h3><p class="muted small">${body.scope==='range'?'包含该学生在此日期范围内的所有科目和排课。':''}已完成课程保留，停课不扣费。</p><div class="preview-list">${result.courses.map(x=>`<article><strong>${dateShort(x.date)} ${x.start_time||'时间待定'}</strong><span>${esc(x.subject)} · ${hours(x.duration_minutes)}</span></article>`).join('')}</div></section>`;submit.disabled=!result.count;
  }catch(err){if(n===revision&&dialog.querySelector('form')===form)area.textContent=err.message;}
 };
 form.querySelectorAll('select,input').forEach(el=>el.onchange=update);await update();
}
async function localBackupForm(){
 let selected=null,revision=0;
 openDialog('从本机备份恢复',`<p class="muted small">选择备份后，先核对记录数量。</p>${field('备份时间','<select name="backup" disabled><option value="">正在读取…</option></select>')}<div id="local-backup-preview" aria-live="polite"></div><div id="local-backup-confirm" hidden>${notice('恢复将替换当前账本，操作前会自动备份现有记录。')}${field('确认恢复',input('confirmation','text','','placeholder="请输入：覆盖恢复" autocomplete="off"'))}</div>`,async f=>{
  if(!selected)throw new Error('请先选择有效备份。');if(f.confirmation!=='覆盖恢复')throw new Error('请输入“覆盖恢复”以确认。');
  await mutate(`/backups/${encodeURIComponent(selected.filename)}/restore`,'POST',{},'本机备份已恢复');formDrafts.clear();selectedStudent='';render();
 },'覆盖并恢复');
 const form=dialog.querySelector('form'),select=form.querySelector('[name="backup"]'),submit=form.querySelector('[type="submit"]'),area=form.querySelector('#local-backup-preview');submit.disabled=true;
 select.onchange=async()=>{const n=++revision;selected=null;submit.disabled=true;form.querySelector('#local-backup-confirm').hidden=true;form.querySelector('[name="confirmation"]').value='';area.textContent=select.value?'正在读取备份…':'';if(!select.value)return;
  try{const b=await api(`/backups/${encodeURIComponent(select.value)}/preview`);if(n!==revision||dialog.querySelector('form')!==form)return;selected=b;
   area.innerHTML=`<section class="backup-preview"><h3>${esc(readableTime(b.created_at))}</h3><dl class="key-values">${[['students','学生','位'],['courses','课程','节'],['payments','收付款','笔']].map(([key,label,unit])=>`<div><dt>${label}</dt><dd>${b.counts[key]} ${unit}（当前 ${state[key].length} ${unit}）</dd></div>`).join('')}</dl></section>`;form.querySelector('#local-backup-confirm').hidden=false;submit.disabled=false;
  }catch(err){if(n===revision&&dialog.querySelector('form')===form)area.textContent=err.message;}
 };
 try{const result=await api('/backups');if(dialog.querySelector('form')!==form)return;select.innerHTML=option('','请选择备份','')+result.backups.map(b=>option(b.filename,`${b.created_at.replace('T',' ')} · ${Math.max(1,Math.round(b.size_bytes/1024))} KB`,'')).join('');select.disabled=!result.backups.length;if(!result.backups.length)area.textContent='暂无本机自动备份。';}
 catch(err){if(dialog.querySelector('form')===form)area.textContent=err.message;}
}

function paymentForm(studentId=null,p=null){
 if(!state.students.length){studentForm();return;}
 const selected=studentId||'';
 const matching=p?.source?state.reviews.filter(r=>r.status==='pending'&&r.kind==='payment_date_missing'&&r.student_id===p.student_id&&r.source===p.source):[];
 const unique=p&&state.payments.filter(x=>x.student_id===p.student_id&&x.source===p.source).length===1;
 const allowUnknown=p&&(p.source||!p.date),settled=isSettledPayment(p);
 openDialog(p?.kind==='receipt_correction'?'更正历史收款核对':p?'更正缴费记录':'记缴费',`${studentId?`<p class="detail-lead">${esc(studentBy(studentId)?.name)}</p>`:''}<div class="form-grid">${studentId?'':studentPicker(selected)}${field('类型',`<select name="kind">${p?.kind==='receipt_correction'?option('receipt_correction','历史收款核对',p.kind):option('payment','缴费',p?.kind||'payment')+option('refund','退款',p?.kind||'payment')}${p?.kind==='adjustment'?option('adjustment','余额调整',p.kind):''}</select>`)}${field('日期',input('date','date',p?(p.date||''):today(),p&&!p.date?'disabled':'required'))}${allowUnknown?field('历史日期','<span class="check"><input name="date_unknown" type="checkbox" '+(!p.date?'checked':'')+'>日期尚未核实</span>','full'):''}${field('金额（元）',input('amount','number',p?(p.kind==='receipt_correction'?p.amount_cents:Math.abs(p.amount_cents))/100:'',`required ${p?.kind==='receipt_correction'?'':`min="${p?.kind==='adjustment'?'0':'0.01'}"`} step="0.01"`))}${noteField(p?.notes||'')}</div><div id="payment-preview" class="completion-preview" aria-live="polite"></div>${p&&!p.date?notice('这是一笔日期未知的历史款项。只改金额或备注会保留未知日期，不计入某月收款。'):''}${matching.length&&unique?notice(`补齐日期后，将同时完成对应的 ${matching.length} 条缴费日期核对。`):''}${p?.kind==='adjustment'?notice('余额调整保持原有正负方向，不计入实际收款。'):''}${p?.kind==='receipt_correction'?notice('正数补足历史收款，负数扣除多计部分；核对依据见备注。'):''}${p?.source?`<details><summary>原始来源</summary><p class="source">${esc(p.source)}</p></details>`:''}${settled?notice('此款项已纳入历史余额核对，更正金额或日期只补充旧明细，当前余额保持不变。'):''}${p&&!settled?`<div class="dialog-actions">${button('delete-payment','删除此笔记录',p.id,'text-button danger')}</div>`:''}`,async f=>{
  const sid=studentId||f.student_id,sign=p?.kind==='adjustment'&&p.amount_cents<0?-1:1;
  const payload={student_id:sid,date:f.date_unknown?null:f.date,kind:f.kind,amount_cents:Math.round(Number(f.amount)*100)*sign,notes:f.notes};
  if(payload.date&&matching.length&&unique)payload.review_ids=matching.map(r=>r.id);
  const saved=await mutate(p?`/payments/${p.id}`:'/payments',p?'PATCH':'POST',payload,settled?'历史款项已保存，当前余额保持不变':'款项已保存，余额已更新');
  if(!p&&saved.kind==='payment'){const receipt=buildPaymentReceipt(saved,studentBy(sid),state.courses);if(receipt)return ()=>paymentReceiptForm(receipt);}
 },'保存',false,`payment:${p?.id||studentId||'new'}`);
 const preview=()=>{const f=Object.fromEntries(new FormData(dialog.querySelector('form'))),s=studentBy(studentId||f.student_id),amount=Number(f.amount||0)*100,delta=f.kind==='refund'?-amount:(p?.kind==='adjustment'&&p.amount_cents<0?-amount:amount),balance=settled?s.balance_cents:(s?.balance_cents||0)-(p?.amount_cents||0)+Math.round(delta);if(!s){dialog.querySelector('#payment-preview').innerHTML='<span>选择学生后查看余额变化</span>';return;}dialog.querySelector('#payment-preview').innerHTML=`<span>${esc(s?.name||'请选择学生')} · 当前${s?.balance_verified?'余额':'已记录余额'} ${money(s?.balance_cents)}</span><strong>保存后${s?.balance_verified?'':'已记录'}${balance<0?'欠费 '+money(-balance):'余额 '+money(balance)}</strong>`;};
 bindStudentPicker(preview);dialog.querySelectorAll('[name="amount"],[name="kind"]').forEach(el=>el.oninput=preview);
 const unknown=dialog.querySelector('[name="date_unknown"]');if(unknown)unknown.onchange=()=>{const date=dialog.querySelector('[name="date"]');date.disabled=unknown.checked;date.required=!unknown.checked;if(unknown.checked)date.value='';};preview();
}
function reconcileForm(s){
 const blocked=state.courses.filter(c=>c.student_id===s.id&&c.status==='completed'&&c.fee_cents==null&&!isSettledCourse(c));
 if(blocked.length){openDialog('先核对影响余额的课程',`<p>${esc(s.name)} 有 <strong>${blocked.length} 节已上课</strong> 的费用尚未确定，补齐后才能确认余额。</p>${notice('当前已记录余额不能代表实际余额。请补充已知信息；未知日期、时长和价格继续保留，不需要猜填。')}<div class="blocking-list">${blocked.slice(0,12).map(c=>`<div><span>${dateShort(c.date)} · ${esc(c.subject)}</span>${button('correct-course','核对这节课',c.id)}</div>`).join('')}</div>${button('student-reviews','查看全部核对事项',s.id)}${!s.settlement?`<hr><p>如果已有明确的结余或欠费依据，可保留未知明细，按已核实余额继续记新账。</p>${button('settle-history','按已知余额结转',s.id)}`:''}`,null);return;}
 openDialog('核对学生余额',`<p class="detail-lead">${esc(s.name)}</p>${notice('按家长确认或完整账本填写当前余额。系统记录差额调整，保留历史课程和缴费。')}<p>当前已记录余额：${money(s.balance_cents)}</p>${!s.settlement?button('settle-history','按已知余额结转',s.id):''}<div class="form-grid">${field('核对后的余额（元）',input('balance','number',s.balance_cents/100,'required step="0.01"'))}${field('核对依据',`<textarea name="note" required rows="3" placeholder="与家长核对至哪一天，依据是什么">${''}</textarea>`,'full')}</div>`,async f=>mutate(`/students/${s.id}/reconcile`,'POST',{balance_cents:Math.round(Number(f.balance)*100),note:f.note},'余额已核对'),'确认余额');
}
function settleHistoryForm(s){
 const courses=state.courses.filter(c=>c.student_id===s.id&&c.status!=='scheduled'&&(!c.date||c.date<=today()));
 const payments=state.payments.filter(p=>p.student_id===s.id&&(!p.date||p.date<=today()));
 openDialog('核对历史结余',`<p class="detail-lead">${esc(s.name)}</p><p>纳入现有 ${courses.filter(c=>c.status==='completed').length} 节已上课、${courses.filter(c=>c.status==='cancelled').length} 条未上记录和 ${payments.length} 笔款项。未来课程不纳入。</p>${notice('按原表结转或明确核对结果填写：有余额填正数，欠费填负数，全部结清填0。保留历史明细和未知信息，不补造缴费。以后更正本次范围内的旧明细不再改变当前余额。')}${field('确认结余（元）',input('balance','number','','required step="0.01" placeholder="余额为正，欠费为负，结清填0"'))}${field('核对依据','<textarea name="note" required rows="3" placeholder="记录原表结转如何计算，或谁确认了这个结余"></textarea>')}`,async f=>mutate(`/students/${s.id}/settle-history`,'POST',{balance_cents:Math.round(Number(f.balance)*100),course_ids:courses.map(c=>c.id),payment_ids:payments.map(p=>p.id),note:f.note},'历史余额已核对，后续从确认结余继续计算'),'确认历史结余');
}
function renderReviews(){
 const pending=state.reviews.filter(r=>r.status==='pending');
 const filtered=state.reviews.filter(r=>r.status===reviewStatus&&(reviewScope==='all'||(reviewScope==='current')===impactsCurrentAccount(r,state.students,state.courses))&&(!reviewStudent||r.student_id===reviewStudent)&&(!reviewType||reviewCategory(r)===reviewType)).sort((a,b)=>(studentBy(a.student_id)?.name||'').localeCompare(studentBy(b.student_id)?.name||'','zh-CN'));
 const pages=Math.max(1,Math.ceil(filtered.length/15));reviewPage=Math.min(reviewPage,pages-1);
 const page=filtered.slice(reviewPage*15,reviewPage*15+15),groups=new Map();for(const r of page){const key=r.student_id||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
 main.innerHTML=header('','历史核对',`${pending.filter(r=>impactsCurrentAccount(r,state.students,state.courses)).length} 项影响当前账目`)+`<div class="review-toolbar"><label>范围 <select id="review-scope">${option('current','影响当前账目',reviewScope)}${option('history','历史资料',reviewScope)}${option('all','全部记录',reviewScope)}</select></label><label>学生 <select id="review-student">${studentOptions(reviewStudent,true)}</select></label><label>问题类型 <select id="review-type">${option('','全部问题',reviewType)}${['日期','课时','费用','款项','其他'].map(t=>option(t,t,reviewType)).join('')}</select></label><label>处理状态 <select id="review-status">${option('pending','待核对',reviewStatus)}${option('resolved','已处理',reviewStatus)}</select></label></div><p class="muted small">历史资料保留在账本中，可随时查看处理依据。</p>${page.length?[...groups].map(([sid,rows])=>`<section class="review-group"><div class="section-line"><h2>${esc(studentBy(sid)?.name||'其他历史记录')}</h2>${sid?button('open-student','学生账页',sid,'text-button'):''}</div>${rows.map(reviewRow).join('')}</section>`).join(''):empty('没有符合条件的核对事项。')}${pages>1?`<div class="pagination">${button('review-prev','上一页','','') }<span>第 ${reviewPage+1} / ${pages} 页 · ${filtered.length} 项</span>${button('review-next','下一页')}</div>`:''}`;
 if(pages>1){main.querySelector('[data-action="review-prev"]').disabled=reviewPage===0;main.querySelector('[data-action="review-next"]').disabled=reviewPage>=pages-1;}
 document.querySelector('#review-scope').onchange=e=>{reviewScope=e.target.value;reviewPage=0;render();};
 for(const key of ['student','type','status'])document.querySelector('#review-'+key).onchange=e=>{if(key==='student')reviewStudent=e.target.value;else if(key==='type')reviewType=e.target.value;else reviewStatus=e.target.value;reviewPage=0;render();};
}
function matchingPayment(r){if(r.kind!=='payment_date_missing'||!r.source)return null;const matches=state.payments.filter(p=>p.student_id===r.student_id&&p.source===r.source);return matches.length===1?matches[0]:null;}
function reviewRow(r){const c=courseBy(r.course_id),p=matchingPayment(r);return `<article class="review-row"><div class="review-head"><span class="review-kind">${reviewCategory(r)}</span><strong>${esc(r.message)}</strong></div><details><summary>原始记录与核对依据</summary><p class="source">${esc(r.source||'未提供来源')}</p>${r.resolution?`<p class="preserve">${esc(r.resolution)}</p>`:''}</details><div class="actions">${c?button(r.status==='resolved'?'course':c.status==='completed'?'correct-course':'edit-course',r.status==='resolved'?'查看课程':'补充课程信息',c.id):p?r.status==='resolved'?button('student-ledger','查看流水',p.student_id):button('edit-payment','补充缴费日期',p.id):r.student_id?button('student-ledger','查看学生流水',r.student_id):''}${button('review',r.status==='pending'?'记录核对结果':'查看处理结果',r.id,'text-button')}</div></article>`;}
function reviewForm(r){openDialog('记录核对结果',`<p>${esc(r.message)}</p><details><summary>原始来源</summary><p class="source">${esc(r.source)}</p></details><div class="form-grid">${field('处理状态',`<select name="status">${option('pending','仍待核对',r.status)}${option('resolved','已核对处理',r.status)}</select>`)}${field('核对依据',`<textarea name="resolution" rows="3" required>${esc(r.resolution)}</textarea>`,'full')}</div><p class="muted small">请先补充对应记录，再标记处理。此处不修改课程或款项。</p>`,async f=>mutate(`/reviews/${r.id}`,'PATCH',f,'核对结果已保存'));}
function readableTime(value){const d=new Date(value);return value&&!Number.isNaN(d.getTime())?new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d):'未记录';}
function renderSettings(){
 const pendingPeriods=state.periods.filter(p=>p.range_kind==='pending');
 const periods=state.periods.filter(p=>p.range_kind!=='pending').sort((a,b)=>b.start.localeCompare(a.start));
 const relevant=periods.filter(p=>p.start<=today()&&(p.end>=today()||p.range_kind==='coverage'));
 const current=relevant[0]||periods.find(p=>p.start>=today());
 const former=periods.filter(p=>p.id!==current?.id);
 const row=p=>`<div class="setting-row"><div><strong>${esc(p.name.replace(/课表$/,''))}</strong><small>${p.range_kind==='coverage'?'学期日期待定 · 已录入 ':''}${p.start} — ${p.end}</small>${p.range_kind!=='coverage'&&p.source_start?`<small>原表覆盖 ${p.source_start} — ${p.source_end}</small>`:''}</div><div class="actions">${button('edit-period',p.range_kind==='coverage'?'设置学期日期':'编辑',p.id,'text-button')}<details class="row-more"><summary aria-label="${esc(p.name)}更多操作">更多</summary>${button('delete-period','删除范围',p.id,'text-button danger')}</details></div></div>`;
 main.innerHTML=header('','设置','学期与本地备份')+`<section class="settings-section"><div class="section-title"><h2>数据与备份</h2></div><div class="settings-content"><dl class="key-values"><div><dt>最近备份</dt><dd>${esc(readableTime(state.meta.last_backup_at))}</dd></div></dl><div class="actions">${button('backup','下载备份','','primary')}${button('local-backups','从本机备份恢复')}${button('restore','从备份文件恢复')}</div><details class="data-location compact-details"><summary>本地数据位置</summary><p class="path">${esc(state.meta.data_dir)}</p></details></div></section><section class="settings-section"><div class="section-title"><h2>当前学期</h2></div><div class="settings-content">${current?row(current):'<p class="muted">暂无当前学期。</p>'}${pendingPeriods.map(p=>`<div class="setting-row"><div><strong>${esc(p.name)}</strong><small>日期暂未确定</small></div><div class="actions">${button('edit-period','设置学期日期',p.id,'text-button')}${button('delete-period','删除',p.id,'text-button')}</div></div>`).join('')}${button('new-period','添加学期')}${former.length?`<details class="past-periods"><summary>其他学期与历史范围 · ${former.length} 个</summary>${former.map(row).join('')}</details>`:''}</div></section><section class="settings-section"><div class="section-title"><h2>历史资料</h2></div><div class="settings-content">${button('history-reviews','历史核对')}${state.reviews.some(r=>r.status==='pending'&&impactsCurrentAccount(r,state.students,state.courses))?'<p class="small negative">有待核对事项影响当前账目</p>':''}</div></section><p class="version">课时簿 ${esc(state.meta.app_version)} · 本地使用</p>`;
}
function statementForm(id){
 let doc=null;
 const activity=[...accountEntries(state,id).dated].filter(e=>e.type!=='settlement'&&e.date<=today()),latestActivity=activity.at(-1);
 const initialStart=today().slice(0,7)+'-01',initialEnd=today(),latestPayment=state.payments.filter(p=>p.student_id===id&&p.kind==='payment'&&p.date&&p.date<=today()).sort((a,b)=>b.date.localeCompare(a.date))[0];
 openDialog('家长对账',`<div class="statement-toolbar"><div class="statement-ranges actions"><button type="button" id="statement-month">本月</button>${latestPayment?'<button type="button" id="statement-payment">最近缴费起</button>':''}</div><div class="statement-dates">${field('从',input('start','date',initialStart,'required'))}${field('至',input('end','date',initialEnd,'required'))}</div><div class="actions"><button type="button" id="copy-statement">复制文字</button><button type="button" id="print-statement">打印 / PDF</button></div></div><div id="statement-empty-action" class="statement-empty-action" hidden><span>所选期间没有上课或收付款记录。</span>${latestActivity?'<button type="button" id="statement-latest">查看最近有记录的月份</button>':''}</div><iframe id="statement-preview" title="家长对账预览" sandbox="allow-same-origin allow-modals"></iframe>`,null,'',true);
 const update=()=>{const start=dialog.querySelector('[name="start"]').value,end=dialog.querySelector('[name="end"]').value,error=dialog.querySelector('.form-error');try{doc=buildStatement(state,id,start,end);dialog.querySelector('#statement-preview').srcdoc=doc.html;error.hidden=true;}catch(e){doc=null;error.textContent=e.message;error.hidden=false;}dialog.querySelector('#copy-statement').disabled=!doc;dialog.querySelector('#print-statement').disabled=!doc;dialog.querySelector('#statement-empty-action').hidden=!doc||doc.entries.some(e=>e.type!=='settlement');};
 dialog.querySelectorAll('input').forEach(el=>el.onchange=update);
 const latestButton=dialog.querySelector('#statement-latest');if(latestButton)latestButton.onclick=()=>{const start=latestActivity.date.slice(0,7)+'-01',last=new Date(start+'T12:00:00');last.setMonth(last.getMonth()+1);last.setDate(0);dialog.querySelector('[name="start"]').value=start;dialog.querySelector('[name="end"]').value=dateKey(last)<today()?dateKey(last):today();update();};
 dialog.querySelector('#statement-month').onclick=()=>{dialog.querySelector('[name="start"]').value=initialStart;dialog.querySelector('[name="end"]').value=initialEnd;update();};if(latestPayment)dialog.querySelector('#statement-payment').onclick=()=>{dialog.querySelector('[name="start"]').value=latestPayment.date;dialog.querySelector('[name="end"]').value=today();update();};
 dialog.querySelector('#copy-statement').onclick=async()=>{try{await navigator.clipboard.writeText(doc.text);toast('对账文字已复制，可粘贴给家长');}catch{const error=dialog.querySelector('.form-error');error.textContent='复制未获浏览器允许，请在下方预览中选中文字复制。';error.hidden=false;}};
 dialog.querySelector('#print-statement').onclick=()=>{const frame=dialog.querySelector('#statement-preview');frame.contentWindow.focus();frame.contentWindow.print();};update();
}
function openStudent(id,tab='overview'){statsOrigin='';recordKind='';courseStatus='';selectedStudent=id;studentSearch='';studentAttention='';studentStatus=studentBy(id)?.status||'active';studentTab=tab;recordLimit=30;if(dialog.open)closeDialog();if(route==='students')render();else location.hash='students';}
async function handleAction(action,id,el){
 const c=courseBy(id);
 switch(action){
 case'all-reviews':reviewScope='all';reviewStudent='';reviewType='';reviewPage=0;location.hash='reviews';break;
 case'global-payment':paymentForm(contextualStudentId(route,{selectedStudent,filterStudent,statsStudent},state.students));break;
 case'new-course':courseForm();break;case'day-course':courseForm(null,{date:id});break;case'slot':courseForm(null,{date:el.dataset.date,start_time:el.dataset.time});break;
 case'course':courseDetail(c);break;case'edit-course':courseForm(c);break;case'complete-course':completeForm(c);break;case'correct-course':completeForm(c,true);break;
 case'cancel-course':await cancelCourseForm(c);break;
 case'undo-course':confirmAction('撤销上课确认',`<p>${isSettledCourse(c)?'这节课已纳入历史余额核对，更正状态不会退回余额。':'恢复为待上课，退回已扣课费 '+money(c.fee_cents)+'。'}</p>`,()=>mutate(`/courses/${id}`,'PATCH',{status:'scheduled'},'已撤销上课确认'),'撤销确认');break;
 case'reschedule-course':await mutate(`/courses/${id}`,'PATCH',{status:'scheduled'});closeDialog();break;
 case'delete-course':confirmAction('删除这次排课',`<p>删除 ${esc(studentBy(c.student_id)?.name)} ${dateShort(c.date)} 的待上课程。其他重复课程保持原样。</p>`,()=>mutate(`/courses/${id}`,'DELETE',undefined,'排课已删除'),'删除排课');break;
 case'copy-week':await copyWeekForm();break;
 case'view-list':case'view-week':case'view-month':view=action.slice(5);savePlannerView(plannerStorage,view);render();break;
 case'prev':case'next':{const n=action==='prev'?-1:1;if(view!=='month')anchor=addDays(anchor,7*n);else{const d=new Date(`${anchor.slice(0,7)}-01T12:00:00`);d.setMonth(d.getMonth()+n);anchor=dateKey(d);}render();break;}
 case'today':anchor=today();render();break;case'toggle-filters':showFilters=!showFilters;render();break;
 case'agenda-today':agendaMode='today';render();break;case'agenda-pending':agendaMode='pending';render();break;
 case'new-student':studentForm();break;case'edit-student':studentForm(studentBy(id));break;
 case'select-student':statsOrigin='';recordKind='';courseStatus='';selectedStudent=id;studentTab='overview';recordLimit=30;render();window.scrollTo(0,0);break;
 case'stats-ledger':case'stats-courses':case'stats-receipts':case'stats-adjustments':{openStudent(id,action==='stats-courses'?'courses':'ledger');statsOrigin=id;recordMode=statsMode==='all'?'all':'custom';recordStart=statsStart;recordEnd=statsEnd;courseStatus=action==='stats-courses'?'completed':'';recordKind=action==='stats-receipts'?'receipts':action==='stats-adjustments'?'adjustment':'';if(route==='students')render();break;}
 case'return-stats':statsOrigin='';location.hash='stats';break;
 case'open-student':openStudent(id);break;case'student-ledger':openStudent(id,'ledger');recordMode='all';render();break;
 case'all-student-records':studentTab='ledger';recordMode='all';recordKind='';recordLimit=30;statsOrigin='';render();break;
 case'student-tab':studentTab=id;recordLimit=30;render();break;case'more-records':recordLimit+=30;render();break;
 case'attention':studentAttention=id||'';render();break;
 case'makeup-course':if(c?.status==='cancelled')courseForm(null,{student_id:c.student_id,subject:c.subject,date:'',start_time:c.start_time||'18:00',duration_minutes:regularDuration(studentBy(c.student_id)),notes:'',makeupFor:c});break;
 case'student-course':courseForm(null,{student_id:id,date:today()});break;
 case'payment':paymentForm(id);break;
 case'payment-receipt':{const p=state.payments.find(p=>p.id===id),text=buildPaymentReceipt(p,studentBy(p?.student_id),state.courses);if(text)paymentReceiptForm(text,'缴费回执');break;}case'edit-payment':{const p=state.payments.find(p=>p.id===id);paymentForm(p.student_id,p);break;}
 case'delete-payment':confirmAction('删除缴费记录','<p>此笔记录将从流水移除，学生余额随之重新计算。</p>',()=>mutate(`/payments/${id}`,'DELETE',undefined,'缴费记录已删除'),'删除记录');break;
 case'reconcile':reconcileForm(studentBy(id));break;case'settle-history':settleHistoryForm(studentBy(id));break;
 case'student-reviews':reviewScope='all';reviewStudent=id;reviewType='';reviewStatus='pending';reviewPage=0;if(dialog.open)closeDialog();if(route==='reviews')render();else location.hash='reviews';break;
 case'review':reviewForm(state.reviews.find(r=>r.id===id));break;case'review-prev':reviewPage--;render();window.scrollTo(0,0);break;case'review-next':reviewPage++;render();window.scrollTo(0,0);break;
 case'statement':statementForm(id);break;case'entry-detail':entryDetail(id);break;
 case'new-period':periodForm();break;case'edit-period':periodForm(state.periods.find(p=>p.id===id));break;case'delete-period':confirmAction('删除学期范围','<p>删除范围不会影响课程和账目。</p>',()=>mutate(`/periods/${id}`,'DELETE'),'删除范围');break;
 case'backup':{const backup=await api('/backup'),url=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`课时簿备份-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);await refresh();toast('已生成备份下载');break;}
 case'local-backups':await localBackupForm();break;case'restore':restoreForm();break;case'history-reviews':reviewScope='current';reviewStatus='pending';reviewPage=0;location.hash='reviews';break;case'retry':await refresh();break;
 }
}
document.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el)return;try{await handleAction(el.dataset.action,el.dataset.id,el);}catch(err){if(dialog.open){const error=dialog.querySelector('.form-error');error.textContent=err.message;error.hidden=false;}else toast(err.message);}});
window.addEventListener('hashchange',()=>{route=location.hash.slice(1)||'schedule';render();window.scrollTo(0,0);main.focus({preventScroll:true});});
setStatsRange('month');
refresh().catch(err=>{main.innerHTML=header('','课时簿暂时无法打开','本地记录仍保存在这台 Mac。')+empty(esc(err.message),button('retry','重新连接','','primary'));});

function weekGrid(start,courses){const days=Array.from({length:7},(_,i)=>addDays(start,i));const known=courses.filter(c=>days.includes(c.date)&&c.start_time);const earliest=Math.min(8,...known.map(c=>Math.floor(minutes(c.start_time)/60)));const latest=Math.max(22,...known.map(c=>Math.ceil((minutes(c.start_time)+(displayMinutes(c)||120))/60)));const height=(latest-earliest)*64;let html=`<div class="calendar-scroll"><div class="week-header"><div class="time-zone">时间</div>${days.map((d,i)=>`<div class="day-title ${d===today()?'is-today':''}"><small>周${'一二三四五六日'[i]}</small><strong>${Number(d.slice(8))}</strong></div>`).join('')}</div><div class="week-body" style="--calendar-height:${height}px"><div class="time-rail">${Array.from({length:latest-earliest+1},(_,i)=>`<span style="top:${i*64}px">${String(earliest+i).padStart(2,'0')}:00</span>`).join('')}</div>`;for(const d of days){const dayCourses=known.filter(c=>c.date===d).sort((a,b)=>minutes(a.start_time)-minutes(b.start_time));html+=`<div class="day-column ${d===today()?'today-column':''}" data-date="${d}">${Array.from({length:(latest-earliest)*2},(_,i)=>`<button class="time-slot" data-action="slot" data-date="${d}" data-time="${timeLabel(earliest*60+i*30)}" aria-label="${dateShort(d)} ${timeLabel(earliest*60+i*30)} 安排课程"></button>`).join('')}`;const layouts=[];for(const c of dayCourses){const startM=minutes(c.start_time),endM=startM+(displayMinutes(c)||120);const overlaps=layouts.filter(l=>l.end>startM);let col=0;while(overlaps.some(l=>l.col===col))col++;layouts.push({c,start:startM,end:endM,col});}for(const l of layouts){const connected=layouts.filter(o=>o.start<l.end&&o.end>l.start);const cols=Math.max(...connected.map(o=>o.col))+1;html+=courseChip(l.c,`top:${(l.start-earliest*60)/60*64}px;height:${Math.max(40,(l.end-l.start)/60*64-4)}px;left:calc(${l.col/cols*100}% + 3px);width:calc(${100/cols}% - 6px)`);}html+='</div>';}html+='</div></div>';const unknown=courses.filter(c=>days.includes(c.date)&&!c.start_time);if(unknown.length)html+=`<div class="undated"><h3>开始时间待核对</h3><div class="course-strip">${unknown.map(c=>courseChip(c)).join('')}</div></div>`;return html;}
function monthGrid(courses){const first=anchor.slice(0,7)+'-01',start=monday(first);return `<div class="month-scroll"><div class="month-labels">${[...'一二三四五六日'].map(d=>`<span>周${d}</span>`).join('')}</div><div class="month-grid">${Array.from({length:42},(_,i)=>{const d=addDays(start,i),list=courses.filter(c=>c.date===d).sort((a,b)=>(a.start_time||'').localeCompare(b.start_time||''));return `<div class="month-day ${d.slice(0,7)!==anchor.slice(0,7)?'outside':''}" data-date="${d}"><button class="month-date ${d===today()?'is-today':''}" data-action="slot" data-date="${d}" data-time="09:00" aria-label="${d} 安排课程">${Number(d.slice(8))}</button>${list.map(c=>courseChip(c)).join('')}</div>`;}).join('')}</div></div>`;}
function setStatsRange(mode){statsMode=mode;const now=today();if(mode==='all'){statsStart='';statsEnd='';}else if(mode==='custom'&&!statsStart&&!statsEnd){statsStart=now.slice(0,7)+'-01';statsEnd=now;}else if(mode==='week'){statsStart=monday(now);statsEnd=addDays(statsStart,6);}else if(mode==='month'){statsStart=now.slice(0,7)+'-01';const d=new Date(`${statsStart}T12:00:00`);d.setMonth(d.getMonth()+1);d.setDate(0);statsEnd=dateKey(d);}else if(mode.startsWith('period:')){const p=state.periods.find(p=>p.id===mode.slice(7));if(p){statsStart=p.start;statsEnd=p.end;}}}
function statsHeader(){return header('','课时与收支统计','查看授课与收款')+`<div class="stats-toolbar"><label>统计区间 <select id="stats-mode">${option('all','全部',statsMode)}${option('week','本周',statsMode)}${option('month','本月',statsMode)}${state.periods.map(p=>option('period:'+p.id,periodLabel(p),statsMode)).join('')}${option('custom','自定义',statsMode)}</select></label>${statsMode==='all'?'':`<label>从 <input type="date" id="stats-start" value="${statsStart}"></label><label>至 <input type="date" id="stats-end" value="${statsEnd}"></label>`}<label class="sr-only" for="stats-student">统计学生</label><select id="stats-student">${studentOptions(statsStudent,true)}</select></div>`;}
function bindStats(){
 document.querySelector('#stats-mode').onchange=e=>{setStatsRange(e.target.value);render();};for(const id of ['start','end']){const el=document.querySelector('#stats-'+id);if(el)el.onchange=e=>{if(id==='start')statsStart=e.target.value||today();else statsEnd=e.target.value||today();statsMode='custom';render();};}document.querySelector('#stats-student').onchange=e=>{statsStudent=e.target.value;render();};
}
function renderStats(){
 const pending=state.periods.find(p=>statsMode==='period:'+p.id&&p.range_kind==='pending');if(pending){main.innerHTML=statsHeader()+notice(`学期日期暂未确定，请设置日期或选择自定义范围。 ${button('edit-period','设置学期日期',pending.id,'text-button')}`);bindStats();return;}
 const result=statsFor(state,statsStart,statsEnd,statsStudent);
 const rows=state.students.filter(s=>!statsStudent||s.id===statsStudent).map(s=>({s,...statsFor(state,statsStart,statsEnd,s.id)})).filter(r=>r.courses.length||r.payments.length||r.undatedCourses||r.undatedPayments);
 const adjustments=rows.some(r=>r.adjusted!==0),reviews=rows.some(r=>r.unknown||r.undatedCourses||r.undatedPayments),corrections=result.payments.some(p=>p.kind==='receipt_correction');
 const period=statsMode.startsWith('period:')?state.periods.find(p=>p.id===statsMode.slice(7)):null;
 main.innerHTML=statsHeader()+`${statsStart>statsEnd?notice('开始日期不能晚于结束日期。','warning'):''}${period?.range_kind==='coverage'?notice(`学期日期尚未确定，当前按已录入范围统计。 ${button('edit-period','设置学期日期',period.id,'text-button')}`):''}<div class="stat-band"><div><span>实际课时</span><strong>${Number((result.minutes/60).toFixed(2))}<small> 小时</small></strong></div><div><span>已上课费</span><strong>${money(result.fee)}</strong></div><div><span>${corrections?'核对后净收款':'净收款'}</span><strong>${money(result.received)}</strong></div></div>${result.undatedCourses||result.undatedPayments?notice(`${result.undatedCourses} 节已上课、${result.undatedPayments} 笔款项日期未知，${statsMode==='all'?'已纳入全部合计':'未纳入此时段'}。 ${button('all-reviews','查看历史核对')}`):''}${result.unknown?notice(`${result.unknown} 节已完成课程待核对；未知课时与费用未计入相应合计。`):''}<details class="stats-explanation compact-details"><summary>统计口径${corrections?' · 含历史收款核对':''}</summary><p>实际课时和已上课费只统计已完成课程。净收款为缴费减退款，余额调整单独列示。</p>${corrections?`<p>当前净收款包含历史收款核对 ${money(result.receiptCorrection)}；它是旧收款记录的修正，具体依据见学生流水。</p>`:''}${result.adjusted?`<p>本区间余额调整 ${money(result.adjusted)}，未计入净收款。</p>`:''}</details><div class="section-line"><h3>按学生明细</h3><span class="muted">${statsMode==='all'?'全部时间':`${statsStart} — ${statsEnd}`}</span></div>${rows.length?`<div class="table-scroll"><table><thead><tr><th>学生</th><th class="number">实际课时</th><th class="number">课费</th><th class="number">${corrections?'核对后净收款':'净收款'}</th>${adjustments?'<th class="number">余额调整</th>':''}${reviews?'<th>核对</th>':''}</tr></thead><tbody>${rows.map(r=>`<tr><td>${button('stats-ledger',esc(r.s.name),r.s.id,'text-button')}</td><td class="number">${button('stats-courses',hours(r.minutes),r.s.id,'text-button')}</td><td class="number">${button('stats-courses',money(r.fee),r.s.id,'text-button')}</td><td class="number">${button('stats-receipts',money(r.received),r.s.id,'text-button')}</td>${adjustments?`<td class="number">${button('stats-adjustments',money(r.adjusted),r.s.id,'text-button')}</td>`:''}${reviews?`<td>${r.unknown||r.undatedCourses||r.undatedPayments?`${r.unknown} 节待核对 · ${r.undatedCourses+r.undatedPayments} 条缺日期`:'—'}</td>`:''}</tr>`).join('')}</tbody></table></div>`:empty('这个区间还没有已完成课程或缴费记录。')}`;
 bindStats();
}
function periodForm(p=null){
 const kind=p?.range_kind||'pending',undated=kind!=='term';
 openDialog(p?'编辑学期':'添加学期',`<div class="form-grid">${field('名称',input('name','text',p?.name.replace(/课表$/,'')||'','required placeholder="例如：秋季学期"'),'full')}${field('日期',`<select name="range_kind">${option('pending','暂未确定',kind)}${option('term','已确定起止日期',kind)}${p?.source_start?option('coverage','暂未确定，按原表已录入范围查看',kind):''}</select>`,'full')}${field('实际开始日期',input('start','date',undated?'':p?.start||'','required'))}${field('实际结束日期',input('end','date',undated?'':p?.end||'','required'))}</div>${p?.source_start?`<p class="muted small">原表已录入范围：${p.source_start} — ${p.source_end}。</p>`:''}`,async f=>{
  const start=f.range_kind==='coverage'?p.source_start:f.range_kind==='pending'?'':f.start,end=f.range_kind==='coverage'?p.source_end:f.range_kind==='pending'?'':f.end;
  if(f.range_kind!=='pending'&&(!start||!end||start>end))throw new Error('请填写有效的学期起止日期。');
  await mutate(p?`/periods/${p.id}`:'/periods',p?'PATCH':'POST',{name:f.name,start,end,range_kind:f.range_kind,source_start:p?.source_start||null,source_end:p?.source_end||null});
  if(p){if(statsMode==='period:'+p.id)setStatsRange(statsMode);if(recordMode==='period:'+p.id){const saved=state.periods.find(x=>x.id===p.id);recordStart=saved.start;recordEnd=saved.end;}render();}
 },'保存',false,`period:${p?.id||'new'}`);
 const update=()=>{const undated=dialog.querySelector('[name="range_kind"]').value!=='term';for(const name of ['start','end']){const el=dialog.querySelector(`[name="${name}"]`);el.disabled=undated;el.required=!undated;el.closest('label').hidden=undated;}};
 dialog.querySelector('[name="range_kind"]').onchange=update;update();
}

function restoreForm(){
 let backup=null;
 openDialog('从备份文件恢复',`${field('选择课时簿 JSON 备份','<input type="file" name="backup_file" accept="application/json,.json" required>')}<div id="restore-preview" aria-live="polite"></div><div id="restore-confirm" hidden>${notice('恢复会替换当前全部记录；操作前自动保留一份当前账本备份。')}${field('确认覆盖',input('confirmation','text','','required placeholder="请输入：覆盖恢复" autocomplete="off"'))}</div>`,async f=>{
  if(!backup)throw new Error('请先选择并检查备份文件。');
  if(f.confirmation!=='覆盖恢复')throw new Error('请输入“覆盖恢复”以确认替换当前账本。');
  await mutate('/restore','POST',{backup},'备份已恢复');formDrafts.clear();selectedStudent='';render();
 },'覆盖并恢复');
 const fileInput=dialog.querySelector('[name="backup_file"]'),submit=dialog.querySelector('[type="submit"]');submit.disabled=true;
 fileInput.onchange=async()=>{
  backup=null;submit.disabled=true;dialog.querySelector('#restore-confirm').hidden=true;dialog.querySelector('#restore-preview').replaceChildren();
  const file=fileInput.files[0],error=dialog.querySelector('.form-error');error.hidden=true;if(!file)return;
  try{
   const doc=JSON.parse(await file.text());if(fileInput.files[0]!==file)return;
   const summary=backupSummary(doc);
   backup=doc;dialog.querySelector('#restore-preview').innerHTML=`<section class="backup-preview"><h3>${esc(file.name)}</h3><dl class="key-values"><div><dt>备份时间</dt><dd>${esc(readableTime(summary.date))}</dd></div><div><dt>学生</dt><dd>${summary.students} 位（当前 ${state.students.length} 位）</dd></div><div><dt>课程</dt><dd>${summary.courses} 节（当前 ${state.courses.length} 节）</dd></div><div><dt>收付款</dt><dd>${summary.payments} 笔（当前 ${state.payments.length} 笔）</dd></div></dl></section>`;
   dialog.querySelector('#restore-confirm').hidden=false;submit.disabled=false;
  }catch(e){if(fileInput.files[0]!==file)return;error.textContent=e instanceof SyntaxError?'文件不是有效的 JSON 备份。':e.message;error.hidden=false;}
 };
}
