// frontend/src/utils/eegDisplayFilter.js
//
// Display-only conditioning for the stored "filtered" EEG. Since ITP2 #4 the bridge stores its own
// 100 Hz LOW-pass only, so every channel still carries the electrode's DC offset (hundreds to
// thousands of µV) and a slow drift of hundreds of µV. Autoscaled, that buries the few-µV EEG and
// the trace reads as a flat sloping line — which is what an EEG reviewer saw on 21 Oct 2026.
//
// This applies the standard clinical-viewer high-pass (0.5 Hz) without changing what is stored.
// Zero-phase (forward + backward), so spikes are not shifted in time, and run per contiguous
// segment: filtering across a dropout would smear the step into a fake slow wave.
//
// Mirrored in backend/src/utils/eegDisplayFilter.js (the PDF report) — keep both in sync.

export const DISPLAY_HIGH_PASS_HZ = 0.5

// A gap is anything longer than this many sample periods (the bridge stamps samples 4 ms apart).
const GAP_PERIODS = 3

// 2nd-order Butterworth high-pass, bilinear transform. Applied twice (filtfilt), so the effective
// response is 4th order with -6 dB at the cut-off.
function highPassCoefficients(fs, fc) {
    const k = Math.tan((Math.PI * fc) / fs)
    const norm = 1 / (1 + Math.SQRT2 * k + k * k)
    return {
        b0: norm, b1: -2 * norm, b2: norm,
        a1: 2 * (k * k - 1) * norm,
        a2: (1 - Math.SQRT2 * k + k * k) * norm,
    }
}

function biquadInPlace(x, c) {
    let z1 = 0, z2 = 0
    for (let i = 0; i < x.length; i++) {
        const v = x[i]
        const y = c.b0 * v + z1
        z1 = c.b1 * v - c.a1 * y + z2
        z2 = c.b2 * v - c.a2 * y
        x[i] = y
    }
}

/**
 * Zero-phase high-pass of one contiguous series. Odd-reflection padding at both ends (as scipy's
 * filtfilt does) keeps the start-up transient out of the returned samples.
 * @param {number[]} values contiguous samples (no gaps)
 * @returns {Float64Array}
 */
export function highPassZeroPhase(values, fs, fc = DISPLAY_HIGH_PASS_HZ) {
    const n = values.length
    if (n < 3) return Float64Array.from(values, () => 0)
    const c = highPassCoefficients(fs, fc)
    const pad = Math.min(n - 1, Math.round(3 * fs))
    const x0 = values[0], xn = values[n - 1]
    const buf = new Float64Array(n + 2 * pad)
    for (let i = 0; i < pad; i++) buf[i] = x0 - (values[pad - i] - x0) - x0
    for (let i = 0; i < n; i++) buf[pad + i] = values[i] - x0
    for (let i = 0; i < pad; i++) buf[pad + n + i] = xn - (values[n - 2 - i] - xn) - x0
    biquadInPlace(buf, c)
    buf.reverse()
    biquadInPlace(buf, c)
    buf.reverse()
    return buf.subarray(pad, pad + n)
}

/**
 * High-pass every channel of a sample array, per contiguous segment, and insert a null row in each
 * gap so a line chart breaks there instead of drawing a straight line across the missing data.
 * @param {object[]} rows ascending by `timeKey` (seconds)
 * @param {string[]} keys channel fields to filter
 * @returns {object[]} new rows: { [timeKey], ...keys } — other fields are dropped
 */
export function highPassSamples(rows, keys, fs, { fc = DISPLAY_HIGH_PASS_HZ, timeKey = 't_seconds', filter = true } = {}) {
    const out = []
    if (!rows || rows.length === 0) return out
    const maxStep = GAP_PERIODS / fs
    let start = 0
    const flush = (end) => {
        const seg = rows.slice(start, end)
        const filtered = keys.map((k) => {
            const v = seg.map((r) => Number(r[k]))
            return filter ? highPassZeroPhase(v, fs, fc) : v
        })
        for (let i = 0; i < seg.length; i++) {
            const row = { [timeKey]: seg[i][timeKey] }
            keys.forEach((k, j) => { row[k] = filtered[j][i] })
            out.push(row)
        }
    }
    for (let i = 1; i <= rows.length; i++) {
        if (i === rows.length || rows[i][timeKey] - rows[i - 1][timeKey] > maxStep) {
            flush(i)
            if (i < rows.length) {
                const gapRow = { [timeKey]: rows[i - 1][timeKey] + 1 / fs }
                for (const k of keys) gapRow[k] = null
                out.push(gapRow)
            }
            start = i
        }
    }
    return out
}
