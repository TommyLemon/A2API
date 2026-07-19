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
    `# ${title || "数据简报"}`,
    "",
    `## 概览`,
    `- 本页记录数：**${n}**`,
    `- 字段数：**${columns.length}**`,
    columns.length
      ? `- 字段：${columns.slice(0, 12).join("、")}${columns.length > 12 ? "…" : ""}`
      : "",
    "",
  ];

  // Simple numeric stats
  const numericCols = columns.filter((c) =>
    rows.some((r) => typeof r.cells[c] === "number"),
  );
  if (numericCols.length) {
    lines.push("## 数值字段");
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
        `- **${col}**：n=${vals.length}，最小 ${min}，最大 ${max}，平均 ${avg.toFixed(2)}`,
      );
    }
    lines.push("");
  }

  // Categorical top values for name-like fields
  const catCols = columns.filter((c) =>
    /name|content|tag|title/i.test(c),
  );
  if (catCols.length) {
    lines.push("## 分类摘录");
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
      lines.push(`- **${col}** 高频：`);
      for (const [k, c] of top) lines.push(`  - ${k}（${c}）`);
    }
    lines.push("");
  }

  lines.push("## 说明");
  lines.push(
    process.env.OPENAI_API_KEY
      ? "_（规则摘要；若模型调用失败则回退至此）_"
      : "_未配置 OPENAI_API_KEY，以上为本地规则摘要。配置后可生成更深入的 AI 分析报告。_",
  );
  return lines.filter((l) => l !== undefined).join("\n");
}

export async function analyzeRows(opts: {
  title?: string;
  columns: string[];
  rows: AnalyzeRow[];
  primaryTable?: string | null;
}): Promise<{ report: string; source: "llm" | "rules" }> {
  const title = opts.title || `${opts.primaryTable || "数据"}分析报告`;
  const sample = opts.rows.slice(0, 40).map((r) => {
    const slim: Record<string, unknown> = {};
    for (const c of opts.columns.slice(0, 24)) {
      const v = r.cells[c];
      if (v != null && v !== "") slim[c] = v;
    }
    return slim;
  });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      report: deterministicReport(title, opts.rows, opts.columns),
      source: "rules",
    };
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
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `你是数据分析助手。根据用户提供的当前页表格 JSON，用简体中文写一份结构化分析报告（Markdown）。
要求：
1. 含概览、关键指标、分布/异常、可执行建议 4 段
2. 只基于给定数据，不编造未出现的字段或数值
3. 控制在 800 字以内，可用列表与粗体`,
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
