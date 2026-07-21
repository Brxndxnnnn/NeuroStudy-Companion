/**
 * Russell's circumplex model of affect — the shared vocabulary for turning a
 * (valence, arousal) pair into an emotion word.
 *
 * Valence runs unpleasant → pleasant on the x-axis, arousal calm → activated on
 * the y-axis, and the four quadrants they form are the classic
 * angry / happy / sad / relaxed layout (Russell, 1980).
 *
 * Both axes are OASIS 1–7 ratings, so the neutral midpoint is MID = 4, NOT 0.
 * Every consumer must take it from here rather than hard-coding a centre, or the
 * chart and its tooltips will disagree about which quadrant a point sits in.
 *
 * ⚠ These words name a REGION OF THE PLANE, not a diagnosis. A prediction of 4.05
 * and one of 3.95 fall either side of a boundary while being statistically
 * indistinguishable, so surrounding copy stays hedged ("region associated with…")
 * and never asserts what the client feels. quadrantConfidence() exists to mark
 * the readings too close to the centre for the word to carry any weight.
 */

export const SCALE_MIN = 1;
export const SCALE_MAX = 7;
export const MID = 4;

// `color` doubles as text (the on-chart quadrant label, the tooltip heading)
// and as a decorative fill (the breakdown bar/dot in Insights) — the -strong
// tokens clear 4.5:1 as text on their matching `soft` background in light
// mode, where the plain tone only hits ~3-3.3:1, and read just as well as a
// swatch color for the decorative uses.
export const QUADRANTS = {
  angry: {
    key: "angry",
    label: "Angry / Tense",
    words: "tense, afraid, distressed",
    color: "--crit-strong",
    soft: "--crit-soft",
  },
  happy: {
    key: "happy",
    label: "Happy / Excited",
    words: "elated, enthusiastic, alert",
    color: "--good-strong",
    soft: "--good-soft",
  },
  sad: {
    key: "sad",
    label: "Sad / Bored",
    words: "downcast, fatigued, listless",
    color: "--muted",
    soft: "--inset",
  },
  relaxed: {
    key: "relaxed",
    label: "Relaxed / Calm",
    words: "content, serene, at ease",
    color: "--accent-strong",
    soft: "--accent-soft",
  },
};

/** Quadrant for a (valence, arousal) pair, or null if either is missing. */
export function quadrantOf(valence, arousal) {
  if (valence == null || arousal == null) return null;
  const v = Number(valence);
  const a = Number(arousal);
  if (Number.isNaN(v) || Number.isNaN(a)) return null;
  const pleasant = v >= MID;
  const activated = a >= MID;
  if (pleasant && activated) return QUADRANTS.happy;
  if (pleasant && !activated) return QUADRANTS.relaxed;
  if (!pleasant && activated) return QUADRANTS.angry;
  return QUADRANTS.sad;
}

/**
 * Distance from the nearest quadrant boundary, 0 (on the line) → 1 (at a corner).
 * A point sitting almost exactly on the midpoint gets a quadrant name from
 * quadrantOf() purely because the comparison has to break the tie somewhere; this
 * is how the UI knows to hedge instead of presenting that name as a finding.
 */
export function quadrantConfidence(valence, arousal) {
  if (valence == null || arousal == null) return 0;
  const span = SCALE_MAX - MID; // 3 rating points from centre to edge
  const dv = Math.abs(Number(valence) - MID) / span;
  const da = Math.abs(Number(arousal) - MID) / span;
  return Math.min(1, Math.min(dv, da));
}

/** Below this, a reading is too near the centre to name an emotion for. */
export const WEAK_CONFIDENCE = 0.15;

/** Tally of which quadrant each point landed in, most frequent first. */
export function quadrantBreakdown(points) {
  const counts = new Map();
  let total = 0;
  for (const p of points) {
    const q = quadrantOf(p.valence, p.arousal);
    if (!q) continue;
    counts.set(q.key, (counts.get(q.key) || 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .map(([key, n]) => ({ ...QUADRANTS[key], n, pct: total ? n / total : 0 }))
    .sort((a, b) => b.n - a.n);
}
