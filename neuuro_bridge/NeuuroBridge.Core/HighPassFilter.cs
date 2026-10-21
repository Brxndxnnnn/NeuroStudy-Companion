using System;

namespace NeuuroBridge
{
    /// <summary>
    /// A causal 2nd-order Butterworth high-pass, for DISPLAY only (the live EEG chart). The stored
    /// stream is low-passed only (see <see cref="LowPassFilter"/>), so every channel keeps the
    /// electrode's DC offset (hundreds to thousands of µV) and a slow drift of tens to hundreds of µV
    /// — far larger than the EEG itself. Auto-gained, that drift set the scale and the brain activity
    /// drew as a near-flat line. The web chart and PDF apply the same 0.5 Hz cut-off, zero-phase
    /// (frontend/backend src/utils/eegDisplayFilter.js); live data has to be causal.
    ///
    /// Bilinear-transformed, Direct Form II Transposed — same structure as LowPassFilter.
    /// </summary>
    public sealed class HighPassFilter
    {
        private readonly double _b0, _b1, _b2, _a1, _a2;
        private double _s1, _s2;
        private bool _primed;

        public HighPassFilter(double cutoffHz, double sampleRateHz)
        {
            if (cutoffHz <= 0 || cutoffHz >= sampleRateHz / 2.0)
                throw new ArgumentException("cutoffHz must be between 0 and the Nyquist frequency (sampleRateHz/2).", nameof(cutoffHz));
            double k = Math.Tan(Math.PI * cutoffHz / sampleRateHz);
            double norm = 1.0 / (1.0 + Math.Sqrt(2.0) * k + k * k);
            _b0 = norm;
            _b1 = -2.0 * norm;
            _b2 = norm;
            _a1 = 2.0 * (k * k - 1.0) * norm;
            _a2 = (1.0 - Math.Sqrt(2.0) * k + k * k) * norm;
        }

        /// <summary>Forget the previous signal. Call after a gap: the next sample primes the state as
        /// if it had been held constant forever, so the offset jump across the gap does not ring.</summary>
        public void Reset() => _primed = false;

        public double Process(double x)
        {
            if (!_primed)
            {
                // Steady state for a constant input x: output 0, so the trace starts at the baseline
                // instead of decaying from the full DC offset over several seconds.
                _s1 = -_b0 * x;
                _s2 = _b2 * x;
                _primed = true;
            }
            double y = _b0 * x + _s1;
            _s1 = _b1 * x - _a1 * y + _s2;
            _s2 = _b2 * x - _a2 * y;
            return y;
        }
    }
}
