import test from 'node:test';
import assert from 'node:assert/strict';
import {attentionFor, plannedChanges, scheduleConflicts, estimatedFee} from './workflows.js';
const student={id:'s',rates:{数学:15000,物理:20000},balance_verified:true,balance_cents:35000};
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
test('冲突预览排除自身、取消和相邻课程，并检出重复课程后续冲突',()=>{
 const changes=plannedChanges([],null,{date:'2026-09-07',repeat_until:'2026-09-14',start_time:'18:00',duration_hours:'2',student_id:'s',subject:'数学'});
 const others=[{...c,id:'o',date:'2026-09-14',start_time:'19:00'}, {...c,id:'adj',start_time:'20:00'}, {...c,id:'cancel',status:'cancelled'}];
 assert.equal(scheduleConflicts(others,changes).length,1);
 assert.equal(scheduleConflicts([c],[c]).length,0);
});
