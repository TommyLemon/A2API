/** Few-shot table dictionary for APIJSON-Demo (User / Moment / Comment). */
export const SCHEMA_DICT = `
Tables (APIJSON-Demo):
- User: id, sex, name, tag, head, contactIdList, pictureList, date
- Moment: id, userId, date, content, praiseUserIdList, commentCount
- Comment: id, toId, userId, momentId, content, date

Identity / role / structure rules for generated requests:
- Never hardcode id or userId (no sample ids like 38710 / 1 / 22).
- Do not set outermost "@role" on POST/PUT/DELETE (server fills).
- GET/HEAD (open): client may set "@role" to Access minimum for the tables.
- Non-open methods (gets/post/put/delete, or GET with tag): must match Request
  table (method + tag + version) — honor structure MUST/REFUSE/TYPE/VERIFY.
- POST Moment/Comment: omit userId — session injects the visitor.
- Prefer list queries; open a row in the UI for detail / edit / delete.
- Do not JOIN User by default when the session already scopes the visitor.

Common APIJSON patterns:
GET list:
{ "[]": { "count": 20, "page": 0, "Moment": { "@order": "date-" } } }

POST:
{ "Moment": { "content": "..." }, "tag": "Moment" }

PUT (id must come from the user-selected row, never invent one):
{ "Comment": { "content": "..." }, "tag": "Comment" }

DELETE: do not invent an id — list first, then delete from the UI.
`.trim();
