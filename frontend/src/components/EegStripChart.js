"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";

/**
 * Stacked "strip chart" small-multiples for the filtered EEG — one canvas panel
 * per channel, sharing a single time axis and one synced dataZoom (drag / scroll
 * / slider). Renders 100k+ points smoothly via canvas + LTTB downsampling.
 *
 * Props:
 *   samples   [{ t_seconds, <channel keys...> }]  ascending in t_seconds
 *   channels  [{ key, label, color }]             one strip each, top→bottom
 *   overlay   draw every channel on one shared µV axis instead of stacked strips
 *   onVisibleRangeChange(startSec, endSec)         fired on zoom/pan (throttled by ECharts)
 */
export default function EegStripChart({ samples, channels, overlay = false, onVisibleRangeChange }) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const rangeCbRef = useRef(onVisibleRangeChange);
  useEffect(() => {
    rangeCbRef.current = onVisibleRangeChange;
  }, [onVisibleRangeChange]);

  // Read live theme colors from CSS variables so the canvas matches light/dark.
  const themeColors = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return {
      ink: v("--ink"),
      muted: v("--muted"),
      border: v("--border"),
      surface: v("--surface"),
      inset: v("--inset"),
      accentSoft: v("--accent-soft"),
    };
  };

  const buildOption = () => {
    const c = themeColors();
    // Channels may pass a CSS custom-property name (e.g. "--ch-fp1"); resolve to a
    // concrete color since the canvas renderer can't read var(). Re-resolved on each
    // rebuild so a theme toggle recolors the traces too.
    const cssv = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const chColor = (ch) => (ch.color.startsWith("--") ? cssv(ch.color) : ch.color);
    const n = channels.length;

    // Overlay: every channel on one shared µV axis, so amplitudes can be compared
    // directly (and identical traces would sit exactly on top of one another).
    if (overlay) {
      return {
        animation: false,
        backgroundColor: "transparent",
        textStyle: { fontFamily: "inherit" },
        legend: {
          top: 0,
          left: 68,
          itemWidth: 14,
          itemHeight: 3,
          itemGap: 16,
          textStyle: { color: c.ink, fontSize: 12 },
          inactiveColor: c.muted,
        },
        grid: [{ left: 68, right: 18, top: 34, bottom: 56 }],
        xAxis: [{
          type: "value",
          min: "dataMin",
          max: "dataMax",
          axisLine: { lineStyle: { color: c.border } },
          axisLabel: { color: c.muted, fontSize: 11, formatter: (v) => `${v.toFixed(0)}s` },
          splitLine: { show: false },
        }],
        yAxis: [{
          type: "value",
          name: "µV",
          nameLocation: "middle",
          nameGap: 46,
          nameTextStyle: { color: c.muted, fontSize: 11, fontWeight: 600 },
          scale: true,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: c.muted, fontSize: 10 },
          splitLine: { lineStyle: { color: c.border, opacity: 0.5 } },
        }],
        series: channels.map((ch) => ({
          name: ch.label,
          type: "line",
          showSymbol: false,
          sampling: "lttb",
          large: true,
          lineStyle: { width: 1, color: chColor(ch), opacity: 0.85 },
          itemStyle: { color: chColor(ch) },
          emphasis: { focus: "series" },
          data: samples.map((s) => [s.t_seconds, s[ch.key]]),
        })),
        axisPointer: { lineStyle: { color: c.muted, opacity: 0.5 }, label: { show: false } },
        tooltip: {
          trigger: "axis",
          backgroundColor: c.surface,
          borderColor: c.border,
          borderWidth: 1,
          textStyle: { color: c.ink, fontSize: 12 },
          formatter: (ps) => {
            if (!ps || !ps.length) return "";
            const t = ps[0].value[0];
            const rows = ps
              .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${p.color}">${p.seriesName}</span><b>${p.value[1]?.toFixed(1)} µV</b></div>`)
              .join("");
            return `<div style="font-family:monospace;font-size:11px;color:${c.muted};margin-bottom:4px">t = ${t.toFixed(2)} s</div>${rows}`;
          },
        },
        dataZoom: [
          { type: "inside", xAxisIndex: [0], filterMode: "none" },
          {
            type: "slider",
            xAxisIndex: [0],
            height: 20,
            bottom: 6,
            borderColor: c.border,
            fillerColor: c.accentSoft,
            handleStyle: { color: c.muted },
            dataBackground: { lineStyle: { color: c.muted, opacity: 0.4 }, areaStyle: { color: c.inset } },
            textStyle: { color: c.muted, fontSize: 10 },
            labelFormatter: (v) => `${v.toFixed(0)}s`,
          },
        ],
      };
    }

    // Stacked small-multiples: equal strips with small gaps, room for the slider.
    const topPad = 3, bottomPad = 16, gap = 4;
    const stripH = (100 - topPad - bottomPad - gap * (n - 1)) / n;

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const series = [];

    channels.forEach((ch, i) => {
      const color = chColor(ch);
      const top = topPad + i * (stripH + gap);
      const isLast = i === n - 1;
      grids.push({ left: 68, right: 18, top: `${top}%`, height: `${stripH}%` });
      xAxes.push({
        type: "value",
        gridIndex: i,
        min: "dataMin",
        max: "dataMax",
        axisLine: { lineStyle: { color: c.border } },
        axisTick: { show: isLast },
        axisLabel: { show: isLast, color: c.muted, fontSize: 11, formatter: (v) => `${v.toFixed(0)}s` },
        splitLine: { show: false },
      });
      yAxes.push({
        type: "value",
        gridIndex: i,
        name: ch.label,
        nameLocation: "middle",
        nameGap: 46,
        nameTextStyle: { color, fontWeight: 700, fontSize: 12, fontFamily: "monospace" },
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 10, showMinLabel: false, showMaxLabel: false },
        splitLine: { lineStyle: { color: c.border, opacity: 0.5 } },
      });
      series.push({
        name: ch.label,
        type: "line",
        xAxisIndex: i,
        yAxisIndex: i,
        showSymbol: false,
        sampling: "lttb",
        large: true,
        lineStyle: { width: 1, color },
        emphasis: { disabled: true },
        data: samples.map((s) => [s.t_seconds, s[ch.key]]),
      });
    });

    return {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit" },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series,
      axisPointer: {
        link: [{ xAxisIndex: "all" }],
        lineStyle: { color: c.muted, opacity: 0.5 },
        label: { show: false },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        textStyle: { color: c.ink, fontSize: 12 },
        formatter: (ps) => {
          if (!ps || !ps.length) return "";
          const t = ps[0].value[0];
          const rows = ps
            .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${p.color}">${p.seriesName}</span><b>${p.value[1]?.toFixed(1)} µV</b></div>`)
            .join("");
          return `<div style="font-family:monospace;font-size:11px;color:${c.muted};margin-bottom:4px">t = ${t.toFixed(2)} s</div>${rows}`;
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: channels.map((_, i) => i), filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: channels.map((_, i) => i),
          height: 20,
          bottom: 6,
          borderColor: c.border,
          fillerColor: c.accentSoft,
          handleStyle: { color: c.muted },
          dataBackground: { lineStyle: { color: c.muted, opacity: 0.4 }, areaStyle: { color: c.inset } },
          textStyle: { color: c.muted, fontSize: 10 },
          labelFormatter: (v) => `${v.toFixed(0)}s`,
        },
      ],
    };
  };

  // Init once; rebuild option when data/channels change.
  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    chart.setOption(buildOption());

    const emitRange = () => {
      if (!samples.length) return;
      const minT = samples[0].t_seconds;
      const maxT = samples[samples.length - 1].t_seconds;
      const dz = chart.getOption().dataZoom?.[0];
      const startPct = dz?.start ?? 0;
      const endPct = dz?.end ?? 100;
      const startSec = minT + (startPct / 100) * (maxT - minT);
      const endSec = minT + (endPct / 100) * (maxT - minT);
      rangeCbRef.current?.(startSec, endSec);
    };
    chart.on("datazoom", emitRange);
    emitRange(); // initial full-range stats

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);

    // Recolor on theme change (toggle stamps data-theme; system change fires matchMedia).
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
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, channels, overlay]);

  const height = overlay ? 360 : Math.max(280, channels.length * 96 + 48);
  return <div ref={elRef} className="w-full" style={{ height: `${height}px` }} />;
}
