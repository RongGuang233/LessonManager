# 本地接口

同源 JSON API，金额单位分，时长单位分钟。日期 YYYY-MM-DD，开始时间 HH:MM；历史缺失值可为 null。新课实际时长为正整数小时；历史例外保留。无登录、无远程同步。

GET /api/state → {students,courses,payments,reviews,periods,meta}

- student: {id,name,status:"active"|"paused"|"archived",grade,notes,rates:{"数学":15000,"物理":15000},balance_verified:boolean,default_duration_minutes:120,balance_cents,completed_minutes,paid_cents,charged_cents,pending_count,settlement:null|{confirmed_on,balance_cents,note,course_ids,payment_ids}}
- course: {id,student_id,subject,date,start_time,duration_minutes,actual_minutes,hourly_rate_cents,status:"scheduled"|"completed"|"cancelled",notes,series_id,makeup_for_id:null|id,source,needs_review:boolean,fee_cents,conflict:boolean}; source 为文本或空字符串。fee_cents由后端计算，未知费用为null。取消/未上费用为0。
- payment: {id,student_id,date,kind:"payment"|"refund"|"adjustment"|"receipt_correction",amount_cents,notes,source}; 退款金额为负。receipt_correction 为有依据的历史收款核对差额（可正可负），计入历史净收款，不代表新发生的缴费或退款；纳入已结清 payment_ids 后不重复改变当前余额。
- review: {id,student_id,course_id,kind,message,source,status:"pending"|"resolved",resolution}; 不确定的旧数据不能默认当作零金额或已完成。
- period: {id,name,start,end,range_kind:"term"|"coverage"|"pending",source_start,source_end}
- meta: {data_dir,last_backup_at,imported_at,app_version}

GET /api/health → {app:"LessonManager",version}
POST /api/students {name,status?,grade?,notes?,rates?,default_duration_minutes?:120} → student
PATCH /api/students/:id 部分更新。default_duration_minutes 为常规课长，省略或 null 默认120，仅接受60至1440且为60整数倍的分钟数，用于节课数折算和加课默认值；修改不改变已有课程时长、实际扣费或余额。调价不改已完成课程单价。
POST /api/students/:id/reconcile {balance_cents,note} → student。记录当前余额差额调整，将balance_verified设为true。已纳入历史余额核对的旧明细不再参与当前余额计算，也不阻塞后续余额核对。

POST /api/students/:id/settle-history {balance_cents?:0,course_ids:[],payment_ids:[],note} → settlement。按明确的原表结转或用户确认记录历史结余（正数为预付款、负数为欠费、零为结清）；confirmed_on为核对日期，不是付款日期。只覆盖明确列出的、属于该学生的非未来款项和非待上/非未来课程，未知历史字段保持未知。当前余额=确认结余+范围外款项−范围外课费；更正范围内旧明细不再重复影响当前余额。首次确认后重复调用返回原结果，不吸收后续新记录；后续新余额核对使用reconcile。依据与记录范围保存在meta.account_settlements，随备份保存并验证学生及明细关联。范围内记录保留、可更正，不能删除或转到其他学生。结转不是新增缴费、退款或余额差额调整，不计入现金收支统计。
POST /api/courses {student_id,subject,date,start_time,duration_minutes:120,notes?,repeat_until?,makeup_for_id?:id} → {created:[id]}; repeat_until为每周重复截止日期。makeup_for_id指定原请假课程：必须同学生、原课cancelled，且原课没有其他未取消补课；补课只能单次创建，关联创建后不可编辑，不从旧备注推断。原课详情可通过courses中的反向关联查看补课状态；补课取消后可再安排，已完成补课仍占用关联，避免重复补课。原课有未取消补课时不能恢复；双方已有历史关联时不能改到不同学生。删除允许删除的课程时，指向它的关联自动置空。
PATCH /api/courses/:id {date?,start_time?,duration_minutes?,actual_minutes?,hourly_rate_cents?,status?,notes?,scope?:"one"|"following",needs_review?} → course。确认已上用status=completed、actual_minutes；首次完成时锁定当时学生科目单价；可显式传hourly_rate_cents登记本次试听/特殊价，不修改学生标准价。撤销确认用status=scheduled，余额自动恢复。scope=following仅对同系列后续scheduled课的排期变化生效：日期按本次调整的天数平移；开始时间、预计时长、备注仅传播相对原课程实际改变的字段，完整表单内未变字段不会覆盖后续课程的单独约定。

