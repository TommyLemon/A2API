import { SCHEMA_DICT } from "./schema-dict.js";
import { planFromIntent, type BootstrapPlan } from "./intent.js";

/**
 * Optional OpenAI-compatible refinement. Falls back to deterministic intent planner.
 * When OPENAI_API_KEY is set, asks the model to pick/adjust a plan JSON; on failure uses rules.
 */
export async function bootstrapFromMessage(
  message: string,
): Promise<{ plan: BootstrapPlan; source: "rules" | "llm" }> {
  const rulesPlan = planFromIntent(message);
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = (
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  if (!apiKey) {
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
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Deterministic repairs for common mistakes
    const next = structuredClone(body);
    if (
      (method === "post" || method === "put" || method === "delete") &&
      typeof next.tag !== "string"
    ) {
      const tableKey = Object.keys(next).find(
        (k) => k !== "tag" && k !== "format" && typeof next[k] === "object",
      );
      if (tableKey) next.tag = tableKey;
      return next;
    }
    return null;
  }

  const baseUrl = (
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
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
            content: `Fix the APIJSON body. ${SCHEMA_DICT} Return { "body": { ... } } only.`,
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
