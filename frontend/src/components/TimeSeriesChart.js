"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";

// Stable default so omitting the prop doesn't re-init the chart every render.
const NO_EVENTS = [];

/**
 * Multi-panel time-series line chart for the ~1 Hz band-power stream.
 *
 * Panels stack vertically and share one time axis and one synced dataZoom, so
 * two measures on different scales (heart rate in bpm, SpO2 in %) get a panel
 * each instead of being crushed onto a second y-axis.
 *
 * Props:
 *   samples   [{ t_seconds, ... }]                    ascending in t_seconds
 *   panels    [{ label, unit, series, min, max }]     one grid each, top→bottom
 *               series: [{ key, label, color }]       color may be a CSS var name
 *   events    [{ from, to, label, type }]             stimulus windows (seconds); type "image"|"question"
 *   onVisibleRangeChange(startSec, endSec)            fired on zoom/pan
 *   onEventClick(index)                               fired when an event band is clicked
 *   annotate(params) -> html|null                     extra tooltip line, appended below
 *                                                     the value rows; omit for none
 *   height    px per panel (default 190)
 */
export default function TimeSeriesChart({
  samples,
  panels,
  events = NO_EVENTS,
  onVisibleRangeChange,
  onEventClick,
  annotate,
  height = 190,
}) {
  const elRef = useRef(null);
  const rangeCbRef = useRef(onVisibleRangeChange);
  const eventCbRef = useRef(onEventClick);
  // Held in a ref like the other callbacks so an inline arrow from the caller
  // doesn't re-init the whole chart on every render.
  const annotateRef = useRef(annotate);
  useEffect(() => {
    rangeCbRef.current = onVisibleRangeChange;
    eventCbRef.current = onEventClick;
    annotateRef.current = annotate;
  }, [onVisibleRangeChange, onEventClick, annotate]);

  const buildOption = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    const c = {
      ink: v("--ink"),
      muted: v("--muted"),
      border: v("--border"),
      surface: v("--surface"),
      inset: v("--inset"),
      accentSoft: v("--accent-soft"),
    };
    // Canvas can't resolve var(), so turn "--band-alpha" into a concrete hex on
    // every rebuild — that's also what recolors the traces on a theme flip.
    const resolve = (col) => (col.startsWith("--") ? v(col) : col);

    // Same stimulus bands as the EEG strip chart: translucent, silent until
    // hovered, click bubbles the event index so the page can show the stimulus.
    const buildMarkArea = (showLabel) => {
      if (!events.length) return undefined;
      const imgColor = v("--accent-soft");
      const qColor = v("--warn-soft");
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

    const n = panels.length;
    // A panel whose series are all direct-labelled at the line end needs room on
    // the right for those labels; a legend-only panel doesn't.
    const anyEndLabels = panels.some((p) => p.series.length > 1 && p.series.length <= 4);
    const rightPad = anyEndLabels ? 92 : 24;
    const showLegend = panels.some((p) => p.series.length > 1);

    // Event bands print their hover label at the top of the first panel; give
    // it headroom or the text gets clipped by the canvas edge.
    const topPad = (showLegend ? 34 : 12) + (events.length ? 16 : 0);
    const gap = 30;
    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const series = [];

    panels.forEach((panel, i) => {
      const isLast = i === n - 1;
      grids.push({
        left: 66,
        right: rightPad,
        top: topPad + i * (height + gap),
        height,
      });
      xAxes.push({
        type: "value",
        gridIndex: i,
        min: "dataMin",
        max: "dataMax",
        axisLine: { lineStyle: { color: c.border } },
        axisTick: { show: isLast },
        axisLabel: { show: isLast, color: c.muted, fontSize: 11, formatter: (t) => `${t.toFixed(0)}s` },
        splitLine: { show: false },
      });
      yAxes.push({
        type: "value",
        gridIndex: i,
        name: panel.unit ? `${panel.label} (${panel.unit})` : panel.label,
        nameLocation: "middle",
        nameGap: 48,
        nameTextStyle: { color: c.muted, fontSize: 11, fontWeight: 600 },
        min: panel.min,
        max: panel.max,
        scale: panel.min == null,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 10 },
        splitLine: { lineStyle: { color: c.border, opacity: 0.6 } },
      });

      const directLabel = panel.series.length > 1 && panel.series.length <= 4;
      panel.series.forEach((ser, si) => {
        const color = resolve(ser.color);
        series.push({
          // Bands attach to one series per grid (they'd stack translucency
          // otherwise); the hover label only prints on the top panel.
          markArea: si === 0 ? buildMarkArea(i === 0) : undefined,
          name: ser.label,
          type: "line",
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          symbolSize: 8, // only shown on hover/emphasis
          sampling: "lttb",
          connectNulls: false,
          lineStyle: { width: 2, color },
          itemStyle: { color },
          emphasis: { focus: "series" },
          endLabel: directLabel
            ? {
                show: true,
                color,
                fontSize: 11,
                fontWeight: 600,
                distance: 6,
                formatter: ser.label,
              }
            : { show: false },
          // Series that finish at similar values would otherwise print their end
          // labels on top of each other; shift them apart vertically instead.
          labelLayout: directLabel ? { moveOverlap: "shiftY" } : undefined,
          data: samples.map((row) => [row.t_seconds, row[ser.key]]),
        });
      });
    });

    return {
      animation: false,
      backgroundColor: "transparent",
      textStyle: { fontFamily: "inherit" },
      // Identity is never colour-alone: a legend for every multi-series panel,
      // plus end labels at ≤4 series, plus the value rail the page renders below.
      legend: showLegend
        ? {
            top: 0,
            left: 60,
            itemWidth: 14,
            itemHeight: 3,
            itemGap: 16,
            textStyle: { color: c.ink, fontSize: 12 },
            inactiveColor: c.muted,
          }
        : { show: false },
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
          const panelFor = (name) => panels.find((pn) => pn.series.some((sr) => sr.label === name));
          const t = ps[0].value[0];
          const rows = ps
            .filter((p) => p.value[1] != null)
            .map((p) => {
              const panel = panelFor(p.seriesName);
              const value = Number(p.value[1]).toFixed(panel?.decimals ?? 1);
              const unit = panel?.unit ? ` ${panel.unit}` : "";
              return (
                `<div style="display:flex;justify-content:space-between;gap:16px">` +
                `<span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${p.color};margin-right:6px"></span>${p.seriesName}</span>` +
                `<b>${value}${unit}</b></div>`
              );
            })
            .join("");
          const extra = annotateRef.current?.(ps);
          const footer = extra
            ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${c.border}">${extra}</div>`
            : "";
          return `<div style="font-family:monospace;font-size:11px;color:${c.muted};margin-bottom:4px">t = ${t.toFixed(1)} s</div>${rows}${footer}`;
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: panels.map((_, i) => i), filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: panels.map((_, i) => i),
          height: 20,
          bottom: 6,
          borderColor: c.border,
          fillerColor: c.accentSoft,
          handleStyle: { color: c.muted },
          dataBackground: { lineStyle: { color: c.muted, opacity: 0.4 }, areaStyle: { color: c.inset } },
          textStyle: { color: c.muted, fontSize: 10 },
          labelFormatter: (t) => `${t.toFixed(0)}s`,
        },
      ],
    };
  };

  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current, null, { renderer: "canvas" });
    chart.setOption(buildOption());

    const emitRange = () => {
      if (!samples.length) return;
      const minT = samples[0].t_seconds;
      const maxT = samples[samples.length - 1].t_seconds;
      const dz = chart.getOption().dataZoom?.[0];
      const startPct = dz?.start ?? 0;
      const endPct = dz?.end ?? 100;
      rangeCbRef.current?.(
        minT + (startPct / 100) * (maxT - minT),
        minT + (endPct / 100) * (maxT - minT)
      );
    };
    chart.on("datazoom", emitRange);
    emitRange();

    // Event-band clicks bubble the band's index back to the page, which shows
    // the stimulus that was on screen during that window.
    chart.on("click", (params) => {
      if (params.componentType === "markArea" && params.data?.eventIndex != null)
        eventCbRef.current?.(params.data.eventIndex);
    });

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
  }, [samples, panels, height, events]);

  const showLegend = panels.some((p) => p.series.length > 1);
  const totalH =
    panels.length * height +
    (showLegend ? 34 : 12) +
    (events.length ? 16 : 0) +
    46 +
    30 * (panels.length - 1);
  return <div ref={elRef} className="w-full" style={{ height: `${totalH}px` }} />;
}
