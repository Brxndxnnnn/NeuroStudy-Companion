using System;

namespace NeuuroBridge
{
    /// <summary>
    /// A causal, real-time Butterworth low-pass filter (ITP2 requirement #4 — client/supervisor
    /// spec, verbatim: "Apply a low-pass filter with a cutoff frequency of 100 Hz to all EEG
    /// signals before storage and analysis. Ensure filtering is consistently applied across all
    /// acquisition channels."). Replaces the Neeuro SDK's own onboard/vendor filter (a black box
    /// with no documented cutoff) as the source for <c>eeg_filtered_samples</c> and everywhere
    /// else the "filtered" stream is used — see BridgeController.HandleRawEeg.
    ///
    /// Order 4 (two cascaded biquads), same filter family as ml_service's own Python bandpass
    /// (ml_service/app/preprocessing/bandpass.py, scipy.signal.butter) — for methodological
    /// consistency across the project, not an independent choice.
    ///
    /// Deliberately CAUSAL (sample-by-sample, real-time), unlike ml_service's offline zero-phase
    /// sosfiltfilt — this bridge streams live data that must be filtered and stored as it
    /// arrives, before a whole session exists to filter forward-and-backward over. That's an
    /// inherent trade-off (causal IIR filters introduce frequency-dependent group delay),
    /// not an oversight: there is no non-causal option for a live streaming pipeline.
    ///
    /// One instance per channel — same coefficients (design is a pure function of cutoff/sample
    /// rate/order), independent per-channel state, which is exactly what "consistently applied
    /// across all channels" means: identical filtering, applied separately to each signal.
    ///
    /// Design: standard analog Butterworth pole placement, bilinear-transformed per conjugate
    /// pole pair into cascaded second-order sections (biquads), each run in Direct Form II
    /// Transposed (the standard numerically-stable streaming biquad structure). This is textbook
    /// DSP (e.g. Oppenheim &amp; Schafer's bilinear-transform design method) — verified against
    /// known test tones, not hand-derived from scratch per channel at runtime.
    /// </summary>
    public sealed class LowPassFilter
    {
        private struct Biquad
        {
            public double B0, B1, B2, A1, A2;
            public double S1, S2; // Direct Form II Transposed state

            public double Process(double x)
            {
                double y = B0 * x + S1;
                S1 = B1 * x - A1 * y + S2;
                S2 = B2 * x - A2 * y;
                return y;
            }
        }

        private readonly Biquad[] _sections;

        /// <param name="cutoffHz">Low-pass cutoff frequency in Hz.</param>
        /// <param name="sampleRateHz">The signal's sample rate in Hz.</param>
        /// <param name="order">Filter order — must be even (built as order/2 cascaded biquads). 4 by default.</param>
        public LowPassFilter(double cutoffHz, double sampleRateHz, int order = 4)
        {
            if (order <= 0 || order % 2 != 0)
                throw new ArgumentException("order must be a positive even number (cascaded biquads).", nameof(order));
            if (cutoffHz <= 0 || cutoffHz >= sampleRateHz / 2.0)
                throw new ArgumentException("cutoffHz must be between 0 and the Nyquist frequency (sampleRateHz/2).", nameof(cutoffHz));

            // Bilinear-transform pre-warp: a straight s -> z substitution compresses the analog
            // frequency axis, so without this the digital filter's actual -3dB point would land
            // below the requested cutoff. Standard correction before any pole placement.
            double k = 2.0 * sampleRateHz;
            double warpedWc = 2.0 * sampleRateHz * Math.Tan(Math.PI * cutoffHz / sampleRateHz);

            int pairCount = order / 2;
            _sections = new Biquad[pairCount];

            for (int pair = 0; pair < pairCount; pair++)
            {
                // Two analog Butterworth poles per section (a conjugate pair), evenly spaced on
                // the unit circle in the left half-plane. For pole index k = pair and its
                // conjugate (order-1-pair), angle = pi/2 + (2k+1)*pi/(2*order); only the real part
                // (poleReal, always negative for a stable filter) is needed — the conjugate
                // pair's imaginary parts cancel out of the resulting real-coefficient section.
                double theta = Math.PI / 2.0 + (2.0 * pair + 1.0) * Math.PI / (2.0 * order);
                double poleReal = Math.Cos(theta); // < 0

                // Analog 2nd-order section scaled to the pre-warped cutoff, DC gain = 1:
                //   H(s) = wc^2 / (s^2 - 2*poleReal*wc*s + wc^2)
                double a0 = 1.0;
                double a1 = -2.0 * poleReal * warpedWc;
                double a2 = warpedWc * warpedWc;
                double b2 = warpedWc * warpedWc; // b0 = b1 = 0 (pure low-pass numerator)

                // Bilinear transform (standard biquad formulas, K = 2*sampleRateHz):
                double kk = k * k;
                double d = a0 * kk + a1 * k + a2;

                _sections[pair] = new Biquad
                {
                    B0 = b2 / d,
                    B1 = (2.0 * b2) / d,
                    B2 = b2 / d,
                    A1 = (2.0 * a2 - 2.0 * a0 * kk) / d,
                    A2 = (a0 * kk - a1 * k + a2) / d,
                    S1 = 0,
                    S2 = 0,
                };
            }
        }

        /// <summary>Filters one sample through all cascaded sections. Call once per incoming
        /// sample, in order, for a single channel — state is maintained across calls.</summary>
        public float Process(float sample)
        {
            double x = sample;
            for (int i = 0; i < _sections.Length; i++)
                x = _sections[i].Process(x);
            return (float)x;
        }
    }
}
