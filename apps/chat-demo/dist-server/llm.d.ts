import { type BootstrapPlan } from "./intent.js";
/**
 * Optional OpenAI-compatible refinement. Falls back to deterministic intent planner.
 * When OPENAI_API_KEY is set, asks the model to pick/adjust a plan JSON; on failure uses rules.
 */
export declare function bootstrapFromMessage(message: string): Promise<{
    plan: BootstrapPlan;
    source: "rules" | "llm";
}>;
/** One-shot repair using error message; returns revised body or null. */
export declare function repairBody(method: string, body: Record<string, unknown>, errorMsg: string): Promise<Record<string, unknown> | null>;
//# sourceMappingURL=llm.d.ts.map