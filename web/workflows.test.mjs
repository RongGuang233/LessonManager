import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionFor, plannedChanges, scheduleConflicts, estimatedFee, courseChangePayload, contextualStudentId, readPlannerView, savePlannerView} from './workflows.js';
const student={id:'s',status:'active',rates:{数学:15000,物理:20000},balance_verified:true,balance_cents:35000};
const c={id:'c',student_id:'s',subject:'物理',date:'2026-09-07',start_time:'18:00',duration_minutes:120,status:'scheduled',series_id:'series'};
test('余额按下一节课的科目价格判断，不混用统一小时价',()=>{
 assert.equal(estimatedFee(c,student),40000);
 assert.equal(attentionFor(student,[c],'2026-09-07'),'low');
 assert.equal(attentionFor({...student,balance_verified:false},[c],'2026-09-07'),'unverified');
 assert.equal(attentionFor({...student,balance_cents:-1},[c],'2026-09-07'),'debt');
 assert.equal(attentionFor(student,[{...c,subject:'数学'}],'2026-09-07'),'normal');
});
test('系列预览只修改本次及以后待上课程，跨日并保留已完成记录',()=>{
 const list=[c,{...c,id:'d',date:'2026-09-14'},{...c,id:'e',date:'2026-09-21',status:'completed'}];
 const changes=plannedChanges(list,c,{date:'2026-09-08',start_time:'19:00',duration_hours:'1',scope:'following'});
 assert.deepEqual(changes.map(x=>x.date),['2026-09-08','2026-09-15']);
 assert.equal(changes[0].duration_minutes,60);
});
test('仅调整系列日期时保留后续课程各自时间、时长和备注',()=>{
 const original={...c,notes:'首节备注'};
 const exception={...c,id:'d',date:'2026-09-14',start_time:'19:30',duration_minutes:60,notes:'后续单独备注'};
 const form={date:'2026-09-09',start_time:'18:00',duration_hours:'2',notes:'首节备注',scope:'following'};
 assert.deepEqual(courseChangePayload(original,form),{date:'2026-09-09'});
 const changes=plannedChanges([original,exception],original,form);
 assert.deepEqual(changes,[{...original,date:'2026-09-09'},{...exception,date:'2026-09-16'}]);
 assert.equal(exception.date,'2026-09-14');
});
test('明确改变的系列字段传播到后续待上课程，包括清空备注',()=>{
 const original={...c,notes:'需清空'};
 const exception={...c,id:'d',date:'2026-09-14',start_time:'19:30',duration_minutes:60,notes:'后续单独备注'};
 const completed={...c,id:'done',date:'2026-09-21',status:'completed',notes:'已上课'};
 const form={date:c.date,start_time:'20:00',duration_hours:'1.5',notes:'',scope:'following'};
 assert.deepEqual(courseChangePayload(original,form),{date:c.date,start_time:'20:00',duration_minutes:90,notes:''});
 const changes=plannedChanges([original,exception,completed],original,form);
 assert.deepEqual(changes.map(x=>[x.id,x.date,x.start_time,x.duration_minutes,x.notes]),[
  ['c','2026-09-07','20:00',90,''],['d','2026-09-14','20:00',90,'']
 ]);
 const notesOnly=plannedChanges([original,exception],original,{...form,start_time:'18:00',duration_hours:'2'});
 assert.equal(notesOnly[1].start_time,'19:30');
 assert.equal(notesOnly[1].duration_minutes,60);
 assert.equal(notesOnly[1].notes,'');
});
test('单节编辑与系列共用比较规则，未知日期时间归一化，未提供备注保留',()=>{
 assert.deepEqual(courseChangePayload({...c,date:null,start_time:null},{date:'',start_time:'',duration_hours:2}),{date:null});
 assert.deepEqual(courseChangePayload(c,{date:'',start_time:''}),{date:null,start_time:null});
 assert.deepEqual(courseChangePayload({...c,notes:'保留'},{date:c.date,notes:undefined}),{date:c.date});
 assert.deepEqual(courseChangePayload(c,{date:c.date,notes:''}),{date:c.date});
 const original={...c,notes:'保留'};
 assert.deepEqual(plannedChanges([original],original,{date:'',start_time:'',duration_hours:'1.3333333333',scope:'one'}),[
  {...original,date:null,start_time:null,duration_minutes:80}
 ]);
});
test('付款学生上下文仅属于当前页面，不沿用其它页面或默认第一位',()=>{
 const students=[student,{...student,id:'second'}];
 const context={selectedStudent:'s',filterStudent:'second',statsStudent:'s'};
 assert.equal(contextualStudentId('students',context,students),'s');
 assert.equal(contextualStudentId('schedule',context,students),'second');
 assert.equal(contextualStudentId('stats',context,students),'s');
 for(const route of ['settings','reviews','unknown','']) assert.equal(contextualStudentId(route,context,students),'');
 assert.equal(contextualStudentId('schedule',{...context,filterStudent:''},students),'');
 assert.equal(contextualStudentId('students',{...context,selectedStudent:'deleted'},students),'');
 assert.equal(contextualStudentId('stats',context,[]),'');
});
test('课表视图只持久保存合法视图，空值、未知值和不可用存储默认有课日',()=>{
 const saved=new Map();
 const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
 assert.equal(readPlannerView(storage),'list');
 for(const view of ['week','month','list']) {
  savePlannerView(storage,view);
  assert.equal(readPlannerView(storage),view);
 }
 assert.deepEqual([...saved.entries()],[['lesson-manager.planner-view','list']]);
 savePlannerView(storage,'invalid');
 assert.equal(readPlannerView(storage),'list');
 saved.set('lesson-manager.planner-view','{"student":"s"}');
 assert.equal(readPlannerView(storage),'list');
 const unavailable={getItem(){throw Error('unavailable');},setItem(){throw Error('unavailable');}};
 for(const source of [undefined,null,unavailable]) {
  assert.equal(readPlannerView(source),'list');
  assert.doesNotThrow(()=>savePlannerView(source,'month'));
 }
});
test('冲突预览排除自身、取消和相邻课程，并检出重复课程后续冲突',()=>{
 const changes=plannedChanges([],null,{date:'2026-09-07',repeat_until:'2026-09-14',start_time:'18:00',duration_hours:'2',student_id:'s',subject:'数学'});
 const others=[{...c,id:'o',date:'2026-09-14',start_time:'19:00'}, {...c,id:'adj',start_time:'20:00'}, {...c,id:'cancel',status:'cancelled'}];
 assert.equal(scheduleConflicts(others,changes).length,1);
 assert.equal(scheduleConflicts([c],[c]).length,0);
});

