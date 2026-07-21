"use client";
import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { MID, QUADRANTS, SCALE_MAX, SCALE_MIN, quadrantOf } from "@/components/affect";
import { attachTapDismiss } from "@/utils/chartTouch";

const NO_POINTS = [];

/**
 * The valence–arousal plane (Russell's circumplex), with a session's predictions
 * plotted on it.
 *
 * Two point clouds share the axes:
 *   predicted — one dot per 2 s window, what the model inferred from EEG alone
 *   actual    — the OASIS rating of each distinct image shown, i.e. the truth
 *
 * Plotting both is the point: the gap between the clouds IS the model's error,
 * shown spatially rather than as a number. It also exposes whether the image set
 * spans the plane at all — a set clustered in one quadrant can never teach a model
 * to distinguish the others, and that shows up here immediately.
 *
 * Props:
 *   predicted [{ valence, arousal, t_seconds }]
 *   actual    [{ valence, arousal, label }]   distinct images, deduped by caller
 *   height    px (default 440)
 */
export default function AffectQuadrantChart({
  predicted = NO_POINTS,
  actual = NO_POINTS,
  height = 440,
}) {
  const elRef = useRef(null);

  const buildOption = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    const c = {
      ink: v("--ink"),
      ink2: v("--ink-2"),
      muted: v("--muted"),
      border: v("--border"),
      surface: v("--surface"),
      accent: v("--accent"),
    };

    // Each quadrant is a tinted rectangle labelled in its outer corner, so the
    // emotion words sit furthest from the centre where the points cluster.
    const area = (q, x0, y0, x1, y1, position) => [
      {
        xAxis: x0,
        yAxis: y0,
        itemStyle: { color: v(q.soft), opacity: 0.85 },
        label: {
          show: true,
          position,
          distance: 10,
          formatter: q.label,
          color: v(q.color),
          fontSize: 12,
          fontWeight: 600,
        },
      },
      { xAxis: x1, yAxis: y1 },
    ];

    const point = (p) => ({
      value: [Number(p.valence), Number(p.arousal)],
      meta: p,
    });

    return {
      animation: false,
      grid: { left: 62, right: 26, top: 22, bottom: 80 },
      legend: {
        data: ["Predicted from EEG", "Actual (established rating)"],
        bottom: 6,
        icon: "circle",
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: c.ink2, fontSize: 12 },
      },
      xAxis: {
        type: "value",
        min: SCALE_MIN,
        max: SCALE_MAX,
        name: "Valence  ·  unpleasant → pleasant",
        nameLocation: "middle",
        nameGap: 24,
        nameTextStyle: { color: c.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.muted, fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: SCALE_MIN,
        max: SCALE_MAX,
        name: "Arousal  ·  calm → activated",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: c.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: c.border } },
        axisLabel: { color: c.muted, fontSize: 11 },
        splitLine: { show: false },
      },
      tooltip: {
        trigger: "item",
        confine: true,
        backgroundColor: c.surface,
        borderColor: c.border,
        borderWidth: 1,
        textStyle: { color: c.ink, fontSize: 12 },
        formatter: (p) => {
          if (!p.value) return "";
          const [val, aro] = p.value;
          const q = quadrantOf(val, aro);
          const meta = p.data?.meta || {};
          const head = q
            ? `<div style="font-weight:600;color:${v(q.color)};margin-bottom:2px">${q.label}</div>` +
              `<div style="font-size:11px;color:${c.muted};margin-bottom:6px">${q.words}</div>`
            : "";
          const when =
            meta.t_seconds != null
              ? `<div style="font-family:monospace;font-size:11px;color:${c.muted};margin-top:6px">t = ${Number(meta.t_seconds).toFixed(1)} s</div>`
              : "";
          const who = meta.label
            ? `<div style="font-size:11px;color:${c.muted};margin-top:6px">${meta.label}</div>`
            : "";
          return (
            head +
            `<div style="display:flex;justify-content:space-between;gap:18px"><span>Valence</span><b>${val.toFixed(2)}</b></div>` +
            `<div style="display:flex;justify-content:space-between;gap:18px"><span>Arousal</span><b>${aro.toFixed(2)}</b></div>` +
            when +
            who
          );
        },
      },
      series: [
        {
          // Backdrop only: the quadrants and the neutral cross-hairs at 4.
          name: "__quadrants",
          type: "scatter",
          data: [],
          silent: true,
          tooltip: { show: false },
          markArea: {
            silent: true,
            data: [
              area(QUADRANTS.angry, SCALE_MIN, MID, MID, SCALE_MAX, "insideTopLeft"),
              area(QUADRANTS.happy, MID, MID, SCALE_MAX, SCALE_MAX, "insideTopRight"),
              area(QUADRANTS.sad, SCALE_MIN, SCALE_MIN, MID, MID, "insideBottomLeft"),
              area(QUADRANTS.relaxed, MID, SCALE_MIN, SCALE_MAX, MID, "insideBottomRight"),
            ],
          },
          markLine: {
            silent: true,
            symbol: "none",
            lineStyle: { color: c.border, type: "solid", width: 1 },
            label: { show: false },
            data: [{ xAxis: MID }, { yAxis: MID }],
          },
        },
        {
          name: "Actual (established rating)",
          type: "scatter",
          data: actual.map(point),
          symbol: "diamond",
          symbolSize: 11,
          itemStyle: {
            color: "transparent",
            borderColor: c.muted,
            borderWidth: 1.5,
          },
          z: 3,
        },
        {
          name: "Predicted from EEG",
          type: "scatter",
          data: predicted.map(point),
          symbolSize: 9,
          itemStyle: { color: c.accent, opacity: 0.6 },
          z: 4,
        },
      ],
    };
  };

  useEffect(() => {
    if (!elRef.current) return;
    const chart = echarts.init(elRef.current, null, { renderer: "canvas" });
    chart.setOption(buildOption());

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(elRef.current);

    // Canvas can't resolve var(), so every colour above is a concrete value read
    // at build time — rebuild on a theme flip or the chart keeps the old palette.
    const recolor = () => chart.setOption(buildOption(), { notMerge: true, lazyUpdate: true });
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predicted, actual, height]);

  return <div ref={elRef} className="w-full" style={{ height: `${height}px` }} />;
}
