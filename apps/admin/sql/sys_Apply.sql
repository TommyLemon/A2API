-- A2API config applications (permission / Access+Request approval queue)
-- Table: Apply
-- Run against the same Demo DB as APIJSONBoot (MySQL / StarRocks-compatible).
-- After import: reload Access/Request in APIJSON (or restart the server).

DROP TABLE IF EXISTS `Apply`;
CREATE TABLE `Apply` (
  `id` bigint NOT NULL COMMENT '主键，客户端/服务端分配（如 Date.now()）',
  `status` varchar(20) NOT NULL DEFAULT 'pending' COMMENT '审批状态：pending-待审，approved-已批准，rejected-已拒绝',
  `bizTable` varchar(50) NOT NULL COMMENT '业务表别名，例如 User、Moment',
  `operation` varchar(20) NOT NULL COMMENT 'APIJSON 操作方法：get/head/gets/heads/post/put/delete',
  `role` varchar(20) NOT NULL DEFAULT 'OWNER' COMMENT '申请授予的角色：UNKNOWN/LOGIN/CONTACT/CIRCLE/OWNER/ADMIN',
  `version` tinyint NOT NULL DEFAULT 1 COMMENT 'Request.version，接口结构版本号',
  `method` varchar(10) NOT NULL DEFAULT 'POST' COMMENT 'HTTP Method：GET/POST/PUT/DELETE 等（写入 Document.method）',
  `type` varchar(10) NOT NULL DEFAULT 'JSON' COMMENT '请求体类型：JSON/PARAM/FORM/DATA（写入 Document.type）',
  `url` varchar(250) NOT NULL COMMENT '请求地址，例如 http://localhost:8080/put',
  `request` text NOT NULL COMMENT 'APIJSON 请求体 JSON 文本',
  `structure` text COMMENT '拟写入 Request.structure 的结构校验 JSON',
  `tag` varchar(50) COMMENT 'Request.tag，默认与 bizTable 相同',
  `accessAlias` varchar(50) COMMENT 'Access.alias 外部表别名',
  `accessName` varchar(50) COMMENT 'Access.name 实际物理表名，例如 apijson_user',
  `name` varchar(100) COMMENT '申请/接口名称，写入 Document.name',
  `detail` text COMMENT '申请说明、审批备注',
  `requestId` varchar(80) COMMENT '关联 chat-demo / HITL 的 requestId',
  `sessionId` varchar(80) COMMENT '关联会话 sessionId',
  `submitter` varchar(80) COMMENT '提交人标识',
  `issues` text COMMENT '权限门控等问题列表 JSON 数组文本',
  `writeResults` text COMMENT '批准后写入 Access/Request/Document/Chain 的结果 JSON',
  `error` text COMMENT '审批或落库失败信息',
  `decidedBy` varchar(80) COMMENT '审批人',
  `decidedAt` datetime COMMENT '审批时间',
  `date` datetime COMMENT '创建时间',
  `updatedAt` datetime COMMENT '最后更新时间'
) COMMENT='A2API 配置申请与审批结果';

-- Access: allow demo admin session to CRUD applications
-- Apply alias is used for POST create (avoids broken historic Apply POST Request MUST:id).
DELETE FROM `Access` WHERE `id` IN (9001, 9002) OR `alias` IN ('Apply', 'Apply') OR `name` = 'Apply';
INSERT INTO `Access` (`id`, `debug`, `schema`, `name`, `alias`, `get`, `head`, `gets`, `heads`, `post`, `put`, `delete`, `date`, `detail`)
VALUES
(
  9001, 0, NULL, 'Apply', 'Apply',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["ADMIN"]',
  NOW(),
  'A2API config Apply + approval results'
),
(
  9002, 0, NULL, 'Apply', 'Apply',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["ADMIN"]',
  NOW(),
  'Alias for Apply POST create (tag=Apply)'
);

-- Request rules for create / update / list
-- POST uses tag Apply (APIJSON refuses client id on POST; MUST must not include id).
DELETE FROM `Request`
WHERE `id` IN (9001001, 9001002, 9001003)
   OR `tag` IN ('Apply', 'Apply');
