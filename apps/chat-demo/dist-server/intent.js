import { A2API_VERSION, riskForMethod, } from "@a2api/protocol";
function rid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
const DEFAULT_BASE = process.env.APIJSON_BASE_URL ?? "http://localhost:8080";
export function planFromIntent(message) {
    const text = message.trim().toLowerCase();
    const zh = message.trim();
    const wantsDelete = /删除|删掉|delete/.test(zh) || /delete/.test(text);
    const wantsUpdate = /修改|更新|改成|编辑|update|put/.test(zh) || /update|edit/.test(text);
    const wantsCreate = /新增|创建|发一条|发布|post|create|add/.test(zh) || /create|post|add/.test(text);
    const aboutComment = /评论|comment/.test(zh) || /comment/.test(text);
    const aboutUser = /用户|user/.test(zh) || /\buser/.test(text);
    const aboutMoment = /动态|moment|朋友圈/.test(zh) || /moment/.test(text);
    if (wantsDelete && aboutComment) {
        const idMatch = zh.match(/(?:id\s*[=:：]?\s*|评论\s*)(\d+)/i);
        const id = idMatch ? Number(idMatch[1]) : 0;
        const requestId = rid("del_comment");
        return {
            kind: "delete_comment",
            title: "删除评论",
            propose: {
                requestId,
                method: "delete",
                body: { Comment: { id: id || 1 }, tag: "Comment" },
                risk: "write",
                rationale: "Delete a Comment by id",
            },
            a2uiHint: {
                surfaceId: "comment_delete",
                filters: [],
            },
            writeForm: {
                fields: [{ key: "id", label: "评论 ID", path: "/Comment/id" }],
            },
        };
    }
    if (wantsUpdate && aboutComment) {
        const idMatch = zh.match(/(?:id\s*[=:：]?\s*|评论\s*)(\d+)/i);
        const id = idMatch ? Number(idMatch[1]) : 1;
        const contentMatch = zh.match(/改成[「"']?(.+?)[」"']?\s*$/) ||
            zh.match(/内容[为是:：]\s*[「"']?(.+?)[」"']?\s*$/);
        const content = contentMatch?.[1]?.trim() || "updated by A2API";
        const requestId = rid("put_comment");
        return {
            kind: "update_comment",
            title: "修改评论",
            propose: {
                requestId,
                method: "put",
                body: { Comment: { id, content }, tag: "Comment" },
                risk: "write",
                rationale: "Update Comment content",
            },
            a2uiHint: {
                surfaceId: "comment_edit",
                filters: [],
            },
            writeForm: {
                fields: [
                    { key: "id", label: "评论 ID", path: "/Comment/id" },
                    { key: "content", label: "内容", path: "/Comment/content" },
                ],
            },
        };
    }
    if (wantsCreate && (aboutMoment || !aboutComment)) {
        const contentMatch = zh.match(/[「"'](.+?)[」"']/) ||
            zh.match(/(?:内容|content)[为是:：]\s*(.+)$/i);
        const content = contentMatch?.[1]?.trim() || "Hello from A2API";
        const requestId = rid("post_moment");
        return {
            kind: "create_moment",
            title: "发布动态",
            propose: {
                requestId,
                method: "post",
                body: {
                    Moment: { userId: 38710, content },
                    tag: "Moment",
                },
                risk: "write",
                rationale: "Create a Moment",
            },
            a2uiHint: {
                surfaceId: "moment_create",
                filters: [],
            },
            writeForm: {
                fields: [
                    { key: "userId", label: "用户 ID", path: "/Moment/userId" },
                    { key: "content", label: "内容", path: "/Moment/content" },
                ],
            },
        };
    }
    if (aboutUser && !aboutMoment && !aboutComment) {
        const requestId = rid("list_users");
        const body = {
            "[]": {
                count: 5,
                page: 0,
                User: { "@column": "id,name,sex,tag", "@order": "date-" },
            },
        };
        return {
            kind: "list_users",
            title: "用户列表",
            propose: {
                requestId,
                method: "get",
                body,
                risk: riskForMethod("get"),
                rationale: "List users",
            },
            bind: {
                bindingId: "user_list",
                method: "get",
                url: `${DEFAULT_BASE}/get`,
                bodyTemplate: body,
                paramMap: [
                    { from: "/ui/page", to: "/[]/page" },
                    { from: "/ui/count", to: "/[]/count" },
                    { from: "/ui/order", to: "/[]/User/@order" },
                    { from: "/ui/keyword", to: "/[]/User/name$" },
                ],
                resultPath: "/rows",
                triggerActions: ["search", "page_change", "sort_change"],
            },
            a2uiHint: {
                surfaceId: "user_list",
                filters: [
                    { key: "keyword", label: "姓名关键词", type: "text" },
                    { key: "count", label: "每页条数", type: "number" },
                    { key: "page", label: "页码", type: "number" },
                    {
                        key: "order",
                        label: "排序",
                        type: "select",
                        options: ["date-", "date+", "name+", "name-"],
                    },
                ],
            },
        };
    }
    if (aboutComment && !wantsUpdate && !wantsDelete) {
        const requestId = rid("list_comments");
        const body = {
            "[]": {
                count: 5,
                page: 0,
                Comment: { "@order": "date-" },
            },
        };
        return {
            kind: "list_comments",
            title: "评论列表",
            propose: {
                requestId,
                method: "get",
                body,
                risk: "read",
                rationale: "List comments",
            },
            bind: {
                bindingId: "comment_list",
                method: "get",
                url: `${DEFAULT_BASE}/get`,
                bodyTemplate: body,
                paramMap: [
                    { from: "/ui/page", to: "/[]/page" },
                    { from: "/ui/count", to: "/[]/count" },
                    { from: "/ui/order", to: "/[]/Comment/@order" },
                    { from: "/ui/keyword", to: "/[]/Comment/content$" },
                ],
                resultPath: "/rows",
                triggerActions: ["search", "page_change", "sort_change"],
            },
            a2uiHint: {
                surfaceId: "comment_list",
                filters: [
                    { key: "keyword", label: "内容关键词", type: "text" },
                    { key: "count", label: "每页条数", type: "number" },
                    { key: "page", label: "页码", type: "number" },
                    {
                        key: "order",
                        label: "排序",
                        type: "select",
                        options: ["date-", "date+"],
                    },
                ],
            },
        };
    }
    // Default: moment list with author
    const requestId = rid("list_moments");
    const countMatch = zh.match(/(\d+)\s*条/);
    const count = countMatch ? Number(countMatch[1]) : 3;
    const body = {
        "[]": {
            count,
            page: 0,
            Moment: { "@order": "date-" },
            User: {
                "id@": "/[]/Moment/userId",
                "@column": "id,name,head",
            },
        },
    };
    return {
        kind: "list_moments",
        title: "动态列表",
        propose: {
            requestId,
            method: "get",
            body,
            risk: "read",
            rationale: "List moments with authors",
        },
        bind: {
            bindingId: "moment_list",
            method: "get",
            url: `${DEFAULT_BASE}/get`,
            bodyTemplate: body,
            paramMap: [
                { from: "/ui/page", to: "/[]/page" },
                { from: "/ui/count", to: "/[]/count" },
                { from: "/ui/order", to: "/[]/Moment/@order" },
                { from: "/ui/keyword", to: "/[]/Moment/content$" },
            ],
            resultPath: "/rows",
            triggerActions: ["search", "page_change", "sort_change"],
        },
        a2uiHint: {
            surfaceId: "moment_list",
            filters: [
                { key: "keyword", label: "内容关键词", type: "text" },
                { key: "count", label: "每页条数", type: "number" },
                { key: "page", label: "页码", type: "number" },
                {
                    key: "order",
                    label: "排序",
                    type: "select",
                    options: ["date-", "date+", "id-", "id+"],
                },
            ],
        },
    };
}
export function toProposeEnvelope(propose) {
    return { version: A2API_VERSION, proposeRequest: propose };
}
export function toBindEnvelope(bind) {
    return { version: A2API_VERSION, bindRequest: bind };
}
//# sourceMappingURL=intent.js.map