历史课程还可更正 subject。needs_review=false 表示确认本次课程字段，仅解决对应事项：missing_course_fields/legacy_incomplete 须补齐日期、开始时间、科目（不能为“待确认”），已上课程还须实际时长和历史单价；zero_rate 须明确单价（允许确认免费为0）；time_typo/merged_lesson 须明确实际时长。schedule_only、attendance_conflict 和其他类别仍需单独填写核对结果。任何客观字段缺失或关联 pending 事项仍存在时，返回的 needs_review 保持 true。仅补时长、单价不会关闭缺日期事项；未完成核对的已上课程 fee_cents 仍为 null，普通余额差额核对仍受阻；若有独立的已知结余依据，可以通过settle-history保留未知明细并确认历史余额。未知数值不代表已确定课费。

DELETE /api/courses/:id → {ok:true}；仅scheduled可删；历史记录用取消或更正。
POST /api/courses/copy-week {week_start:"YYYY-MM-DD",student_id?:id|null,status?:"scheduled"|"completed"|"cancelled"|null,source_ids?:[id],preview?:boolean} → {created:[id],skipped:number}; 复制上周非cancelled课程至目标周，同学生科目日期时间相同（含本次候选之间）的不重复创建。student_id省略/null/空字符串表示全部学生；status省略/null/空字符串表示全部非取消课程，cancelled筛选返回空候选。preview=true返回{created:[course],skipped:number}且不写库；source_ids省略表示筛选范围内全部，显式空数组不复制任何课程；传入数组仅复制其中仍符合来源范围的课程。复制不继承makeup_for_id。候选course包含source_course_id、拟复制日期、时间、时长及稳定的临时id，可结合当前课程显示冲突。提交时重新使用相同筛选、去重规则，返回实际创建id。skipped只计筛选范围内因重复、缺时间或非整小时不能复制的记录。
POST /api/courses/:id/cancel {scope:"one"|"range"|"following",start?:"YYYY-MM-DD",end?:"YYYY-MM-DD",reason?:string,preview?:boolean} → {count:number}。仅将待上课status改为cancelled，保留其余字段；reason为选填原因，去除首尾空白后非空则在原notes前增加一行“请假原因：…”（完整保留原备注，原因不会进入旧推测依据的折叠部分）（批量课程使用相同原因），留空不改备注；已完成、已取消课程不受影响，重复提交无新增影响。one仅选中课程；range须提供start/end，包含同学生日期闭区间内全部待上课（不限科目、系列，包含无series_id的历史导入排课）；following须选中有系列且日期时间完整的课程，仅同学生同系列、本次日期时间及以后的待上课。preview=true返回{courses:[完整course],count:number}且不写入，course包含fee_cents/conflict；提交按最新状态重新确定范围。
POST /api/payments {student_id,date,kind,amount_cents,notes?} → payment。UI输入退款正数，后端统一取负。
PATCH /api/payments/:id {date?,kind?,amount_cents?,notes?,review_ids?:[id]} → payment。历史 date=null 在仅改备注时保留；不填 review_ids 时不自动解决核对事项。补填实际发生日期并传入 review_ids 可在同次保存中解决选定的 payment_date_missing；要求每项与此款项有相同 student_id、相同非空 source，且该来源仅对应一笔款项，无 course_id。关联不明或未补日期返回中文错误，整次保存不生效。不可仅按同学生或同类别批量关闭疑点。
DELETE /api/payments/:id → {ok:true}；需UI确认。
POST /api/periods {name,start?,end?,range_kind?:"term"|"coverage"|"pending",source_start?:date|null,source_end?:date|null} → period
PATCH /api/periods/:id {name?,start?,end?,range_kind?,source_start?,source_end?} → period。term表示用户定义的真实学期，coverage表示目前已录入日期范围、不能当作真实学期起止；两者须提供合法start/end。pending表示学期日期待定，start/end统一保存为空字符串且不能作为有效统计区间；已有学期改为pending会清空start/end，source字段独立保留。省略range_kind默认term。source_start/source_end保留原始导入覆盖日期，须同时为空或成对提供合法范围。修改学期起止而不传source字段时保留原始覆盖范围；不改变课程或账目。SQLite数据库通过短事务升级至v4，v1补学期范围字段、v2补学生常规课长默认120、v3补可空makeup_for_id关联字段；已有业务列不改，重复启动保留已设置值。JSON备份仍为schema_version:1，旧备份可省略范围字段、常规课长和补课关联，恢复时补齐默认值；新备份验证补课关联及未取消补课唯一性，恢复不依赖课程排列顺序。
DELETE /api/periods/:id → {ok:true}
PATCH /api/reviews/:id {status,resolution} → review。resolved 必须填写结果；未纳入历史结余的已上课程仍缺日期、开始时间、科目、实际时长或历史单价时拒绝，并指出缺失字段。原表未上课程、已纳入历史结余的课程可以记录依据后归档缺项，保留未知字段；未知费用仍为null，不作免费处理。payment_date_missing 必须能按学生与非空来源唯一对应已有款项，且款项日期已填。最后一个课程事项解决且客观字段齐全后，自动清除课程 needs_review；重新设为 pending 时恢复课程提醒。上述规则均使用现有字段，不增加持久状态或改变备份版本。
GET /api/backup → 完整JSON备份下载
POST /api/restore {backup:<完整备份对象>} → {ok:true}；完整验证后替换，自动保留恢复前备份。
GET /api/backups → {backups:[{filename,created_at,size_bytes}]}；仅列本机数据目录backups内lessonmanager_*.sqlite3普通文件，按文件修改时间倒序，created_at为本机时间ISO文本。不含符号链接或无关文件，损坏文件可列出但预览/恢复会拒绝。
GET /api/backups/:filename/preview → {filename,created_at,size_bytes,schema_version,counts:{students,courses,payments,reviews,periods}}；只读验证SQLite备份，不写账本，不修改或迁移源文件。这里schema_version是SQLite版本1、2、3或4，JSON格式继续使用schema_version:1；旧版学期字段按现有默认值规范化，缺少学生常规课长时补120。
POST /api/backups/:filename/restore {} → {ok:true}；只接受上述目录内的单一文件名，完整验证后沿用JSON恢复事务，先保存恢复前备份，再替换本机账本；轮转清理时保留本次选中的源文件。损坏/内容不完整/不支持版本返回400 {error}且不覆盖账本，文件不存在返回404 {error}。不自动选择备份或恢复。

错误响应 {error:"中文原因"}，HTTP 400/404/409等。所有更改返回成功后重新GET state即可。

## 首次迁移格式（内部本地文件，不提交真实内容）

导入器输出 {schema_version:1,students:[],courses:[],payments:[],reviews:[],periods:[],meta:{imported_at,source_summary}}。
只输出上述实体基础字段，不输出计算字段。学生必须有唯一id。课程duration_minutes默认为120，未知实际时长actual_minutes=null，已完成但未知时长/单价/疑似笔误的费用不参与确定账目，needs_review=true。每个学生balance_verified=false，直到有依据地核对余额；已结束学习学生可按明确确认结清，在读学生必须保留实际余额或欠费。重复导入相同来源课程须有稳定id（可用源文件+单元格作为身份，与宿主绝对路径无关）。历史英语保留。
原始数据来源优先级：学期/假期表 > 课时表.xlsx；同表下方学生明细 > 上方排班；黄色已完成且已扣费，无色取消/未上且不扣费。上方只补漏，不能覆盖下方。outputs派生文件不导入。缺失日期/金额不伪造，疑点进入reviews。不重复累计跨期余额和此前缴费。
