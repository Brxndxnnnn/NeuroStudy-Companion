"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * Mean band power per channel over the visible window — a grouped column chart
 * that answers "which channel is carrying the alpha?" at a glance, which the
 * time series alone doesn't.
 *
 * Props:
 *   groups  [{ label, values: { <bandKey>: number|null } }]   one column group each
 *   bands   [{ key, label, color }]                           one column per group
 */
export default function BandProfileChart({ groups, bands }) {
  const elRef = useRef(null);

  const buildOption = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    const c = { ink: v("--ink"), muted: v("--muted"), border: v("--border"), surface: v("--surface") };
    const resolve = (col) => (col.startsWith("--") ? v(col) : col);

    return {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit" },
      legend: {
        top: 0,
        left: 52,
        itemWidth: 10,
        itemHeight: 10,
        itemGap: 16,
        icon: "roundRect",
        textStyle: { color: c.ink, fontSize: 12 },
        inactiveColor: c.muted,
      },
      grid: { left: 52, right: 16, top: 38, bottom: 28 },
      tooltip: {
        trigger: "item",
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        textStyle: { color: c.ink, fontSize: 12 },
        formatter: (p) =>
          `<div style="color:${c.muted};font-size:11px;margin-bottom:3px">${p.name}</div>` +
          `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>` +
          `${p.seriesName} <b>${p.value == null ? "—" : Number(p.value).toFixed(2)}</b>`,
      },
      xAxis: {
        type: "category",
        data: groups.map((g) => g.label),
        axisLine: { lineStyle: { color: c.border } },
        axisTick: { show: false },
        axisLabel: { color: c.ink, fontSize: 12, fontWeight: 600 },
      },
      yAxis: {
        type: "value",
        name: "Mean power",
        nameLocation: "middle",
        nameGap: 40,
        nameTextStyle: { color: c.muted, fontSize: 11, fontWeight: 600 },
        axisLabel: { color: c.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: c.border, opacity: 0.6 } },
      },
      series: bands.map((b) => ({
        name: b.label,
        type: "bar",
        barCategoryGap: "34%",
        barGap: "10%",
        itemStyle: {
          color: resolve(b.color),
          // Rounded data-end, square on the baseline; the 1px surface-coloured
          // border on each bar reads as the 2px gap between neighbours.
          borderRadius: [4, 4, 0, 0],
          borderColor: c.surface,
          borderWidth: 1,
        },
        data: groups.map((g) => g.values[b.key] ?? null),
      })),
    };
  };

  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current, null, { renderer: "canvas" });
    chart.setOption(buildOption());

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);

    const recolor = () => chart.setOption(buildOption(), { notMerge: false, lazyUpdate: true });
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", recolor);

    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener?.("change", recolor);
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, bands]);

  return <div ref={elRef} className="w-full" style={{ height: "260px" }} />;
}
