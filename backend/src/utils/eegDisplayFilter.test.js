import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { highPassSamples, highPassZeroPhase, minMaxDownsample } from './eegDisplayFilter.js'

const FS = 250

function rms(xs) {
    return Math.sqrt(xs.reduce((a, v) => a + v * v, 0) / xs.length)
}

describe('highPassZeroPhase', () => {
    test('removes a DC offset and slow drift but keeps a 10 Hz rhythm at full amplitude', () => {
        const n = FS * 20
        const x = Array.from({ length: n }, (_, i) => {
            const t = i / FS
            return 900 + 15 * t + 5 * Math.sin(2 * Math.PI * 10 * t)   // offset + drift + 5 µV alpha
        })
        const y = highPassZeroPhase(x, FS)
        const mid = Array.from(y.subarray(FS * 2, n - FS * 2))
        const mean = mid.reduce((a, v) => a + v, 0) / mid.length
        assert.ok(Math.abs(mean) < 0.5, `mean ${mean}`)
        assert.ok(Math.abs(rms(mid) - 5 / Math.SQRT2) < 0.1, `rms ${rms(mid)}`)
    })

    test('does not shift a spike in time (zero phase)', () => {
        const x = new Array(FS * 10).fill(500)
        x[FS * 5] = 600
        const y = highPassZeroPhase(x, FS)
        let peak = 0
        for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[peak])) peak = i
        assert.equal(peak, FS * 5)
    })
})

describe('highPassSamples', () => {
    test('filters each contiguous segment separately and breaks the line at a gap', () => {
        const rows = []
        for (let i = 0; i < FS * 4; i++) rows.push({ t_seconds: i / FS, a: 1000, time: 'x' })
        for (let i = 0; i < FS * 4; i++) rows.push({ t_seconds: 6 + i / FS, a: 3000, time: 'x' })

        const out = highPassSamples(rows, ['a'], FS)

        assert.equal(out.length, rows.length + 1)
        const gap = out[FS * 4]
        assert.equal(gap.a, null)
        assert.ok(gap.t_seconds > 4 - 1 / FS && gap.t_seconds < 6)
        // A constant segment high-passes to zero — no smear from the 2000 µV step across the gap.
        for (const r of out) if (r.a !== null) assert.ok(Math.abs(r.a) < 1e-6)
        assert.equal(out[0].time, undefined)
    })
})

describe('minMaxDownsample', () => {
    test('keeps a one-sample spike that stride decimation would drop', () => {
        const pts = Array.from({ length: 10000 }, (_, i) => ({ t: i / FS, v: 0 }))
        pts[4321].v = 80
        const out = minMaxDownsample(pts, 400)
        assert.ok(out.length <= 400)
        assert.ok(out.some((p) => p.v === 80))
    })
})
