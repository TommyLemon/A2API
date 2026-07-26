-- Fix Apply create: APIJSON refuses client id on POST, so POST must use tag Apply
-- (alias → table Apply) without MUST:id. Run then reload Access/Request (or restart APIJSON).

DELETE FROM `Access` WHERE `id` = 9002 OR `alias` = 'Apply';
INSERT INTO `Access` (`id`, `debug`, `schema`, `name`, `alias`, `get`, `head`, `gets`, `heads`, `post`, `put`, `delete`, `date`, `detail`)
VALUES (
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

DELETE FROM `Request` WHERE `tag` = 'Apply' OR (`tag` = 'Apply' AND `method` = 'POST');
INSERT INTO `Request` (`id`, `debug`, `version`, `method`, `tag`, `structure`, `detail`, `date`) VALUES
(9001001, 0, 1, 'POST', 'Apply',
 '{"MUST":"bizTable,operation,method,url,request,status","REFUSE":"id","INSERT":{"@role":"LOGIN"}}',
 'Create A2API Apply via alias Apply (id auto-assigned)', NOW());
