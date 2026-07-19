/** Shared OpenAI-compatible LLM settings (env defaults + optional client overrides). */

export type LlmConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** BCP-47 language tag for model replies, e.g. en / zh-CN */
  language?: string;
};

export function resolveLlmConfig(override?: LlmConfig | null): {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  language: string;
} {
  const apiKey =
    (override?.apiKey && override.apiKey.trim()) ||
    process.env.OPENAI_API_KEY ||
    undefined;
  const baseUrl = (
    (override?.baseUrl && override.baseUrl.trim()) ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model =
    (override?.model && override.model.trim()) ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";
  const language =
    (override?.language && override.language.trim()) ||
    process.env.OPENAI_LANGUAGE ||
    "en";
  return { apiKey, baseUrl, model, language };
}
