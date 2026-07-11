"use client";
import { useEffect, useState } from "react";

const KEY = "ns-theme";

/**
 * Light/dark toggle. Defaults to the OS preference on first visit; once the
 * user chooses, the choice is stored and stamped as data-theme on <html>
 * (which overrides the prefers-color-scheme token block in both directions).
 * The no-flash inline script in the root layout applies the stored choice
 * before first paint, so this component only needs to reflect + update it.
 */
export default function ThemeToggle({ className = "" }) {
  const [theme, setTheme] = useState(null); // null until mounted → avoids hydration mismatch

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
    } else {
      const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setTheme(sysDark ? "dark" : "light");
    }
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
  };

  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-ink-2 transition-colors hover:text-ink hover:border-border-strong ${className}`}
    >
      {/* Render a stable icon only after mount so SSR and client agree */}
      {theme === null ? (
        <span className="h-4 w-4" />
      ) : isDark ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
