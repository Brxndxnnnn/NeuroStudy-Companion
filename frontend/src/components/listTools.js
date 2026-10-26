"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui";

// Search and sort for the client and group lists on the Insights tab (26 Oct 2026).

// Case- and accent-insensitive, so "eu" finds "Eugene" and "zoe" finds "Zoë".
const fold = (s) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export const matchesSearch = (name, query) => fold(name).includes(fold(query).trim());

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
export const byName = (a, b) => collator.compare(a ?? "", b ?? "");

/* Sorts rows by one of `columns` ({ key: row => value }). Strings compare by name order,
   everything else numerically; missing values always go last, whichever way it is sorted. */
export function useSort(rows, columns, initial = { key: "name", dir: "asc" }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = columns[sort.key];
    if (!rows || !get) return rows ?? [];
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null || vb == null) return va == null ? (vb == null ? 0 : 1) : -1;
      return sign * (typeof va === "string" ? byName(va, vb) : va - vb);
    });
    // columns is a fresh object every render; the key it is read with is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  // Clicking the sorted column flips it; a new column starts ascending.
  const toggle = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));
  return { sorted, sort, setSort, toggle };
}

/* A column header that sorts the table. */
export function SortHeader({ label, column, sort, onSort, align = "left", className = "" }) {
  const active = sort.key === column;
  const arrow = active ? (sort.dir === "asc" ? "↑" : "↓") : "↕";
  return (
    <th
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={`font-semibold ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 rounded hover:text-ink focus-visible:outline-2 focus-visible:outline-accent ${
          active ? "text-ink" : ""
        }`}
      >
        {label}
        <span aria-hidden="true" className={active ? "" : "opacity-40"}>{arrow}</span>
      </button>
    </th>
  );
}

/* A search box with a clear button. */
export function SearchInput({ value, onChange, placeholder = "Search by name", label, className = "" }) {
  return (
    <div className={`relative ${className}`}>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="pr-9"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-[15px] leading-none text-muted hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}

/* "3 minutes ago", "2 hours ago", "5 days ago". */
export function timeAgo(t, now = Date.now()) {
  if (!t) return "";
  const mins = Math.floor((now - new Date(t).getTime()) / 60000);
  const unit = (n, w) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (mins < 1) return "just now";
  if (mins < 60) return unit(mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return unit(days, "day");
  return new Date(t).toLocaleDateString();
}