INSERT INTO `Request` (`id`, `debug`, `version`, `method`, `tag`, `structure`, `detail`, `date`) VALUES
(9001001, 0, 1, 'POST', 'Apply',
 '{"MUST":"bizTable,operation,method,url,request,status","REFUSE":"id","INSERT":{"@role":"LOGIN"}}',
 'Create A2API Apply via alias Apply (id auto-assigned)', NOW()),
(9001002, 0, 1, 'PUT', 'Apply',
 '{"MUST":"id","INSERT":{"@role":"LOGIN"}}',
 'Update / decide A2API Apply', NOW()),
(9001003, 0, 1, 'GETS', 'Apply',
 '{}',
 'List A2API Apply rows', NOW());

-- Seed: ~10 applications covering different ops / roles / statuses / tables
INSERT INTO `Apply` (
  `id`, `status`, `bizTable`, `operation`, `role`, `version`,
  `method`, `type`, `url`, `request`, `structure`, `tag`,
  `accessAlias`, `accessName`, `name`, `detail`,
  `requestId`, `sessionId`, `submitter`, `issues`,
  `writeResults`, `error`, `decidedBy`, `decidedAt`, `date`, `updatedAt`
) VALUES
-- 1 pending: POST Moment (create)
(9002001, 'pending', 'Moment', 'post', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/post',
 '{"Moment":{"content":"hello from Apply seed","pictureList":[]},"tag":"Moment"}',
 '{"INSERT":{"@role":"OWNER","pictureList":[],"praiseUserIdList":[]},"REFUSE":"id"}',
 'Moment', 'Moment', 'Moment', 'POST Moment',
 'Missing Request row for POST tag=Moment — grant OWNER create',
 'req_seed_moment_post', 'sess_seed_1', 'demo-user',
 '["body.tag: no Request row for POST tag=\\"Moment\\""]',
 NULL, NULL, NULL, NULL, '2026-07-20 10:00:00', '2026-07-20 10:00:00'),

-- 2 pending: PUT User (update profile)
(9002002, 'pending', 'User', 'put', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/put',
 '{"User":{"id":38710,"name":"Alice"},"tag":"User"}',
 '{"MUST":"id","INSERT":{"@role":"OWNER"},"REFUSE":"phone"}',
 'User', 'User', 'apijson_user', 'PUT User',
 'Need Access.put + Request for User update',
 'req_seed_user_put', 'sess_seed_2', 'alice',
 '["body.tag: no Request row for PUT tag=\\"User\\""]',
 NULL, NULL, NULL, NULL, '2026-07-20 10:05:00', '2026-07-20 10:05:00'),

-- 3 pending: DELETE Comment (sensitive)
(9002003, 'pending', 'Comment', 'delete', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/delete',
 '{"Comment":{"id":12},"tag":"Comment"}',
 '{"MUST":"id","INSERT":{"@role":"OWNER"}}',
 'Comment', 'Comment', 'Comment', 'DELETE Comment',
 'Sensitive delete — configure Access.delete + Request',
 'req_seed_comment_del', 'sess_seed_3', 'bob',
 '["Permission gate: no Request row for DELETE tag=\\"Comment\\""]',
 NULL, NULL, NULL, NULL, '2026-07-20 10:10:00', '2026-07-20 10:10:00'),

-- 4 pending: GETS Privacy (private read)
(9002004, 'pending', 'Privacy', 'gets', 'OWNER', 2,
 'POST', 'JSON', 'http://localhost:8080/gets',
 '{"Privacy":{"id":82001},"tag":"Privacy","version":2}',
 '{"MUST":"id","REFUSE":"_password,_payPassword","INSERT":{"@role":"OWNER"}}',
 'Privacy', 'Privacy', 'apijson_privacy', 'GETS Privacy',
 'Private fields — Request v2 + OWNER role',
 'req_seed_privacy_gets', 'sess_seed_4', 'owner-82001',
 '["no Request row for GETS tag=\\"Privacy\\" version=2"]',
 NULL, NULL, NULL, NULL, '2026-07-21 09:00:00', '2026-07-21 09:00:00'),

