// backend/src/utils/spectrum.js
//
// Computes a per-channel power spectrum (0..maxFreqHz) from a slice of real-valued EEG samples,
// for the PDF report's "Power vs Frequency" charts (see services/report.service.js). No existing
// table stores a full frequency-domain curve — fft_band_powers/band_powers/elliptic_band_stats
// only hold already-summed band power — so this is new computation either way; done in-process
// here rather than proxied to ml_service, to avoid a cross-container call on every report.
//
// A plain radix-2 Cooley-Tukey FFT, zero-padded to the next power of two — the same algorithm the
// C# bridge's live chart already uses (neuuro_bridge/NeuuroBridge.Core/EegProcessor.cs), kept
// unwindowed for consistency with that precedent rather than introducing a new signal-processing
// choice (e.g. a Hann window) nothing else in this project uses.

function nextPowerOfTwo(n) {
    let p = 1
    while (p < n) p *= 2
    return p
}

// In-place iterative radix-2 Cooley-Tukey FFT. re/im must be the same power-of-two length.
function fft(re, im) {
    const n = re.length

    // Bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr
            const ti = im[i]; im[i] = im[j]; im[j] = ti
        }
    }

    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len
        const wRe = Math.cos(ang)
        const wIm = Math.sin(ang)
        for (let i = 0; i < n; i += len) {
            let curRe = 1, curIm = 0
            const half = len / 2
            for (let k = 0; k < half; k++) {
                const uRe = re[i + k], uIm = im[i + k]
                const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm
                const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe
                re[i + k] = uRe + vRe
                im[i + k] = uIm + vIm
                re[i + k + half] = uRe - vRe
                im[i + k + half] = uIm - vIm
                const nextRe = curRe * wRe - curIm * wIm
                const nextIm = curRe * wIm + curIm * wRe
                curRe = nextRe
                curIm = nextIm
            }
        }
    }
}

/**
 * One-sided power spectrum for a single channel's real-valued sample slice.
 * @param {number[]} samples real-valued samples (filtered EEG, µV), in time order
 * @param {number} sampleRateHz the sampling rate the samples were taken at
 * @param {number} maxFreqHz only bins up to this frequency are returned (default 15, matching the
 *   client template's Power-vs-Frequency chart range)
 * @returns {{freqHz: number, powerUvSq: number}[]}
 */
export function computePowerSpectrum(samples, sampleRateHz, maxFreqHz = 15) {
    if (!samples || samples.length < 2 || !sampleRateHz) return []

    const n = nextPowerOfTwo(samples.length)
    const re = new Float64Array(n)
    const im = new Float64Array(n)

    // Remove DC offset first — a baseline electrode offset isn't a real oscillation, and leaving
    // it in would dwarf every other bin on the chart. Everything past samples.length stays zero
    // (Float64Array default), which is the zero-padding.
    let mean = 0
    for (let i = 0; i < samples.length; i++) mean += samples[i]
    mean /= samples.length
    for (let i = 0; i < samples.length; i++) re[i] = samples[i] - mean

    fft(re, im)

    const binHz = sampleRateHz / n
    const points = []
    for (let k = 1; k < n / 2 && k * binHz <= maxFreqHz; k++) {
        const power = (re[k] * re[k] + im[k] * im[k]) / n
        points.push({ freqHz: k * binHz, powerUvSq: power })
    }
    return points
}