test('余额节数按下一科目和常规课长折算，免费和多价无排课不乱推算',async()=>{
 const {lessonCredit}=await import('./workflows.js');
 assert.deepEqual(lessonCredit({...student,balance_cents:480000,rates:{数学:24000}},[{...c,subject:'数学'}],'2026-09-07'),{count:10,subject:'数学',duration:120});
 assert.equal(lessonCredit(student,[],'2026-09-07'),null);
 assert.equal(lessonCredit({...student,rates:{数学:0}},[],'2026-09-07'),null);
 assert.equal(lessonCredit({...student,balance_cents:-30000},[c],'2026-09-07'),null);
 assert.equal(lessonCredit(student,[c],'2026-09-07').count,0.87);
});
test('历史结转范围及未上课不计入当前待核对，已到结束时间才推荐记课',async()=>{
 const {impactsCurrentAccount,courseHasEnded}=await import('./workflows.js');
 const review={student_id:'s',course_id:'c'},course={...c,status:'completed'};
 assert.equal(impactsCurrentAccount(review,[student],[course]),true);
 assert.equal(impactsCurrentAccount(review,[{...student,settlement:{course_ids:['c']}}],[course]),false);
 assert.equal(impactsCurrentAccount(review,[student],[{...course,status:'cancelled'}]),false);
 assert.equal(courseHasEnded(c,'2026-09-07',19*60),false);
 assert.equal(courseHasEnded(c,'2026-09-07',20*60),true);
 assert.equal(courseHasEnded(c,'2026-09-06',23*60),false);
});

test('恢复预览读取备份自身时间和数量，拒绝残缺或无关JSON，允许空账本',async()=>{
 const {backupSummary}=await import('./workflows.js');
 const doc={schema_version:1,students:[{id:'a'}],courses:[{},{}],payments:[{}],reviews:[],periods:[],meta:{last_backup_at:'2026-09-08T10:00:00'}};
 assert.deepEqual(backupSummary(doc),{date:'2026-09-08T10:00:00',students:1,courses:2,payments:1});
 for(const invalid of [null,[],{}, {...doc,courses:undefined},{...doc,schema_version:2}])assert.throws(()=>backupSummary(invalid),/完整的课时簿备份/);
 assert.equal(backupSummary({...doc,students:[],courses:[],payments:[]}).students,0);
});


test('临时一小时不会把十节余额翻倍，常规课长独立且不改变下一次实际课费',async()=>{
 const {lessonCredit,estimatedFee,regularDuration}=await import('./workflows.js');
 const s={id:'s',balance_verified:true,balance_cents:480000,rates:{数学:24000},default_duration_minutes:120};
 const next={student_id:'s',subject:'数学',status:'scheduled',date:'2026-09-12',duration_minutes:60};
 assert.equal(lessonCredit(s,[next],'2026-09-08').count,10);
 assert.equal(estimatedFee(next,s),24000);
 assert.equal(lessonCredit({...s,default_duration_minutes:60},[next],'2026-09-08').count,20);
 assert.equal(regularDuration({}),120);
 assert.equal(regularDuration({default_duration_minutes:180}),180);
 assert.equal(regularDuration({default_duration_minutes:90}),120);
});

