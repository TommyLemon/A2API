import { SCHEMA_DICT } from "./schema-dict.js";
import { planFromIntent, type BootstrapPlan } from "./intent.js";
import { resolveLlmConfig, type LlmConfig } from "./llm-config.js";

/**
 * Optional OpenAI-compatible refinement. Falls back to deterministic intent planner.
 * When an API key is available (client override or OPENAI_API_KEY), asks the model
 * to pick/adjust a plan JSON; on failure uses rules.
 */
/** Chip / detail templates must not be rewritten into list binds by the LLM. */
const RULES_LOCKED_KINDS = new Set<BootstrapPlan["kind"]>([
  "get_user",
  "get_moment",
  "get_comment",
  "create_moment",
  "update_comment",
  "delete_comment",
]);

export async function bootstrapFromMessage(
  message: string,
  llmOverride?: LlmConfig | null,
): Promise<{ plan: BootstrapPlan; source: "rules" | "llm" }> {
  const rulesPlan = planFromIntent(message);
  const { apiKey, baseUrl, model, language } = resolveLlmConfig(llmOverride);

  if (!apiKey || RULES_LOCKED_KINDS.has(rulesPlan.kind)) {
    return { plan: rulesPlan, source: "rules" };
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You generate APIJSON proposeRequest bodies for A2API.
Reply language preference: ${language}.
${SCHEMA_DICT}
Return JSON: { "method": "get|post|put|delete", "body": {...}, "title": "...", "bindingId": "optional for reads" }
Only use APIJSON, never SQL.`,
          },
          { role: "user", content: message },
        ],
      }),
    });
    if (!res.ok) return { plan: rulesPlan, source: "rules" };
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { plan: rulesPlan, source: "rules" };
    const parsed = JSON.parse(content) as {
      method?: string;
      body?: Record<string, unknown>;
      title?: string;
      bindingId?: string;
    };
    if (!parsed.method || !parsed.body) {
      return { plan: rulesPlan, source: "rules" };
    }

    const method = parsed.method as BootstrapPlan["propose"]["method"];
    rulesPlan.propose.method = method;
    rulesPlan.propose.body = parsed.body;
    rulesPlan.propose.risk =
      method === "get" || method === "gets" || method === "head" || method === "heads"
        ? "read"
        : "write";
    if (parsed.title) rulesPlan.title = parsed.title;
    if (rulesPlan.bind && parsed.bindingId) {
      rulesPlan.bind.bindingId = parsed.bindingId;
      rulesPlan.bind.method = method;
      rulesPlan.bind.bodyTemplate = parsed.body;
    }
    return { plan: rulesPlan, source: "llm" };
  } catch {
    return { plan: rulesPlan, source: "rules" };
  }
}

/** One-shot repair using error message; returns revised body or null. */
export async function repairBody(
  method: string,
  body: Record<string, unknown>,
  errorMsg: string,
  llmOverride?: LlmConfig | null,
): Promise<Record<string, unknown> | null> {
  const { apiKey, baseUrl, model, language } = resolveLlmConfig(llmOverride);
  if (!apiKey) {
    const next = structuredClone(body);
    let changed = false;
    if (
      (method === "post" || method === "put" || method === "delete") &&
      typeof next.tag !== "string"
    ) {
      const tableKey = Object.keys(next).find(
        (k) => k !== "tag" && k !== "format" && typeof next[k] === "object",
      );
      if (tableKey) {
        next.tag = tableKey;
        changed = true;
      }
    }
    // Writes must never send userId — drop on any related error / always for writes
    if (method === "post" || method === "put" || method === "delete") {
      for (const [k, v] of Object.entries(next)) {
        if (
          /^[A-Z]/.test(k) &&
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          "userId" in (v as object)
        ) {
          delete (v as Record<string, unknown>).userId;
          changed = true;
        }
      }
    }
    return changed ? next : null;
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Fix the APIJSON request body so the call succeeds. Language: ${language}. ${SCHEMA_DICT} Do not invent Access/Request admin config — only fix the JSON body (tag, fields, types, MUST/REFUSE). Return { "body": { ... } } only.`,
          },
          {
            role: "user",
            content: JSON.stringify({ method, body, error: errorMsg }),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { body?: Record<string, unknown> };
    return parsed.body ?? null;
  } catch {
    return null;
  }
}
