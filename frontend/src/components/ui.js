// Shared UI primitives for the NeuroStudy clinician app.
// Presentational only — no data fetching, no app state. Every page composes
// these so spacing, color, and interaction stay consistent across the app.

/* ── Brand mark ───────────────────────────────────────────────── */
export function BrandMark({ size = 30, className = "" }) {
  const inner = Math.round(size * 0.56);
  return (
    <span
      className={`inline-grid place-items-center rounded-[8px] shrink-0 shadow-sm ${className}`}
      style={{
        width: size,
        height: size,
        background: "linear-gradient(145deg, var(--accent), var(--accent-strong))",
      }}
      aria-hidden="true"
    >
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h3l2-5 3 10 2.5-7 1.5 4h4" />
      </svg>
    </span>
  );
}

export function BrandLockup({ subtitle, size = 28 }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandMark size={size} />
      <span className="leading-tight">
        <span className="block font-bold tracking-tight text-ink">NeuroStudy</span>
        {subtitle && <span className="block text-[11px] font-medium text-muted">{subtitle}</span>}
      </span>
    </div>
  );
}

/* ── Button ───────────────────────────────────────────────────── */
const BTN_BASE =
  "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all " +
  "active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 " +
  "focus-visible:outline-offset-2 focus-visible:outline-accent select-none";

const BTN_VARIANTS = {
  // accent-strong at rest, not accent: white text on plain accent only hits
  // ~3.8:1 in light mode, under the 4.5:1 text minimum. accent-strong clears
  // it with room. Hover goes the other way (to the brighter accent) rather
  // than darker still — a transient hover state gets more contrast leeway
  // than what's on screen at rest.
  primary: "bg-accent-strong text-on-accent shadow-sm hover:bg-accent",
  ghost: "bg-surface text-ink-2 border border-border hover:border-border-strong hover:text-ink",
  subtle: "bg-inset text-ink-2 hover:bg-border/60 hover:text-ink",
  danger: "bg-crit-soft text-crit-strong hover:bg-crit hover:text-white",
  quiet: "bg-transparent text-muted hover:text-ink hover:bg-inset",
};

