-- Fix Call Access: id 9002 was reused by Apply alias Apply, wiping Call GET rights.
-- Run against APIJSON Demo DB, then reload Access (or restart APIJSON).

DELETE FROM `Access`
WHERE `id` = 9003
   OR `alias` = 'Call'
   OR (`name` = 'Call' AND (`alias` IS NULL OR `alias` = '' OR `alias` = 'Call'));

-- Remove stale Call row that incorrectly occupied 9002 (keep Apply on 9002).
DELETE FROM `Access`
WHERE `id` = 9002 AND (`alias` = 'Call' OR `name` = 'Call');

INSERT INTO `Access` (`id`, `debug`, `schema`, `name`, `alias`, `get`, `head`, `gets`, `heads`, `post`, `put`, `delete`, `date`, `detail`)
VALUES (
  9003, 0, NULL, 'Call', 'Call',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["LOGIN", "OWNER", "ADMIN"]',
  '["ADMIN"]',
  '["ADMIN"]',
  NOW(),
  'A2API APIJSON call logs'
);

DELETE FROM `Request` WHERE `id` IN (9003001, 9003002, 9003003) OR `tag` = 'Call';
INSERT INTO `Request` (`id`, `debug`, `version`, `method`, `tag`, `structure`, `detail`, `date`) VALUES
(9003001, 0, 1, 'POST', 'Call',
 '{"MUST":"id,operation,method,url,ok","INSERT":{"@role":"LOGIN"}}',
 'Create A2API Call log', NOW()),
(9003002, 0, 1, 'PUT', 'Call',
 '{"MUST":"id","INSERT":{"@role":"ADMIN"}}',
 'Update Call log', NOW()),
(9003003, 0, 1, 'GETS', 'Call',
 '{}',
 'List Call logs', NOW());
