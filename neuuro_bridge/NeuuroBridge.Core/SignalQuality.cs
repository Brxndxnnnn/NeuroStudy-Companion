using System;

namespace NeuuroBridge
{
    /// <summary>
    /// Derives a 0–100 signal-quality score and human-readable grades for TS1.3
    /// (impedance check + signal-quality reporting). The score is written to
    /// band_powers.signal_quality.
    ///
    /// The score is driven by the SDK's per-channel contact status and the overall
    /// signal-ready flag — both reliable. Impedance is surfaced for the technician but
    /// is treated as advisory: the SDK's impedance scale/units are not documented and
    /// can't be verified without hardware, so it does not (yet) drive the score. The
    /// thresholds in <see cref="GradeImpedance"/> are provisional pending a bench check.
    /// </summary>
    public static class SignalQuality
    {
        // Provisional kΩ thresholds for a dry-electrode contact. Tune once verified on hardware.
        private const float GoodKohm = 50f;
        private const float FairKohm = 200f;

        /// <summary>0–100 quality score. Higher is better contact / cleaner signal.</summary>
        public static int Compute(bool? signalReady, bool[] channels)
        {
            int score;
            if (channels != null && channels.Length > 0)
            {
                int ok = 0;
                foreach (var c in channels) if (c) ok++;
                score = (int)Math.Round(100.0 * ok / channels.Length);
            }
            else
            {
                // No per-channel data yet: fall back to the ready flag alone.
                score = signalReady == true ? 100 : signalReady == false ? 0 : 50;
            }

            // While the SDK reports "settling" (not ready), cap the score — even if
            // every electrode reads as connected the stream isn't trustworthy yet.
            if (signalReady == false) score = Math.Min(score, 40);

            return Math.Max(0, Math.Min(100, score));
        }

        public static string Label(int score) =>
            score >= 75 ? "GOOD" : score >= 40 ? "FAIR" : "POOR";

        /// <summary>Advisory per-electrode grade from an impedance reading (kΩ).</summary>
        public static string GradeImpedance(float kohm)
        {
            if (float.IsNaN(kohm) || kohm <= 0f) return "n/a";
            if (kohm <= GoodKohm) return "good";
            if (kohm <= FairKohm) return "fair";
            return "poor";
        }
    }
}
