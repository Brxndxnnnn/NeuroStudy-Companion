"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark, Button } from "./ui";
import ThemeToggle from "./ThemeToggle";
import { logout } from "@/utils/api";

const CLINICIAN_LINKS = [
  { href: "/history", label: "Clients" },
  { href: "/insights", label: "Insights" },
];

const ADMIN_LINKS = [
  { href: "/admin", label: "Admin" },
  { href: "/history", label: "Clients" },
];

/**
 * Persistent top navigation shell. Highlights the active route, adapts its
 * links to the signed-in role, and centralizes logout. Pages that are part of
 * a focused session flow use SessionTopBar instead.
 */
export default function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [name, setName] = useState("");
  const [links, setLinks] = useState(CLINICIAN_LINKS);

  useEffect(() => {
    const role = localStorage.getItem("userRole");
    setLinks(role === "admin" || role === "superadmin" ? ADMIN_LINKS : CLINICIAN_LINKS);
    setName(localStorage.getItem("userName") || localStorage.getItem("userRole") || "");
  }, []);

  const initials = (name || "NS")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto flex h-15 items-center justify-between px-5 sm:px-8 py-3">
        <div className="flex items-center gap-6">
          <Link href="/history" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="font-bold tracking-tight text-ink hidden sm:block">NeuroStudy</span>
          </Link>
          <nav className="flex items-center gap-1">
            {links.map((l) => {
              const active = pathname === l.href || pathname.startsWith(l.href + "/");
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors ${
                    active ? "bg-accent-soft text-accent-strong" : "text-muted hover:text-ink hover:bg-inset"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Button variant="quiet" size="sm" onClick={() => logout()}>
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
