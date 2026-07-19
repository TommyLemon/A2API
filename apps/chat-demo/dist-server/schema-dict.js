/** Few-shot table dictionary for APIJSON-Demo (User / Moment / Comment). */
export const SCHEMA_DICT = `
Tables (APIJSON-Demo):
- User: id, sex, name, tag, head, contactIdList, pictureList, date
- Moment: id, userId, date, content, praiseUserIdList, commentCount
- Comment: id, toId, userId, momentId, content, date

Common APIJSON patterns:
GET list:
{ "[]": { "count": 3, "page": 0, "Moment": { "@order": "date-" }, "User": { "id@": "/[]/Moment/userId", "@column": "id,name,head" } } }

GET one:
{ "User": { "id": 38710 } }

POST:
{ "Moment": { "userId": 38710, "content": "..." }, "tag": "Moment" }

PUT:
{ "Comment": { "id": 1, "content": "..." }, "tag": "Comment" }

DELETE:
{ "Comment": { "id": 1 }, "tag": "Comment" }
`.trim();
//# sourceMappingURL=schema-dict.js.map