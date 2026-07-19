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
  };
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

  if (wantsDelete && aboutComment) {
    const idMatch = matchCommentId(zh);
    const id = idMatch ? Number(idMatch[1]) : 0;
    const requestId = rid("del_comment");
    return {
      kind: "delete_comment",
      title: "Delete Comment",
      viewMode: "detail",
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
        fields: [{ key: "id", label: "Comment ID", path: "/Comment/id" }],
      },
    };
  }

  if (wantsUpdate && aboutComment) {
    const idMatch = matchCommentId(zh);
    const id = idMatch ? Number(idMatch[1]) : 1;
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

  if (wantsCreate && (aboutMoment || !aboutComment)) {
    const contentMatch =
      zh.match(/[「"'](.+?)[」"']/) ||
      zh.match(/(?:内容|content)[为是:：]\s*(.+)$/i) ||
      text.match(/content\s*[:=]\s*(.+)$/i) ||
      text.match(/[「"'](.+?)[」"']/);
    const content = contentMatch?.[1]?.trim() || "Hello from A2API";
    const requestId = rid("post_moment");
    return {
      kind: "create_moment",
      title: "Create Moment",
      viewMode: "detail",
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
          { key: "userId", label: "User ID", path: "/Moment/userId" },
          { key: "content", label: "Content", path: "/Moment/content" },
        ],
      },
    };
  }

  // Single-record reads → detail form only (no table)
  const singleId = matchEntityId(zh);
  if (singleId && !wantsCreate && !wantsUpdate && !wantsDelete) {
    const id = Number(singleId[1]);
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
          body: {
            "[]": {
              count: 1,
              join: "@/User",
              Moment: { id },
              User: { "id@": "/Moment/userId", "@column": "id,name" },
            },
          },
          risk: "read",
          rationale: "Get one Moment with author",
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

  const wantsUserList =
    /用户列表|查看用户|list\s+users?|users?\s+list/.test(zh) ||
    /\b(?:user|users)\s+list\b/.test(text) ||
    /\blist\s+users?\b/.test(text);
  if ((aboutUser && !aboutMoment && !aboutComment) || wantsUserList) {
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
        join: "@/User,@/Moment",
        Comment: { "@order": "date-" },
        User: {
          "id@": "/Comment/userId",
          "@column": "name",
        },
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

  // Default: moment list with author
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
      join: "@/User",
      Moment: { "@order": "date-" },
      User: {
        "id@": "/Moment/userId",
        "@column": "name",
      },
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
