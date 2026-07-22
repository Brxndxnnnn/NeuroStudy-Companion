"use client";
import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { BrandMark, Button } from "./ui";
import ThemeToggle from "./ThemeToggle";
import { useAuth } from "@/context/AuthContext";

const CLINICIAN_LINKS = [
  { href: "/history", label: "Clients" },
  { href: "/sessions", label: "Sessions" },
  { href: "/stimulus-sets", label: "Stimulus set" },
  { href: "/insights", label: "Insights" },
];

const ADMIN_LINKS = [
  { href: "/admin", label: "Admin" },
  { href: "/history", label: "Clients" },
  { href: "/sessions", label: "Sessions" },
];

/**
 * Persistent top navigation shell. Highlights the active route, adapts its
 * links to the signed-in role, and centralizes logout. Pages that are part of
 * a focused session flow use SessionTopBar instead.
 */
export default function TopNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, signOut } = useAuth();
  const name = user?.display_name || user?.role || "";
  const links = user?.role === "admin" || user?.role === "superadmin" ? ADMIN_LINKS : CLINICIAN_LINKS;

  const handleSignOut = async () => {
    await signOut();
    window.location.assign("/login");
  };

  const initials = (name || "NS")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const isActive = (href) => pathname === href || pathname.startsWith(href + "/");

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto flex h-15 items-center justify-between px-5 sm:px-8 py-3">
        <div className="flex items-center gap-6">
          <Link href="/history" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="font-bold tracking-tight text-ink hidden sm:block">NeuroStudy</span>
          </Link>
          <nav aria-label="Main" className="hidden md:flex items-center gap-1">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${
                  isActive(l.href) ? "bg-accent-soft text-accent-strong" : "text-muted hover:text-ink hover:bg-inset"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-ink-2 hover:text-ink hover:border-border-strong transition-colors md:hidden"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
            </svg>
          </button>
          <div className="hidden md:flex items-center gap-3">
            <ThemeToggle />
            <Button variant="quiet" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
            <Link
              href="/profile"
              className="grid h-8 w-8 place-items-center rounded-full bg-accent text-on-accent text-[12px] font-bold ring-offset-2 ring-offset-surface hover:ring-2 hover:ring-accent/40 transition-shadow"
              title={name ? `${name} — view profile` : "View profile"}
              aria-label="View your profile"
            >
              {initials}
            </Link>
          </div>
        </div>
      </div>

      {menuOpen && (
        <nav aria-label="Main" className="md:hidden border-t border-border bg-surface px-5 py-3 space-y-1 anim-fade">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className={`block rounded-lg px-3 py-2.5 text-[14px] font-semibold transition-colors ${
                isActive(l.href) ? "bg-accent-soft text-accent-strong" : "text-ink-2 hover:text-ink hover:bg-inset"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <div className="flex items-center justify-between gap-3 pt-3 mt-2 border-t border-border">
            <Link
              href="/profile"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2.5 text-[13px] font-semibold text-ink-2 hover:text-ink"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-on-accent text-[11px] font-bold">
                {initials}
              </span>
              Profile
            </Link>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <Button variant="quiet" size="sm" onClick={handleSignOut}>
                Sign out
              </Button>
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}

/**
 * Slim contextual header for the focused pairing/session flow — a back action
 * on the left, session context in the middle/right. Keeps the operator anchored
 * without the full nav pulling focus during a live session.
 */
export function SessionTopBar({ onBack, backLabel = "Back", patient, right }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto flex h-15 items-center justify-between px-5 sm:px-8 py-3">
        <div className="flex items-center gap-4">
          {onBack && (
            <Button variant="quiet" size="sm" onClick={onBack}>
              <span aria-hidden="true">←</span> {backLabel}
            </Button>
          )}
          <div className="hidden sm:flex items-center gap-2.5">
            <BrandMark size={26} />
            {patient && (
              <span className="text-sm text-muted">
                Patient <span className="font-semibold text-ink">{patient}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {right}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
