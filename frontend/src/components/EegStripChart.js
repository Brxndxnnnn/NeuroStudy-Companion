"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { attachTapDismiss } from "@/utils/chartTouch";

// Stable default so omitting the prop doesn't re-init the chart every render.
const NO_EVENTS = [];

// A live electrode swings by tens of µV. A railed one — the SDK keeps reporting it as
// "connected" while its ADC sits on a constant — arrives as a sub-0.1 µV DC residue. Left to
// autoscale, that dither fills the strip and reads as a healthy waveform, so a channel under
// this peak-to-peak gets a fixed axis instead and is drawn (and labelled) as the flat line it is.
const FLAT_PKPK_UV = 0.5;
const FLAT_AXIS_UV = 1; // half-height of the pinned axis for a flat channel

// Peak-to-peak of one channel across the whole session.
function channelPkPk(samples, key) {
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    const v = s[key];
    if (v == null || Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { pkpk: 0, mid: 0, empty: true };
  return { pkpk: max - min, mid: (min + max) / 2, empty: false };
}

// µV values span orders of magnitude here (a dead channel sits near 0.02), so a fixed
// 1 decimal place would print every one of them as "0.0".
function fmtUv(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  return v.toFixed(a >= 10 ? 1 : a >= 1 ? 2 : 3);
}

/**
 * Stacked "strip chart" small-multiples for the filtered EEG — one canvas panel
 * per channel, sharing a single time axis and one synced dataZoom (drag / scroll
 * / slider). Renders 100k+ points smoothly via canvas + LTTB downsampling.
 *
 * Props:
 *   samples   [{ t_seconds, <channel keys...> }]  ascending in t_seconds
 *   channels  [{ key, label, color }]             one strip each, top→bottom
 *   events    [{ from, to, label, type }]         stimulus windows (seconds); type "image"|"question"
 *   onVisibleRangeChange(startSec, endSec)         fired on zoom/pan (throttled by ECharts)
 *   onEventClick(index)                            fired when an event band is clicked
 */
export default function EegStripChart({
  samples,
  channels,
  events = NO_EVENTS,
  onVisibleRangeChange,
  onEventClick,
}) {
  const elRef = useRef(null);
  const chartRef = useRef(null);
  const rangeCbRef = useRef(onVisibleRangeChange);
  const eventCbRef = useRef(onEventClick);
  useEffect(() => {
    rangeCbRef.current = onVisibleRangeChange;
    eventCbRef.current = onEventClick;
  }, [onVisibleRangeChange, onEventClick]);

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

    // Stimulus windows as translucent bands behind the traces. Events are dense
    // (~1 s each), so bands stay silent by default — the label surfaces on hover
    // and the click hands off to the page (which shows the image / question).
    // markArea click payloads carry our eventIndex back out.
    const buildMarkArea = (showLabel = true) => {
      if (!events.length) return undefined;
      const imgColor = cssv("--accent-soft");
      const qColor = cssv("--warn-soft");
      return {
        silent: false,
        label: { show: false, position: "insideTop", fontSize: 10, color: c.muted },
        emphasis: { label: { show: showLabel }, itemStyle: { opacity: 1 } },
        itemStyle: { opacity: 0.65 },
        data: events.map((ev, i) => [
          {
            xAxis: ev.from,
            name: ev.label,
            eventIndex: i,
            itemStyle: { color: ev.type === "question" ? qColor : imgColor },
          },
          { xAxis: ev.to },
        ]),
      };
    };

    // Stacked small-multiples: equal strips with small gaps, room for the slider.
    // Event bands print their hover label at the top of the first strip, so give
    // it headroom or the text gets clipped by the canvas edge.
    const topPad = events.length ? 6 : 3, bottomPad = 16, gap = 4;
    const stripH = (100 - topPad - bottomPad - gap * (n - 1)) / n;

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const series = [];

    channels.forEach((ch, i) => {
      const color = chColor(ch);
      const top = topPad + i * (stripH + gap);
      const isLast = i === n - 1;
      const { pkpk, mid, empty } = channelPkPk(samples, ch.key);
      const flat = !empty && pkpk < FLAT_PKPK_UV;
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
        // Name the failure on the axis itself — the strip is the first thing read.
        name: flat ? `${ch.label}\nNO SIGNAL` : ch.label,
        nameLocation: "middle",
        nameGap: 46,
        nameTextStyle: {
          color: flat ? c.muted : color,
          fontWeight: 700,
          fontSize: 12,
          fontFamily: "monospace",
          lineHeight: 14,
        },
        // A flat channel gets a fixed axis so it draws as the flat line it is; autoscaling
        // its sub-µV dither to fill the strip is what made a dead electrode look alive.
        ...(flat
          ? { min: mid - FLAT_AXIS_UV, max: mid + FLAT_AXIS_UV, scale: false }
          : { scale: true }),
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
        // Each strip is its own grid, so every strip gets the bands — together
        // they read as one column spanning the whole chart. Labels only surface
        // on the top strip to avoid printing 4 copies on hover.
        markArea: buildMarkArea(i === 0),
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
        confine: true,
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        textStyle: { color: c.ink, fontSize: 12 },
        formatter: (ps) => {
          if (!ps || !ps.length) return "";
          const t = ps[0].value[0];
          const rows = ps
            .map((p) => `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:${p.color}">${p.seriesName}</span><b>${fmtUv(p.value[1])} µV</b></div>`)
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

    // Event-band clicks bubble the band's index back to the page, which shows
    // the stimulus that was on screen during that window.
    chart.on("click", (params) => {
      if (params.componentType === "markArea" && params.data?.eventIndex != null)
        eventCbRef.current?.(params.data.eventIndex);
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);

    // Recolor on theme change (toggle stamps data-theme; system change fires matchMedia).
    const recolor = () => chart.setOption(buildOption(), { notMerge: false, lazyUpdate: true });
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", recolor);

    const detachTapDismiss = attachTapDismiss(chart, elRef.current);

    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener?.("change", recolor);
      detachTapDismiss();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, channels, events]);

  const height = Math.max(280, channels.length * 96 + 48);
  return <div ref={elRef} className="w-full" style={{ height: `${height}px` }} />;
}
