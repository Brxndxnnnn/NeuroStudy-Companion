import { describe, expect, it } from "vitest";
import { highPassSamples, highPassZeroPhase } from "./eegDisplayFilter";

const FS = 250;
const rms = (xs) => Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / xs.length);

describe("highPassZeroPhase", () => {
  it("removes the electrode offset and drift but keeps a 10 Hz rhythm", () => {
    const n = FS * 20;
    const x = Array.from({ length: n }, (_, i) => 900 + 15 * (i / FS) + 5 * Math.sin(2 * Math.PI * 10 * (i / FS)));
    const mid = Array.from(highPassZeroPhase(x, FS).subarray(FS * 2, n - FS * 2));
    expect(Math.abs(mid.reduce((a, v) => a + v, 0) / mid.length)).toBeLessThan(0.5);
    expect(rms(mid)).toBeCloseTo(5 / Math.SQRT2, 1);
  });
});

describe("highPassSamples", () => {
  it("inserts a null row at a dropout so the chart breaks the line there", () => {
    const rows = [];
    for (let i = 0; i < FS * 4; i++) rows.push({ t_seconds: i / FS, a: 1000 });
    for (let i = 0; i < FS * 4; i++) rows.push({ t_seconds: 6 + i / FS, a: 3000 });
    const out = highPassSamples(rows, ["a"], FS);
    expect(out).toHaveLength(rows.length + 1);
    expect(out[FS * 4].a).toBeNull();
    for (const r of out) if (r.a !== null) expect(Math.abs(r.a)).toBeLessThan(1e-6);
  });

  it("passes values through unchanged when filtering is off", () => {
    const rows = [{ t_seconds: 0, a: 812 }, { t_seconds: 0.004, a: 813 }];
    expect(highPassSamples(rows, ["a"], FS, { filter: false }).map((r) => r.a)).toEqual([812, 813]);
  });
});
