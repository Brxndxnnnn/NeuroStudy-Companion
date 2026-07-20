// Turns raw per-event rows (shown_at/hidden_at timestamps) into the {from, to,
// label, type} windows TimeSeriesChart's `events` prop expects — seconds
// relative to the session's start_time, clamped to the recording's duration.
//
// Shared between the session results page (which has the rich /results rows:
// url, prompt, per-event averages) and any other view that only needs the
// marker bands themselves (e.g. Insights' predicted-vs-actual chart), which can
// pass durSec = Infinity when it has no reliable session end time to clamp to.
// Images and questions are numbered independently ("Image 3", "Question 2").
export function buildEventWindows(rows, startTime, durSec) {
  const startMs = new Date(startTime).getTime();
  const out = [];
  let nImg = 0;
  let nQ = 0;
  for (const r of rows || []) {
    const type = r.stimulus_type || (r.image_id != null ? "image" : "question");
    const label = type === "image" ? `Image ${++nImg}` : `Question ${++nQ}`;
    const from = (new Date(r.shown_at).getTime() - startMs) / 1000;
    // hidden_at is coalesced server-side (next event / session end), but a still-
    // open window would collapse the band to zero width — give it a visible span.
    let to = r.hidden_at ? (new Date(r.hidden_at).getTime() - startMs) / 1000 : from + 1;
    if (!(to > from)) to = from + 0.5;
    if (Number.isNaN(from) || to <= 0 || from >= durSec) continue;
    out.push({ ...r, type, label, from: Math.max(0, from), to: Math.min(durSec, to) });
  }
  return out;
}
