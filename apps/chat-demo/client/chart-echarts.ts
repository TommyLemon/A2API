/** ECharts renderer — multi-series charts with per-field colors. */

import * as echarts from "echarts";
import type { ChartKind, ChartPoint } from "./charts.js";

export type ChartSeriesInput = {
  /** Legend / series name */
  name: string;
  color: string;
  points: ChartPoint[];
};

const instances = new WeakMap<HTMLElement, echarts.ECharts>();

export function disposeChart(host: HTMLElement): void {
  const chart = instances.get(host);
  if (chart) {
    chart.dispose();
    instances.delete(host);
  }
}

function ensureChart(host: HTMLElement): echarts.ECharts {
  let chart = instances.get(host);
  if (chart && !chart.isDisposed()) return chart;
  host.innerHTML = "";
  host.style.width = "100%";
  host.style.minHeight = "280px";
  host.style.height = "280px";
  chart = echarts.init(host, undefined, { renderer: "canvas" });
  instances.set(host, chart);
  return chart;
}

function mergeCategories(series: ChartSeriesInput[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of series) {
    for (const p of s.points) {
      if (!seen.has(p.label)) {
        seen.add(p.label);
        out.push(p.label);
      }
    }
  }
  return out;
}

function seriesDataAligned(
  series: ChartSeriesInput[],
  categories: string[],
): Array<{ name: string; color: string; data: number[] }> {
  return series.map((s) => {
    const map = new Map(s.points.map((p) => [p.label, p.value]));
    return {
      name: s.name,
      color: s.color,
      data: categories.map((c) => map.get(c) ?? 0),
    };
  });
}

const PIE_FALLBACK = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

/**
 * Render one chart. Multiple series → different colors in the same plot
 * (bar / line / area). Pie / doughnut: one ring per field (concentric).
 */
export function renderEcharts(
  host: HTMLElement,
  kind: ChartKind,
  series: ChartSeriesInput[],
  title: string,
): void {
  if (!series.length || series.every((s) => !s.points.length)) {
    disposeChart(host);
    host.innerHTML = `<div class="result-empty">没有可绘制的数据</div>`;
    return;
  }

  const chart = ensureChart(host);
  const textColor = "#c8cdd6";
  const lineColor = "#3a4150";

  if (kind === "pie" || kind === "doughnut") {
    const n = series.length;
    const pieSeries = series.map((s, i) => {
      const band = Math.max(12, Math.floor(48 / n));
      const outer = 70 - i * (band + 2);
      const inner =
        kind === "doughnut" || n > 1
          ? Math.max(8, outer - band)
          : 0;
      const colors = s.points.map((_, pi) =>
        pi === 0 ? s.color : PIE_FALLBACK[(pi + i) % PIE_FALLBACK.length]!,
      );
      return {
        name: s.name,
        type: "pie" as const,
        radius: n === 1 && kind === "pie" ? "62%" : [`${inner}%`, `${outer}%`],
        center: ["50%", "48%"] as [string, string],
        data: s.points.map((p, pi) => ({
          name: n > 1 ? `${s.name}: ${p.label}` : p.label,
          value: p.value,
          itemStyle: { color: colors[pi] },
        })),
        label: { color: textColor, fontSize: 10 },
        emphasis: { itemStyle: { shadowBlur: 8 } },
      };
    });

    chart.setOption(
      {
        title: {
          text: title,
          left: "center",
          textStyle: { color: textColor, fontSize: 13, fontWeight: 500 },
        },
        tooltip: { trigger: "item" },
        legend: {
          type: "scroll",
          bottom: 0,
          textStyle: { color: textColor, fontSize: 11 },
        },
        series: pieSeries,
      },
      true,
    );
    return;
  }

  const categories = mergeCategories(series);
  const aligned = seriesDataAligned(series, categories);
  const isArea = kind === "area";
  const isLine = kind === "line" || isArea;

  chart.setOption(
    {
      title: {
        text: title,
        left: "center",
        textStyle: { color: textColor, fontSize: 13, fontWeight: 500 },
      },
      tooltip: { trigger: "axis" },
      legend: {
        type: "scroll",
        top: 28,
        textStyle: { color: textColor, fontSize: 11 },
      },
      grid: {
        left: 48,
        right: 20,
        top: 56,
        bottom: categories.some((c) => c.length > 8) ? 72 : 40,
      },
      xAxis: {
        type: "category",
        data: categories,
        axisLabel: {
          color: textColor,
          fontSize: 10,
          rotate: categories.length > 6 ? 30 : 0,
          interval: 0,
        },
        axisLine: { lineStyle: { color: lineColor } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: textColor, fontSize: 10 },
        splitLine: { lineStyle: { color: lineColor, opacity: 0.45 } },
        axisLine: { show: false },
      },
      series: aligned.map((s) => ({
        name: s.name,
        type: isLine ? ("line" as const) : ("bar" as const),
        data: s.data,
        itemStyle: { color: s.color },
        lineStyle: isLine ? { color: s.color, width: 2.5 } : undefined,
        areaStyle: isArea ? { color: s.color, opacity: 0.22 } : undefined,
        smooth: isLine,
        barMaxWidth: 36,
        emphasis: { focus: "series" as const },
      })),
    },
    true,
  );
  requestAnimationFrame(() => chart.resize());
}
