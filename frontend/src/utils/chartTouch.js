// Touch/tablet tooltip support for the ECharts wrappers.
//
// ECharts already shows axis/item tooltips on tap (its default triggerOn is
// "mousemove|click", and a tap without movement synthesizes a click) — the
// gap on touch is that nothing ever un-pins it, since there's no mouseout
// equivalent once the finger lifts. This wires "tap outside the chart hides
// the pinned tooltip" so a tap on a point behaves as tap-to-pin: it stays put
// until the next tap, on that chart or elsewhere on the page.
//
// Call inside the same effect that calls echarts.init(); call the returned
// function in that effect's cleanup.
export function attachTapDismiss(chart, container) {
  const onPointerDown = (e) => {
    if (!container.contains(e.target)) {
      chart.dispatchAction({ type: "hideTip" });
    }
  };
  document.addEventListener("pointerdown", onPointerDown);
  return () => document.removeEventListener("pointerdown", onPointerDown);
}