-- 5 pending: POST Comment (reply)
(9002005, 'pending', 'Comment', 'post', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/post',
 '{"Comment":{"momentId":12,"content":"nice!"},"tag":"Comment"}',
 '{"MUST":"momentId,content","REFUSE":"id","INSERT":{"@role":"OWNER"}}',
 'Comment', 'Comment', 'Comment', 'POST Comment',
 'Create comment under a moment',
 'req_seed_comment_post', 'sess_seed_5', 'carol',
 '["body.tag: no Request row for POST tag=\\"Comment\\""]',
 NULL, NULL, NULL, NULL, '2026-07-21 11:30:00', '2026-07-21 11:30:00'),

-- 6 pending: PUT Moment (edit content)
(9002006, 'pending', 'Moment', 'put', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/put',
 '{"Moment":{"id":12,"content":"edited"},"tag":"Moment"}',
 '{"MUST":"id","REFUSE":"userId,date","INSERT":{"@role":"OWNER"}}',
 'Moment', 'Moment', 'Moment', 'PUT Moment',
 'Edit own moment content',
 'req_seed_moment_put', 'sess_seed_6', 'dave',
 '["Access.put missing OWNER for Moment"]',
 NULL, NULL, NULL, NULL, '2026-07-22 08:15:00', '2026-07-22 08:15:00'),

-- 7 pending: GET User list (open-ish read with LOGIN)
(9002007, 'pending', 'User', 'get', 'LOGIN', 1,
 'POST', 'JSON', 'http://localhost:8080/get',
 '{"User[]":{"count":10,"User":{}},"tag":"User[]"}',
 '{"MUST":"","TYPE":{},"REFUSE":"!"}',
 'User[]', 'User', 'apijson_user', 'GET User[]',
 'List users for picker — need Access.get LOGIN',
 'req_seed_user_get', 'sess_seed_7', 'agent',
 '["Access.get does not allow LOGIN for User"]',
 NULL, NULL, NULL, NULL, '2026-07-22 14:00:00', '2026-07-22 14:00:00'),

-- 8 approved: POST Moment (already written)
(9002008, 'approved', 'Moment', 'post', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/post',
 '{"Moment":{"content":"approved sample"},"tag":"Moment"}',
 '{"INSERT":{"@role":"OWNER"},"REFUSE":"id"}',
 'Moment', 'Moment', 'Moment', 'POST Moment (approved)',
 'Sample approved application',
 'req_seed_approved_moment', 'sess_seed_8', 'eve',
 NULL,
 '{"Access":{"ok":true,"action":"put","id":16},"Request":{"ok":true,"action":"post","id":9002010},"Document":{"ok":true,"action":"post","id":9002011},"Chain":{"ok":true,"action":"post","id":9002012}}',
 NULL, 'admin-ui', '2026-07-23 16:00:00', '2026-07-23 15:55:00', '2026-07-23 16:00:00'),

-- 9 rejected: DELETE User (too risky)
(9002009, 'rejected', 'User', 'delete', 'ADMIN', 1,
 'POST', 'JSON', 'http://localhost:8080/delete',
 '{"User":{"id":38710},"tag":"User"}',
 '{"MUST":"id","INSERT":{"@role":"ADMIN"}}',
 'User', 'User', 'apijson_user', 'DELETE User',
 'Rejected — user delete not allowed in demo policy',
 'req_seed_user_del', 'sess_seed_9', 'mallory',
 '["Sensitive delete queued"]',
 NULL, 'policy: refuse User delete in demo', 'admin-ui', '2026-07-24 10:00:00',
 '2026-07-24 09:50:00', '2026-07-24 10:00:00'),

-- 10 pending: POST Praise (like moment) + ADMIN companion role
(9002010, 'pending', 'Praise', 'post', 'OWNER', 1,
 'POST', 'JSON', 'http://localhost:8080/post',
 '{"Praise":{"momentId":12},"tag":"Praise"}',
 '{"MUST":"momentId","REFUSE":"id","INSERT":{"@role":"OWNER"}}',
 'Praise', 'Praise', 'Praise', 'POST Praise',
 'Like a moment — new table Access + Request',
 'req_seed_praise_post', 'sess_seed_10', 'frank',
 '["no Access row for Praise","no Request row for POST tag=\\"Praise\\""]',
 NULL, NULL, NULL, NULL, '2026-07-25 01:00:00', '2026-07-25 01:00:00');
