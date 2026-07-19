import { A2API_VERSION, validateProposeRequest, } from "@a2api/protocol";
import { ApiJsonClient, BoundExecutor, HitlController, } from "@a2api/runtime";
import { bootstrapFromMessage, repairBody } from "./llm.js";
import { toBindEnvelope, toProposeEnvelope, } from "./intent.js";
function buildA2uiMessages(plan) {
    const surfaceId = plan.a2uiHint.surfaceId;
    return [
        {
            version: "v0.9",
            createSurface: {
                surfaceId,
                catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
            },
        },
        {
            version: "v0.9",
            updateComponents: {
                surfaceId,
                components: [
                    { id: "root", component: "Column", children: ["title", "filters", "results"] },
                    {
                        id: "title",
                        component: "Text",
                        text: plan.title,
                        variant: "h2",
                    },
                    {
                        id: "filters",
                        component: "Text",
                        text: "Filters bound to APIJSON via A2API bindRequest (no LLM on change)",
                        variant: "caption",
                    },
                    {
                        id: "results",
                        component: "Text",
                        text: { path: "/rowsSummary" },
                    },
                ],
            },
        },
    ];
}
export class Orchestrator {
    client;
    hitl;
    bound;
    sessions = new Map();
    constructor(baseUrl = process.env.APIJSON_BASE_URL ?? "http://localhost:8080") {
        this.client = new ApiJsonClient({ baseUrl });
        this.hitl = new HitlController({ client: this.client });
        this.bound = new BoundExecutor({ client: this.client });
    }
    getOrCreateSession(sessionId) {
        const id = sessionId || `s_${Date.now().toString(36)}`;
        let s = this.sessions.get(id);
        if (!s) {
            s = {
                id,
                messages: [],
                a2uiMessages: [],
                dataModel: {
                    ui: { page: 0, count: 3, order: "date-", keyword: "" },
                    rows: null,
                },
            };
            this.sessions.set(id, s);
        }
        return s;
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    async chat(sessionId, message) {
        const session = this.getOrCreateSession(sessionId);
        session.messages.push({ role: "user", content: message });
        const { plan, source } = await bootstrapFromMessage(message);
        session.plan = plan;
        session.a2uiMessages = buildA2uiMessages(plan);
        // Seed write form / list defaults into data model
        if (plan.bind) {
            const count = Number(plan.bind.bodyTemplate["[]"]?.count ??
                3);
            session.dataModel.ui.count = count;
            const order = plan.bind.bodyTemplate["[]"]?.[Object.keys(plan.bind.bodyTemplate["[]"] || {}).find((k) => k !== "count" && k !== "page") || ""]?.["@order"] || "date-";
            session.dataModel.ui.order = order;
        }
        if (plan.writeForm) {
            session.dataModel.write = structuredClone(plan.propose.body);
        }
        let pending = this.hitl.propose(plan.propose);
        const envelopes = [toProposeEnvelope(plan.propose)];
        if (pending.status === "failed") {
            const repaired = await repairBody(plan.propose.method, plan.propose.body, pending.issues?.join("; ") ?? "validation failed");
            if (repaired) {
                pending = this.hitl.revise({
                    requestId: plan.propose.requestId,
                    body: repaired,
                });
                plan.propose.body = repaired;
                envelopes.push({
                    version: A2API_VERSION,
                    reviseRequest: {
                        requestId: plan.propose.requestId,
                        body: repaired,
                    },
                });
            }
        }
        pending = await this.hitl.advance(plan.propose.requestId);
        session.pending = pending;
        const response = {
            sessionId: session.id,
            source,
            title: plan.title,
            kind: plan.kind,
            a2uiMessages: session.a2uiMessages,
            a2apiEnvelopes: envelopes,
            pending,
            plan: {
                filters: plan.a2uiHint.filters,
                writeForm: plan.writeForm,
                surfaceId: plan.a2uiHint.surfaceId,
            },
            dataModel: session.dataModel,
        };
        if (pending.status === "awaiting_approval") {
            session.messages.push({
                role: "assistant",
                content: `已生成写操作请求，请审批后执行（${plan.propose.method.toUpperCase()}）。`,
            });
            response.assistantMessage =
                `已生成写操作，等待审批。可编辑 JSON 后 Approve。来源: ${source}`;
            return response;
        }
        if (pending.status === "done" && pending.result?.ok) {
            session.lastResult = pending.result.body;
            session.dataModel.rows = pending.result.body;
            envelopes.push({
                version: A2API_VERSION,
                requestResult: {
                    requestId: pending.requestId,
                    ok: true,
                    status: pending.result.status,
                    body: pending.result.body,
                },
            });
            if (plan.bind) {
                // Only bind after successful HTTP
                const bind = {
                    ...plan.bind,
                    bodyTemplate: structuredClone(plan.propose.body),
                };
                this.bound.register(bind);
                session.bind = bind;
                envelopes.push(toBindEnvelope(bind));
                session.messages.push({
                    role: "assistant",
                    content: `已调通 ${plan.title}。后续改筛选/排序/翻页将直接调用 APIJSON，不再经过 AI。`,
                });
                response.assistantMessage =
                    `已调通「${plan.title}」并绑定 UI。改条件将直调 APIJSON（来源: ${source}）。`;
                response.bind = bind;
            }
            else {
                session.messages.push({
                    role: "assistant",
                    content: `写/单次操作已完成。`,
                });
                response.assistantMessage = `操作成功（来源: ${source}）。`;
            }
            response.lastResult = pending.result.body;
            return response;
        }
        // Failed after execute — one repair retry
        if (pending.status === "failed" && pending.result) {
            const repaired = await repairBody(pending.method, pending.body, pending.result.error ?? "failed");
            if (repaired) {
                pending = this.hitl.revise({
                    requestId: pending.requestId,
                    body: repaired,
                });
                pending = await this.hitl.advance(pending.requestId);
                session.pending = pending;
                if (pending.status === "done" && pending.result?.ok && plan.bind) {
                    const bind = {
                        ...plan.bind,
                        bodyTemplate: structuredClone(repaired),
                    };
                    this.bound.register(bind);
                    session.bind = bind;
                    session.dataModel.rows = pending.result.body;
                    response.bind = bind;
                    response.assistantMessage = `首次失败已自动修正并调通「${plan.title}」。`;
                    response.lastResult = pending.result.body;
                    response.pending = pending;
                    return response;
                }
            }
        }
        response.assistantMessage = `未能调通 APIJSON：${pending.issues?.join("; ") || pending.result?.error || "unknown"}。可手工修改请求后重试。`;
        session.messages.push({
            role: "assistant",
            content: String(response.assistantMessage),
        });
        return response;
    }
    async decide(sessionId, requestId, action, revisedBody) {
        const session = this.getSession(sessionId);
        if (!session)
            throw new Error("session not found");
        if (revisedBody) {
            this.hitl.revise({ requestId, body: revisedBody });
            // re-enter awaiting if write
            const p = this.hitl.getPending(requestId);
            if (p && p.status === "validated") {
                await this.hitl.advance(requestId);
            }
        }
        const pending = await this.hitl.decide(requestId, action);
        session.pending = pending;
        if (pending.status === "done" && pending.result?.ok) {
            session.lastResult = pending.result.body;
            session.dataModel.rows = pending.result.body;
        }
        return { pending, dataModel: session.dataModel, lastResult: session.lastResult };
    }
    async boundAction(sessionId, action, uiPatch) {
        const session = this.getSession(sessionId);
        if (!session?.bind)
            throw new Error("no active binding; bootstrap via chat first");
        if (uiPatch) {
            session.dataModel.ui = { ...session.dataModel.ui, ...uiPatch };
        }
        if (!this.bound.handlesAction(session.bind.bindingId, action)) {
            // still allow refresh-like actions
            if (!["search", "page_change", "sort_change", "refresh"].includes(action)) {
                throw new Error(`action not bound: ${action}`);
            }
        }
        const { body, result } = await this.bound.execute(session.bind.bindingId, {
            action,
            dataModel: session.dataModel,
        });
        if (result.ok) {
            session.lastResult = result.body;
            session.dataModel.rows = result.body;
        }
        return {
            action,
            usedLlm: false,
            requestBody: body,
            url: session.bind.url,
            result,
            dataModel: session.dataModel,
        };
    }
    async retryPropose(sessionId, body) {
        const session = this.getSession(sessionId);
        if (!session?.plan)
            throw new Error("no plan");
        const requestId = session.plan.propose.requestId;
        let pending = this.hitl.revise({ requestId, body });
        pending = await this.hitl.advance(requestId);
        session.pending = pending;
        session.plan.propose.body = body;
        if (pending.status === "done" && pending.result?.ok && session.plan.bind) {
            const bind = {
                ...session.plan.bind,
                bodyTemplate: structuredClone(body),
            };
            // keep read validation happy
            const v = validateProposeRequest({
                requestId,
                method: bind.method,
                body,
            });
            if (v.ok) {
                this.bound.register(bind);
                session.bind = bind;
            }
            session.dataModel.rows = pending.result.body;
        }
        return { pending, bind: session.bind, dataModel: session.dataModel };
    }
}
//# sourceMappingURL=orchestrator.js.map