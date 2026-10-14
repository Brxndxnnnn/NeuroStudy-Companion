"use client";
import { useEffect } from "react";
import { Card, CardHeader, Button } from "@/components/ui";

/**
 * Dialog over the page for long forms. Closes with the Close button or Escape, but not by clicking
 * the backdrop — these forms are long and a stray click shouldn't throw away what was typed.
 * `busy` blocks closing while a request is in flight. Mount it only while open (`{open && <Modal/>}`)
 * so its form state resets naturally if the parent keeps state elsewhere.
 */
export default function Modal({ title, subtitle, onClose, busy = false, maxWidth = "max-w-4xl", children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <Card className={`w-full ${maxWidth} anim-fade`}>
        <CardHeader
          title={title}
          subtitle={subtitle}
          actions={
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Close
            </Button>
          }
        />
        {children}
      </Card>
    </div>
  );
}