test('重新打开仅恢复学生和栏目，损坏或不可用的存储不影响使用',async()=>{
 const {readStudentLocation,saveStudentLocation}=await import('./workflows.js');
 const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
 assert.deepEqual(readStudentLocation(storage),{studentId:'',tab:'overview'});
 saveStudentLocation(storage,'s2','courses');
 assert.deepEqual(readStudentLocation(storage),{studentId:'s2',tab:'courses'});
 assert.deepEqual(JSON.parse(saved.get('lesson-manager.student-location')),{studentId:'s2',tab:'courses'});
 saveStudentLocation(storage,'','ledger');
 saveStudentLocation(storage,'s3','invalid');
 assert.deepEqual(readStudentLocation(storage),{studentId:'s2',tab:'courses'});
 for(const value of ['bad json','null','[]','{"studentId":4,"tab":"ledger"}','{"studentId":"s","tab":"invalid"}']){
  saved.set('lesson-manager.student-location',value);
  assert.deepEqual(readStudentLocation(storage),{studentId:'',tab:'overview'});
 }
 const unavailable={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
 assert.deepEqual(readStudentLocation(unavailable),{studentId:'',tab:'overview'});
 assert.doesNotThrow(()=>saveStudentLocation(unavailable,'s','ledger'));
});

test('补课关联随课程状态变化，取消的补课保留且不会阻止再安排',async()=>{
 const {makeupLinks}=await import('./workflows.js');
 const original={...c,status:'cancelled'},cancelled={...c,id:'m1',makeup_for_id:c.id,status:'cancelled'},replacement={...c,id:'m2',makeup_for_id:c.id};
 const courses=[original,cancelled,replacement];
 assert.equal(makeupLinks(original,courses).active.id,'m2');
 assert.equal(makeupLinks(replacement,courses).original.id,c.id);
 assert.equal(makeupLinks(original,courses).replacements.length,2);
 replacement.status='completed';
 assert.equal(makeupLinks(original,courses).active.status,'completed');
 replacement.status='cancelled';
 assert.equal(makeupLinks(original,courses).active,undefined);
 assert.deepEqual(makeupLinks({...c,id:'legacy',notes:'补课：旧备注'},courses),{original:undefined,replacements:[],active:undefined});
});

test('接下来包含今天及未来，全部待上课范围不再排除历史或未知日期',async()=>{
 const {recordDateMatches}=await import('./workflows.js');
 for(const date of ['2026-09-08','2026-09-12','2027-01-01'])assert.equal(recordDateMatches(date,'upcoming','','','2026-09-08'),true);
 for(const date of ['2026-09-07',null,''])assert.equal(recordDateMatches(date,'upcoming','','','2026-09-08'),false);
 assert.equal(recordDateMatches(null,'all','',''),true);
 assert.equal(recordDateMatches('2026-08-01','custom','2026-08-01','2026-08-31'),true);
 assert.equal(recordDateMatches('2026-08-31','custom','2026-08-01','2026-08-31'),true);
 assert.equal(recordDateMatches('2026-09-01','custom','2026-08-01','2026-08-31'),false);
});

test('对账继承明确记录区间，概览或无界与待定范围回到本月',async()=>{
 const {statementRange}=await import('./workflows.js');
 const context={tab:'ledger',mode:'custom',start:'2026-08-01',end:'2026-08-31'};
 for(const tab of ['ledger','courses'])for(const mode of ['custom','recent','period:term']){
  assert.deepEqual(statementRange({...context,tab,mode},'2026-09-08'),{start:'2026-08-01',end:'2026-08-31'});
 }
 for(const change of [{tab:'overview'},{tab:'profile'},{mode:'all'},{mode:'upcoming'},{pending:true},{start:''},{end:'2026-07-01'}]){
  assert.deepEqual(statementRange({...context,...change},'2026-09-08'),{start:'2026-09-01',end:'2026-09-08'});
 }
});

test('归档搜索只在非空查询和其他状态筛选下提示，不把筛选空误作空账本',async()=>{
 const {studentMatchesSearch,archivedSearchMatches}=await import('./workflows.js');
 const students=[{id:'active',name:'示例甲',status:'active',grade:'初一'},{id:'old',name:'示例乙',status:'archived',grade:''}];
 assert.equal(studentMatchesSearch(students[0],' 初一 '),true);
 assert.deepEqual(archivedSearchMatches(students,' 示例乙 ','active').map(s=>s.id),['old']);
 for(const [query,status] of [['','active'],['  ','active'],['示例乙',''],['示例乙','archived'],['不存在','active']])assert.deepEqual(archivedSearchMatches(students,query,status),[]);
});
