import {
  A2API_VERSION,
  type BindRequestPayload,
  type ProposeRequestPayload,
  riskForMethod,
} from "@a2api/protocol";

export type ViewMode = "list" | "detail";

export interface BootstrapPlan {
  kind:
    | "list_moments"
    | "list_users"
    | "list_comments"
    | "get_user"
    | "get_moment"
    | "get_comment"
    | "create_moment"
    | "update_comment"
    | "delete_comment"
    | "unknown";
  title: string;
  /** list = paginated table; detail = single-record form only */
  viewMode: ViewMode;
  propose: ProposeRequestPayload;
  bind?: BindRequestPayload;
  a2uiHint: {
    surfaceId: string;
    filters: Array<{ key: string; label: string; type: "text" | "number" | "select"; options?: string[] }>;
  };
  /** Optional write fields for forms */
  writeForm?: {
    fields: Array<{ key: string; label: string; path: string }>;
    defaults?: Record<string, unknown>;
  };
  /** After list bind, open the Add form for the primary table */
  openCreate?: boolean;
}

function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const DEFAULT_BASE = process.env.APIJSON_BASE_URL ?? "http://localhost:8080";

/** Extract numeric id from Chinese or English entity phrases. */
function matchEntityId(message: string): RegExpMatchArray | null {
  return (
    message.match(/(?:user|moment|comment)\s+id\s*(\d+)/i) ||
    message.match(/(?:id\s*[=:：]?\s*)(\d+)/i) ||
    message.match(/(?:用户|动态|评论|user|moment|comment)\s*[#号]?\s*(\d+)/i) ||
    message.match(/(?:评论|comment)\s+(\d+)/i)
  );
}

/** Extract comment id for write operations. */
function matchCommentId(message: string): RegExpMatchArray | null {
  return (
    message.match(
      /(?:comment\s*(?:id\s*[=:：]?|#)?|评论\s*|id\s*[=:：]?\s*)(\d+)/i,
    ) || message.match(/(?:评论|comment)\s+(\d+)/i)
  );
}

export function planFromIntent(message: string): BootstrapPlan {
  const text = message.trim().toLowerCase();
  const zh = message.trim();

  const wantsDelete =
    /删除|删掉|delete|remove/.test(zh) || /delete|remove/.test(text);
  const wantsUpdate =
    /修改|更新|改成|编辑|update|put|change|edit/.test(zh) ||
    /update|edit|change/.test(text);
  const wantsCreate =
    /新增|创建|发一条|发布|post|create|add|publish/.test(zh) ||
    /create|post|add|publish/.test(text);
  const aboutComment =
    /评论|comment/.test(zh) ||
    /comment/.test(text) ||
    /\bcomments?\b/.test(text);
  const aboutUser =
    /用户|user/.test(zh) ||
    /\busers?\b/.test(text);
  const aboutMoment =
    /动态|moment|朋友圈/.test(zh) ||
    /moment/.test(text) ||
    /\bmoments?\b/.test(text);

  // Delete / update: never invent id — only when the user typed an explicit id.
  // Template chips must not embed sample ids (permission / OWNER issues).
  if (wantsDelete && aboutComment) {
    const idMatch = matchCommentId(zh);
    const id = idMatch ? Number(idMatch[1]) : NaN;
    if (Number.isFinite(id) && id > 0) {
      const requestId = rid("del_comment");
      return {
        kind: "delete_comment",
        title: "Delete Comment",
        viewMode: "detail",
        propose: {
          requestId,
          method: "delete",
          body: { Comment: { id }, tag: "Comment" },
          risk: "write",
          rationale: "Delete a Comment by id from the user message",
        },
        a2uiHint: {
          surfaceId: "comment_delete",
          filters: [],
        },
        writeForm: {
          fields: [{ key: "id", label: "Comment ID", path: "/Comment/id" }],
        },
      };
    }
    // No id → fall through to comment list; delete from the table UI
  }

  if (wantsUpdate && aboutComment) {
    const idMatch = matchCommentId(zh);
    const id = idMatch ? Number(idMatch[1]) : NaN;
    if (Number.isFinite(id) && id > 0) {
      const contentMatch =
        zh.match(/改成[「"']?(.+?)[」"']?\s*$/) ||
        zh.match(/内容[为是:：]\s*[「"']?(.+?)[」"']?\s*$/) ||
        text.match(/(?:to|as)\s+[「"']?(.+?)[」"']?\s*$/i) ||
        text.match(/content\s*[:=]\s*(.+)$/i);
      const content = contentMatch?.[1]?.trim() || "updated by A2API";
      const requestId = rid("put_comment");
      return {
        kind: "update_comment",
        title: "Update Comment",
        viewMode: "detail",
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
            { key: "id", label: "Comment ID", path: "/Comment/id" },
            { key: "content", label: "Content", path: "/Comment/content" },
          ],
        },
      };
    }
    // No id → fall through to comment list; edit a row from the UI
  }

  if (wantsCreate && (aboutMoment || !aboutComment)) {
    // Open Moment list + full create form (do not auto-POST — response only
    // returns id and the UI would show a single-field detail).
    const contentMatch =
      zh.match(/[「"'](.+?)[」"']/) ||
      zh.match(/(?:内容|content)[为是:：]\s*(.+)$/i) ||
      text.match(/content\s*[:=]\s*(.+)$/i) ||
      text.match(/[「"'](.+?)[」"']/);
    const content = contentMatch?.[1]?.trim();
    const requestId = rid("create_moment");
    const body = {
      "[]": {
        count: 20,
        page: 0,
        Moment: { "@order": "date-" },
      },
    };
    return {
      kind: "create_moment",
      title: "Create Moment",
      viewMode: "list",
      openCreate: true,
      propose: {
        requestId,
        method: "get",
        body,
        risk: "read",
        rationale: "List moments and open create form",
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
        surfaceId: "moment_create",
        filters: [
          { key: "keyword", label: "Content keyword", type: "text" },
          { key: "count", label: "Page size", type: "number" },
          { key: "page", label: "Page", type: "number" },
          {
            key: "order",
            label: "Sort",
            type: "select",
            options: ["date-", "date+", "id-", "id+"],
          },
        ],
      },
      writeForm: {
        fields: [
          { key: "content", label: "Content", path: "/Moment/content" },
        ],
        defaults: content ? { content } : undefined,
      },
    };
  }

  // Single-record-by-id reads are not offered as templates (hardcoded ids
  // break OWNER). Prefer list + click row. Explicit NL with an id still works.
  const singleId = matchEntityId(zh);
  if (
    singleId &&
    !wantsCreate &&
    !wantsUpdate &&
    !wantsDelete &&
    /\b(?:id|#|号)\b/i.test(zh)
  ) {
    const id = Number(singleId[1]);
    if (Number.isFinite(id) && id > 0) {
      if (aboutComment) {
        return {
          kind: "get_comment",
          title: `Comment #${id}`,
          viewMode: "detail",
          propose: {
            requestId: rid("get_comment"),
            method: "get",
            body: { Comment: { id } },
            risk: "read",
            rationale: "Get one Comment",
          },
          a2uiHint: { surfaceId: "comment_detail", filters: [] },
        };
      }
      if (aboutMoment) {
        return {
          kind: "get_moment",
          title: `Moment #${id}`,
          viewMode: "detail",
          propose: {
            requestId: rid("get_moment"),
            method: "get",
            body: { Moment: { id } },
            risk: "read",
            rationale: "Get one Moment",
          },
          a2uiHint: { surfaceId: "moment_detail", filters: [] },
        };
      }
      if (aboutUser) {
        return {
          kind: "get_user",
          title: `User #${id}`,
          viewMode: "detail",
          propose: {
            requestId: rid("get_user"),
            method: "get",
            body: { User: { id } },
            risk: "read",
            rationale: "Get one User",
          },
          a2uiHint: { surfaceId: "user_detail", filters: [] },
        };
      }
    }
  }

  // Current visitor profile — no hardcoded id (session injects visitorUserId).
  const wantsUserDetail =
    /用户详情|我的资料|个人资料|个人主页/.test(zh) ||
    /\buser\s*[-_]?\s*detail\b/.test(text) ||
    /\bmy\s+(?:profile|user|account)\b/.test(text) ||
    /\bshow\s+(?:my\s+)?user\b/.test(text);
  if (wantsUserDetail && !wantsCreate && !wantsUpdate && !wantsDelete) {
    return {
      kind: "get_user",
      title: "User Detail",
      viewMode: "detail",
      propose: {
        requestId: rid("get_user"),
        method: "get",
        // id filled from session.visitorUserId in orchestrator.ownerBody
        body: { User: {} },
        risk: "read",
        rationale: "Get the logged-in user's User record (detail)",
      },
      a2uiHint: { surfaceId: "user_detail", filters: [] },
    };
  }

  const wantsUserList =
    /用户列表|查看用户|list\s+users?|users?\s+list/.test(zh) ||
    /\b(?:user|users)\s+list\b/.test(text) ||
    /\blist\s+users?\b/.test(text);
  if (
    !wantsUserDetail &&
    ((aboutUser && !aboutMoment && !aboutComment) || wantsUserList)
  ) {
    const requestId = rid("list_users");
    const body = {
      "[]": {
        count: 20,
        page: 0,
        User: { "@column": "id,name,sex,tag", "@order": "date-" },
      },
    };
    return {
      kind: "list_users",
      title: "User List",
      viewMode: "list",
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
          { key: "keyword", label: "Name keyword", type: "text" },
          { key: "count", label: "Page size", type: "number" },
          { key: "page", label: "Page", type: "number" },
          {
            key: "order",
            label: "Sort",
            type: "select",
            options: ["date-", "date+", "name+", "name-"],
          },
        ],
      },
    };
  }

  const wantsCommentList =
    /评论列表|查看评论|list\s+comments?|comments?\s+list/.test(zh) ||
    /\b(?:comment|comments)\s+list\b/.test(text) ||
    /\blist\s+comments?\b/.test(text);
  if ((aboutComment && !wantsUpdate && !wantsDelete) || wantsCommentList) {
    const requestId = rid("list_comments");
    const body = {
      "[]": {
        count: 20,
        page: 0,
        join: "@/Moment",
        Comment: { "@order": "date-" },
        // No User JOIN — OWNER already scopes to the current visitor
        Moment: {
          "id@": "/Comment/momentId",
          "@column": "content",
        },
      },
    };
    return {
      kind: "list_comments",
      title: "Comment List",
      viewMode: "list",
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
          { key: "keyword", label: "Content keyword", type: "text" },
          { key: "count", label: "Page size", type: "number" },
          { key: "page", label: "Page", type: "number" },
          {
            key: "order",
            label: "Sort",
            type: "select",
            options: ["date-", "date+"],
          },
        ],
      },
    };
  }

  // Default: moment list (no User JOIN — OWNER already scopes to visitor)
  const requestId = rid("list_moments");
  const PAGE_COUNTS = [2, 3, 4, 5, 6, 10, 15, 20, 50, 100];
  const countMatch =
    zh.match(/(\d+)\s*条/) ||
    text.match(/\b(?:last|recent|top)\s+(\d+)\b/) ||
    text.match(/(\d+)\s+(?:moments?|items?|records?|rows?)\b/);
  const asked = countMatch ? Number(countMatch[1]) : 20;
  const count = PAGE_COUNTS.includes(asked) ? asked : 20;
  const body = {
    "[]": {
      count,
      page: 0,
      Moment: { "@order": "date-" },
    },
  };
  const wantsRecentMoments =
    /最近|recent|latest/.test(zh) || /\b(?:recent|latest)\s+moments?\b/.test(text);
  return {
    kind: "list_moments",
    title: wantsRecentMoments ? "Recent Moments" : "Moment List",
    viewMode: "list",
    propose: {
      requestId,
      method: "get",
      body,
      risk: "read",
      rationale: "List moments for the current user",
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
        { key: "keyword", label: "Content keyword", type: "text" },
        { key: "count", label: "Page size", type: "number" },
        { key: "page", label: "Page", type: "number" },
        {
          key: "order",
          label: "Sort",
          type: "select",
          options: ["date-", "date+", "id-", "id+"],
        },
      ],
    },
  };
}

export function toProposeEnvelope(propose: ProposeRequestPayload) {
  return { version: A2API_VERSION, proposeRequest: propose };
}

export function toBindEnvelope(bind: BindRequestPayload) {
  return { version: A2API_VERSION, bindRequest: bind };
}
