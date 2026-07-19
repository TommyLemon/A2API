import { type BindRequestPayload } from "@a2api/protocol";
import { ApiJsonClient, BoundExecutor, HitlController, type PendingRequest } from "@a2api/runtime";
import { type BootstrapPlan } from "./intent.js";
export interface SessionState {
    id: string;
    messages: Array<{
        role: "user" | "assistant" | "system";
        content: string;
    }>;
    plan?: BootstrapPlan;
    pending?: PendingRequest;
    bind?: BindRequestPayload;
    lastResult?: unknown;
    a2uiMessages: unknown[];
    dataModel: {
        ui: {
            page: number;
            count: number;
            order: string;
            keyword: string;
        };
        rows: unknown;
        write?: Record<string, unknown>;
    };
}
export declare class Orchestrator {
    readonly client: ApiJsonClient;
    readonly hitl: HitlController;
    readonly bound: BoundExecutor;
    private readonly sessions;
    constructor(baseUrl?: string);
    getOrCreateSession(sessionId?: string): SessionState;
    getSession(sessionId: string): SessionState | undefined;
    chat(sessionId: string | undefined, message: string): Promise<Record<string, unknown>>;
    decide(sessionId: string, requestId: string, action: "approve" | "reject", revisedBody?: Record<string, unknown>): Promise<{
        pending: PendingRequest;
        dataModel: {
            ui: {
                page: number;
                count: number;
                order: string;
                keyword: string;
            };
            rows: unknown;
            write?: Record<string, unknown>;
        };
        lastResult: unknown;
    }>;
    boundAction(sessionId: string, action: string, uiPatch?: Partial<SessionState["dataModel"]["ui"]>): Promise<{
        action: string;
        usedLlm: boolean;
        requestBody: Record<string, unknown>;
        url: string;
        result: import("@a2api/runtime").ApiJsonHttpResult;
        dataModel: {
            ui: {
                page: number;
                count: number;
                order: string;
                keyword: string;
            };
            rows: unknown;
            write?: Record<string, unknown>;
        };
    }>;
    retryPropose(sessionId: string, body: Record<string, unknown>): Promise<{
        pending: PendingRequest;
        bind: BindRequestPayload | undefined;
        dataModel: {
            ui: {
                page: number;
                count: number;
                order: string;
                keyword: string;
            };
            rows: unknown;
            write?: Record<string, unknown>;
        };
    }>;
}
//# sourceMappingURL=orchestrator.d.ts.map