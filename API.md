# 本地接口

同源 JSON API，金额单位分，时长单位分钟。日期 YYYY-MM-DD，开始时间 HH:MM；历史缺失值可为 null。新课实际时长为正整数小时；历史例外保留。无登录、无远程同步。

GET /api/state → {students,courses,payments,reviews,periods,meta}

- student: {id,name,status:"active"|"paused"|"archived",grade,notes,rates:{"数学":15000,"物理":15000},balance_verified:boolean,balance_cents,completed_minutes,paid_cents,charged_cents,pending_count}
- course: {id,student_id,subject,date,start_time,duration_minutes,actual_minutes,hourly_rate_cents,status:"scheduled"|"completed"|"cancelled",notes,series_id,source,needs_review:boolean,fee_cents,conflict:boolean}; source 为文本或空字符串。fee_cents由后端计算，未知费用为null。取消/未上费用为0。
- payment: {id,student_id,date,kind:"payment"|"refund"|"adjustment",amount_cents,notes,source}; 退款金额为负。
- review: {id,student_id,course_id,kind,message,source,status:"pending"|"resolved",resolution}; 不确定的旧数据不能默认当作零金额或已完成。
- period: {id,name,start,end}
- meta: {data_dir,last_backup_at,imported_at,app_version}

GET /api/health → {app:"LessonManager",version}
POST /api/students {name,status?,grade?,notes?,rates?} → student
PATCH /api/students/:id 部分更新。调价不改已完成课程单价。
POST /api/students/:id/reconcile {balance_cents,note} → student。记录余额差额调整，将balance_verified设为true。
POST /api/courses {student_id,subject,date,start_time,duration_minutes:120,notes?,repeat_until?} → {created:[id]}; repeat_until为每周重复截止日期。
PATCH /api/courses/:id {date?,start_time?,duration_minutes?,actual_minutes?,hourly_rate_cents?,status?,notes?,scope?:"one"|"following",needs_review?} → course。确认已上用status=completed、actual_minutes；首次完成时锁定当时学生科目单价。撤销确认用status=scheduled，余额自动恢复。scope=following仅对同系列后续scheduled课的排期变化生效。
DELETE /api/courses/:id → {ok:true}；仅scheduled可删；历史记录用取消或更正。
POST /api/courses/copy-week {week_start:"YYYY-MM-DD"} → {created:[id],skipped:number}; 复制上周非cancelled课程至目标周，同学生科目时间相同的不重复创建。
POST /api/payments {student_id,date,kind,amount_cents,notes?} → payment。UI输入退款正数，后端统一取负。
PATCH /api/payments/:id 部分更新 → payment
DELETE /api/payments/:id → {ok:true}；需UI确认。
POST /api/periods {name,start,end} → period
DELETE /api/periods/:id → {ok:true}
PATCH /api/reviews/:id {status,resolution} → review
GET /api/backup → 完整JSON备份下载
POST /api/restore {backup:<完整备份对象>} → {ok:true}；完整验证后替换，自动保留恢复前备份。

错误响应 {error:"中文原因"}，HTTP 400/404/409等。所有更改返回成功后重新GET state即可。

## 首次迁移格式（内部本地文件，不提交真实内容）

导入器输出 {schema_version:1,students:[],courses:[],payments:[],reviews:[],periods:[],meta:{imported_at,source_summary}}。
只输出上述实体基础字段，不输出计算字段。学生必须有唯一id。课程duration_minutes默认为120，未知实际时长actual_minutes=null，已完成但未知时长/单价/疑似笔误的费用不参与确定账目，needs_review=true。每个学生balance_verified=false，直到核对全部旧账或人工录入已知余额。重复导入相同来源课程须有稳定id（可用源文件+单元格作为身份，与宿主绝对路径无关）。历史英语保留。
原始数据来源优先级：学期/假期表 > 课时表.xlsx；同表下方学生明细 > 上方排班；黄色已完成且已扣费，无色取消/未上且不扣费。上方只补漏，不能覆盖下方。outputs派生文件不导入。缺失日期/金额不伪造，疑点进入reviews。不重复累计跨期余额和此前缴费。