const BTN_SIZES = {
  sm: "text-[13px] px-3 py-2",
  md: "text-sm px-4 py-2.5",
  lg: "text-base px-5 py-3.5",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  fullWidth = false,
  className = "",
  children,
  ...props
}) {
  return (
    <button
      className={`${BTN_BASE} ${BTN_VARIANTS[variant]} ${BTN_SIZES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading && <Spinner size={size === "lg" ? 18 : 15} />}
      {children}
    </button>
  );
}

/* ── Spinner ──────────────────────────────────────────────────── */
export function Spinner({ size = 16, className = "" }) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-current/25 border-t-current animate-spin align-[-2px] ${className}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

/* ── Card ─────────────────────────────────────────────────────── */
export function Card({ className = "", children, ...props }) {
  return (
    <div
      className={`bg-surface border border-border rounded-2xl shadow-[0_1px_2px_rgba(13,28,37,.04),0_1px_3px_rgba(13,28,37,.05)] ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className = "" }) {
  return (
    <div className={`flex items-start justify-between gap-4 px-6 py-5 border-b border-border ${className}`}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-bold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="text-[12.5px] text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/* ── Section label (uppercase mono micro-label) ───────────────── */
export function Label({ children, className = "" }) {
  return (
    <span className={`font-mono text-[10px] font-semibold tracking-[0.12em] uppercase text-muted ${className}`}>
      {children}
    </span>
  );
}

/* ── Form field + inputs ──────────────────────────────────────── */
// Split into "chrome" (color/border/focus, size-independent) and per-size
// padding/type, so a compact Select can swap in different sizing without
// fighting the default padding/text-size classes for the same properties —
// two Tailwind classes that both set e.g. padding-y have no reliable winner
// based on source order, only one based on Tailwind's own internal stylesheet
// order, so a compact variant needs its own complete class string rather than
// an override appended after the default one.
const INPUT_CHROME =
  "w-full border border-border-strong bg-inset text-ink " +
  "placeholder:text-muted transition-all focus:outline-none focus:border-accent focus:bg-surface " +
  "focus:ring-[3px] focus:ring-accent/20 disabled:opacity-60 disabled:cursor-not-allowed";
const INPUT = `${INPUT_CHROME} rounded-xl px-3.5 py-3 text-[15px]`;

export function Field({ label, required, hint, htmlFor, children, className = "" }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={htmlFor} className="mb-2 flex items-center gap-1">
          <Label>{label}</Label>
          {required && <span className="text-crit-strong text-xs leading-none">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="mt-1.5 text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

export function Input({ className = "", ...props }) {
  return <input className={`${INPUT} ${className}`} {...props} />;
}

// "md" is the standard form-field size (unchanged from before). "sm" is for a
// select sitting in a toolbar next to compact buttons — e.g. a segmented
// button group or a "Markers on" toggle — where the full form-field size reads
// as noticeably oversized next to them.
//
// py-2 (not py-1.5, which is what the segmented buttons themselves use) is
// deliberate: a segmented group's actual height is its border (1px) + its
// OWN p-0.5 wrapper padding (2px) + a button's py-1.5 (6px) per side, i.e. 2px
// more per side than the button padding alone. Select has no such wrapper —
// it's just a bordered box — so its py has to absorb that difference itself
// (py-1.5 + 2px = py-2) or it sits a few px shorter than a segmented group
// placed next to it in the same toolbar row, which throws off both controls'
// vertical centering AND their labels above (ControlGroup bottom-aligns).
const SELECT_SIZES = {
  md: `${INPUT} peer appearance-none cursor-pointer pr-9`,
  sm: `${INPUT_CHROME} rounded-lg px-2.5 py-2 text-[12px] font-semibold peer appearance-none cursor-pointer pr-7`,
};

export function Select({ className = "", size = "md", children, ...props }) {
  const small = size === "sm";
  return (
    <div className="relative">
      <select className={`${SELECT_SIZES[size]} ${className}`} {...props}>
        {children}
      </select>
      {/* Native <select> arrows are dropped (appearance-none, for consistent
          cross-browser styling) — this replaces the affordance that it's a
          dropdown, since without it nothing distinguishes a select from a
          plain text field. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted peer-disabled:opacity-50 ${
          small ? "right-2.5 h-3.5 w-3.5" : "right-3.5 h-4 w-4"
        }`}
      >
        <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function Textarea({ className = "", ...props }) {
  return <textarea className={`${INPUT} resize-none ${className}`} {...props} />;
}

/* ── Pill / status badge ──────────────────────────────────────── */
// good/warn/crit text on their own -soft background hit only ~2.8-3.3:1 in
// light mode — the -strong variants exist for exactly this (text on a soft
// tint), same pattern accent already used before this file had good/warn/crit
// equivalents. The dot below stays the plain tone: a small swatch is a
// graphical object (3:1 floor), not text, so it doesn't need the same fix.
const PILL_TONES = {
  neutral: "bg-inset text-ink-2",
  accent: "bg-accent-soft text-accent-strong",
  good: "bg-good-soft text-good-strong",
  warn: "bg-warn-soft text-warn-strong",
  crit: "bg-crit-soft text-crit-strong",
};

export function Pill({ tone = "neutral", dot = false, live = false, className = "", children }) {
  const dotColor = { good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)", accent: "var(--accent)", neutral: "var(--muted)" }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ${PILL_TONES[tone]} ${className}`}>
      {dot && (
        <span
          className={`h-[7px] w-[7px] rounded-full ${live ? "ns-blink" : ""}`}
          style={{ background: dotColor }}
        />
      )}
      {children}
    </span>
  );
}

/* ── Stat card ────────────────────────────────────────────────── */
export function StatCard({ label, value, unit, hint, className = "" }) {
  return (
    <Card className={`px-5 py-4 ${className}`}>
      <Label>{label}</Label>
      <div className="mt-2 text-[27px] font-bold tracking-tight tnum text-ink leading-none">
        {value}
        {unit && <span className="text-sm font-semibold text-muted ml-1">{unit}</span>}
      </div>
      {hint && <p className="mt-1.5 text-[12px] text-muted">{hint}</p>}
    </Card>
  );
}

/* ── Alert (inline feedback) ──────────────────────────────────── */
const ALERT_TONES = {
  good: "bg-good-soft text-good-strong border-good/25",
  crit: "bg-crit-soft text-crit-strong border-crit/25",
  warn: "bg-warn-soft text-warn-strong border-warn/25",
  accent: "bg-accent-soft text-accent-strong border-accent/25",
};

export function Alert({ tone = "accent", className = "", children }) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${ALERT_TONES[tone]} ${className}`} role="status">
      {children}
    </div>
  );
}

/* ── Page container ───────────────────────────────────────────── */
export function PageContainer({ width = "wide", className = "", children }) {
  const max = { narrow: "max-w-2xl", mid: "max-w-4xl", wide: "max-w-6xl", full: "max-w-7xl" }[width];
  return <div className={`${max} mx-auto w-full px-5 sm:px-8 ${className}`}>{children}</div>;
}

/* ── Page heading ─────────────────────────────────────────────── */
export function PageHeading({ title, subtitle, actions, className = "" }) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div>
        <h1 className="text-[26px] font-bold tracking-tight text-ink text-balance">{title}</h1>
        {subtitle && <p className="mt-1 text-[14px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}
