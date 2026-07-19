/**
 * One-shot AI analysis report over current list rows.
 * Falls back to a deterministic summary when no API key.
 */

export type AnalyzeRow = {
  key: string;
  cells: Record<string, unknown>;
};

function deterministicReport(
  title: string,
  rows: AnalyzeRow[],
  columns: string[],
): string {
  const n = rows.length;
  const lines: string[] = [
    `# ${title || "Data Summary"}`,
    "",
    `## Overview`,
    `- Records on this page: **${n}**`,
    `- Field count: **${columns.length}**`,
    columns.length
      ? `- Fields: ${columns.slice(0, 12).join(", ")}${columns.length > 12 ? "…" : ""}`
      : "",
    "",
  ];

  // Simple numeric stats
  const numericCols = columns.filter((c) =>
    rows.some((r) => typeof r.cells[c] === "number"),
  );
  if (numericCols.length) {
    lines.push("## Numeric Fields");
    for (const col of numericCols.slice(0, 8)) {
      const vals = rows
        .map((r) => r.cells[col])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (!vals.length) continue;
      const sum = vals.reduce((a, b) => a + b, 0);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const avg = sum / vals.length;
      lines.push(
        `- **${col}**: n=${vals.length}, min ${min}, max ${max}, avg ${avg.toFixed(2)}`,
      );
    }
    lines.push("");
  }

  // Categorical top values for name-like fields
  const catCols = columns.filter((c) =>
    /name|content|tag|title/i.test(c),
  );
  if (catCols.length) {
    lines.push("## Categorical Highlights");
    for (const col of catCols.slice(0, 4)) {
      const freq = new Map<string, number>();
      for (const r of rows) {
        const s = String(r.cells[col] ?? "").trim();
        if (!s) continue;
        const key = s.length > 40 ? s.slice(0, 39) + "…" : s;
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
      const top = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      if (!top.length) continue;
      lines.push(`- **${col}** top values:`);
      for (const [k, c] of top) lines.push(`  - ${k} (${c})`);
    }
    lines.push("");
  }

  lines.push("## Notes");
  lines.push(
    "_Rule-based summary (no API key, or model call failed). Set AI API Key in the account menu for deeper reports._",
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

import { resolveLlmConfig, type LlmConfig } from "./llm-config.js";

export async function analyzeRows(opts: {
  title?: string;
  columns: string[];
  rows: AnalyzeRow[];
  primaryTable?: string | null;
  llm?: LlmConfig | null;
}): Promise<{ report: string; source: "llm" | "rules" }> {
  const title = opts.title || `${opts.primaryTable || "Data"} Analysis Report`;
  const sample = opts.rows.slice(0, 40).map((r) => {
    const slim: Record<string, unknown> = {};
    for (const c of opts.columns.slice(0, 24)) {
      const v = r.cells[c];
      if (v != null && v !== "") slim[c] = v;
    }
    return slim;
  });

  const { apiKey, baseUrl, model, language } = resolveLlmConfig(opts.llm);
  if (!apiKey) {
    return {
      report: deterministicReport(title, opts.rows, opts.columns),
      source: "rules",
    };
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
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `You are a data analysis assistant. Given the current-page table JSON from the user, write a structured analysis report in language: ${language} (Markdown).
Requirements:
1. Include overview, key metrics, distribution/anomalies, and actionable recommendations
2. Base conclusions only on the provided data; do not invent fields or values
3. Keep it under 800 words; use lists and bold text where helpful`,
          },
          {
            role: "user",
            content: JSON.stringify({
              title,
              primaryTable: opts.primaryTable,
              columns: opts.columns,
              rowCount: opts.rows.length,
              sample,
            }),
          },
        ],
      }),
    });
    if (!res.ok) {
      return {
        report: deterministicReport(title, opts.rows, opts.columns),
        source: "rules",
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return {
        report: deterministicReport(title, opts.rows, opts.columns),
        source: "rules",
      };
    }
    return { report: content, source: "llm" };
  } catch {
    return {
      report: deterministicReport(title, opts.rows, opts.columns),
      source: "rules",
    };
  }
}
