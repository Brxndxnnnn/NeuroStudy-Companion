using System;
using System.Linq;

namespace NeuuroBridge
{
    /// <summary>Outcome of one impedance check (see <see cref="ImpedanceCheck"/>).</summary>
    public sealed class ImpedanceResult
    {
        /// <summary>Per-electrode impedance in kΩ, frame order (Fp1, Fp2, T4, T3). NaN = not measured.</summary>
        public float[] Kohm { get; set; }
        /// <summary>The test current's frequency found in the data, or 0 when none was found.</summary>
        public double ExcitationHz { get; set; }
        /// <summary>True when the band's test current was seen in the EEG, i.e. the numbers mean something.</summary>
        public bool Detected { get; set; }
        public DateTime Utc { get; set; }
        /// <summary>Why there is no result, when there is none.</summary>
        public string Note { get; set; }
    }

    /// <summary>
    /// Electrode impedance from the band's AC lead-off test (26 Oct / 13 Nov 2026).
    ///
    /// WHAT THE SDK CALLS IMPEDANCE
    /// ----------------------------
    /// The SDK's impedance callback (EEG_GetAmpOhmsFromEEG) takes half the peak-to-peak of each
    /// channel's last second of raw µV, divides by a 6 nA current and subtracts a 2200 Ω series
    /// resistor. The result is in OHMS, and it only means something while the band is injecting
    /// that current — "AC lead-off" mode (command FD 01 01). Neither the SDK nor the bridge ever
    /// switched that mode on, so the "impedance" the bridge used to show was just the size of the
    /// EEG, labelled in the wrong unit.
    ///
    /// HOW THIS MEASURES IT
    /// --------------------
    /// The 6 nA figure matches the ADS1299 EEG front end's lead-off current (6 nA / 24 nA / 6 µA /
    /// 24 µA) and the µV scale (0.02235 µV/count) is its LSB at gain 24. In AC lead-off mode the
    /// ADS1299 drives a square-wave current at 7.8 Hz, 31.2 Hz or fDR/4 (62.5 Hz at 250 Hz), set
    /// by the firmware. So: switch the mode on, record ~3 s, measure each channel's amplitude at
    /// whichever of those frequencies stands out, and convert. Measuring at the test frequency
    /// rather than peak-to-peak keeps blinks and drift out of the number.
    ///
    /// A square wave of peak I·Z has a fundamental of amplitude (4/π)·I·Z. Sampled at P samples per
    /// period it is 4 / (P·sin(π/P)) · I·Z instead (√2 at 62.5 Hz, where P = 4), so
    ///     Z = A₁ · P·sin(π/P) / (4 · I) − 2200 Ω.
    /// Unverified on the hardware: the firmware's current setting and waveform. If the current
    /// were a sine the figures would read 27% high; the grading thresholds are provisional anyway.
    /// </summary>
    public static class ImpedanceCheck
    {
        public const int SampleRateHz = 250;
        /// <summary>736 samples (2.94 s) is a whole number of periods at all three test frequencies
        /// (32, 8 and 4 samples), so each lands exactly on a DFT bin.</summary>
        public const int WindowSamples = 736;
        public static readonly double[] CandidateHz = { 7.8125, 31.25, 62.5 };

        public const double LeadOffCurrentAmps = 6e-9;
        public const double SeriesOhms = 2200;

        /// <summary>The test signal must stand this far above the neighbouring frequencies.</summary>
        public const double MinSnr = 5;

        /// <param name="uvPerChannel">Raw µV per electrode, at least <see cref="WindowSamples"/> each;
        /// the last WindowSamples are used.</param>
        public static ImpedanceResult Compute(float[][] uvPerChannel, DateTime utc)
        {
            int channels = uvPerChannel?.Length ?? 0;
            var result = new ImpedanceResult
            {
                Kohm = Enumerable.Repeat(float.NaN, channels).ToArray(),
                Utc = utc,
            };
            if (channels == 0 || uvPerChannel.Any(c => c == null || c.Length < WindowSamples))
            {
                result.Note = "Not enough EEG was received during the check.";
                return result;
            }

            var windows = uvPerChannel.Select(c => c.Skip(c.Length - WindowSamples).ToArray()).ToArray();

            // The test frequency is the candidate that stands out most, taken over all electrodes
            // (a dead electrode shows nothing at any frequency and must not decide it).
            double bestHz = 0, bestScore = 0;
            foreach (var hz in CandidateHz)
            {
                var snrs = windows.Select(w => Snr(w, hz)).OrderBy(s => s).ToArray();
                double median = snrs[snrs.Length / 2];
                if (median > bestScore) { bestScore = median; bestHz = hz; }
            }
            if (bestScore < MinSnr)
            {
                result.Note = "The band's test signal did not show up in the EEG, so impedance could not be measured.";
                return result;
            }

            result.Detected = true;
            result.ExcitationHz = bestHz;
            for (int ch = 0; ch < channels; ch++)
            {
                if (Snr(windows[ch], bestHz) < MinSnr) continue;   // nothing measurable on this electrode
                double amplitudeUv = Amplitude(windows[ch], bestHz);
                double ohms = amplitudeUv * 1e-6 / (SquareWaveFundamental(bestHz) * LeadOffCurrentAmps) - SeriesOhms;
                result.Kohm[ch] = (float)(Math.Max(0, ohms) / 1000.0);
            }
            return result;
        }

        /// <summary>Fundamental amplitude of a sampled ±1 square wave at <paramref name="hz"/>.</summary>
        internal static double SquareWaveFundamental(double hz)
        {
            double p = SampleRateHz / hz;
            return 4 / (p * Math.Sin(Math.PI / p));
        }

        /// <summary>Amplitude (µV) of the sine at <paramref name="hz"/>, mean removed.</summary>
        internal static double Amplitude(float[] x, double hz)
        {
            double mean = 0;
            foreach (var v in x) mean += v;
            mean /= x.Length;
            double re = 0, im = 0, w = 2 * Math.PI * hz / SampleRateHz;
            for (int n = 0; n < x.Length; n++)
            {
                double v = x[n] - mean;
                re += v * Math.Cos(w * n);
                im -= v * Math.Sin(w * n);
            }
            return 2.0 / x.Length * Math.Sqrt(re * re + im * im);
        }

        /// <summary>Amplitude at <paramref name="hz"/> over the median amplitude of the bins 3–8 away
        /// on either side (where the test signal itself does not leak, as it sits exactly on a bin).</summary>
        internal static double Snr(float[] x, double hz)
        {
            double bin = (double)SampleRateHz / x.Length;
            var noise = Enumerable.Range(3, 6)
                .SelectMany(k => new[] { hz - k * bin, hz + k * bin })
                .Where(f => f > 0.5 && f < SampleRateHz / 2.0)
                .Select(f => Amplitude(x, f))
                .OrderBy(a => a)
                .ToArray();
            double floor = noise.Length == 0 ? 0 : noise[noise.Length / 2];
            double signal = Amplitude(x, hz);
            return floor <= 1e-9 ? (signal > 1e-6 ? double.PositiveInfinity : 0) : signal / floor;
        }
    }
}
