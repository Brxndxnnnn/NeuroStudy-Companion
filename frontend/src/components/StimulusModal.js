"use client";
import { useEffect } from "react";
import { Pill } from "@/components/ui";

// Click-through from an event band: the image (or math question) that was on
// screen during that window, plus the band-power averages recorded while it
// showed. Shared by the session-results page and Insights' predicted-vs-actual
// chart — both build their `events` array with the same buildEventWindows
// util from the same /results event rows, so this needs no per-caller shape.
export default function StimulusModal({ event, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isImage = event.type === "image";
  const isPhase = event.type === "phase";
  const averages = [
    { label: "Attention", value: event.avg_attention, digits: 2 },
    { label: "Relaxation", value: event.avg_relaxation, digits: 2 },
    { label: "Workload", value: event.avg_mental_workload, digits: 2 },
    { label: "Heart rate", value: event.avg_heart_rate, digits: 0, unit: "bpm" },
    { label: "SpO₂", value: event.avg_spo2, digits: 0, unit: "%" },
  ].filter((a) => a.value != null);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-8 bg-black/50 anim-fade"
      role="dialog"
      aria-modal="true"
      aria-label={event.label}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-ink">{event.label}</span>
            {event.category && <Pill tone="neutral">{event.category}</Pill>}
            {event.difficulty && <Pill tone="neutral">{event.difficulty}</Pill>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:text-ink hover:bg-inset transition-colors"
          >
            ✕
          </button>
        </div>

        {isImage ? (
          <div className="bg-inset grid place-items-center">
            {event.url ? (
              <img
                src={event.url}
                alt={event.filename || event.label}
                className="max-h-[55vh] w-full object-contain"
              />
            ) : (
              <p className="py-14 text-muted text-sm">Image details unavailable for this event.</p>
            )}
          </div>
        ) : isPhase ? (
          <div className="px-6 py-12 text-center">
            <p className="text-ink text-sm">No stimulus was shown during this window — it&apos;s a countdown or baseline recording period from the standardised protocol.</p>
          </div>
        ) : (
          <div className="px-6 py-12 text-center">
            {event.prompt ? (
              <p className="font-mono text-3xl font-semibold text-ink tnum">{event.prompt}</p>
            ) : (
              <p className="text-muted text-sm">Question details unavailable for this event.</p>
            )}
          </div>
        )}

        <div className="px-5 py-4 border-t border-border flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="font-mono text-[12px] text-muted tnum">
            Shown {event.from.toFixed(1)}s – {event.to.toFixed(1)}s · {(event.to - event.from).toFixed(1)}s
          </span>
          {averages.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {averages.map((a) => (
                <span key={a.label} className="text-[12px] text-muted">
                  {a.label}{" "}
                  <b className="font-mono text-ink tnum">
                    {Number(a.value).toFixed(a.digits)}
                    {a.unit ? ` ${a.unit}` : ""}
                  </b>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
