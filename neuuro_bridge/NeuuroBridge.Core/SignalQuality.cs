using System;

namespace NeuuroBridge
{
    /// <summary>
    /// Derives a 0–100 signal-quality score and human-readable grades for TS1.3
    /// (impedance check + signal-quality reporting). The score is written to
    /// band_powers.signal_quality.
    ///
    /// The score combines the SDK's per-channel contact status, the overall signal-ready
    /// flag, and — critically — whether each channel's data is actually MOVING. The SDK's
    /// contact flag alone is not sufficient: on 13 Jul, T3 then T4 sat railed at a constant
    /// ADC value for whole sessions (zero peak-to-peak, i.e. no signal whatsoever) while the
    /// SDK kept reporting them as connected, so the panel showed "GOOD" over dead electrodes.
    /// A channel that isn't changing is not a channel, whatever the flag says.
    ///
    /// Impedance is surfaced for the technician but is advisory: the SDK's impedance
    /// scale/units are not documented and can't be verified without hardware, so it does not
    /// (yet) drive the score. The thresholds in <see cref="GradeImpedance"/> are provisional
    /// pending a bench check.
    /// </summary>
    public static class SignalQuality
    {
        // Provisional kΩ thresholds for a dry-electrode contact. Tune once verified on hardware.
        private const float GoodKohm = 50f;
        private const float FairKohm = 200f;

        /// <summary>
        /// 0–100 quality score. Higher is better contact / cleaner signal.
        /// </summary>
        /// <param name="signalReady">SDK's overall stream-ready flag.</param>
        /// <param name="channels">SDK's per-electrode contact flags.</param>
        /// <param name="live">
        /// Per-electrode liveness (see <c>BridgeController.ChannelLive</c>): false where the
        /// channel has been flat-lined for several frames. Optional — pass null when unknown,
        /// which preserves the old contact-flags-only behaviour.
        /// </param>
        public static int Compute(bool? signalReady, bool[] channels, bool[] live = null)
        {
            int score;
            if (channels != null && channels.Length > 0)
            {
                int ok = 0;
                for (int i = 0; i < channels.Length; i++)
                {
                    // A railed/flat electrode counts as failed even if the SDK says it's
                    // connected — that combination is exactly the silent failure mode.
                    bool flat = live != null && i < live.Length && !live[i];
                    if (channels[i] && !flat) ok++;
                }
                score = (int)Math.Round(100.0 * ok / channels.Length);
            }
            else if (live != null && live.Length > 0)
            {
                // No contact flags yet, but we can still see whether the data is moving.
                int ok = 0;
                foreach (var l in live) if (l) ok++;
                score = (int)Math.Round(100.0 * ok / live.Length);
            }
            else
            {
                // Nothing per-channel yet: fall back to the ready flag alone.
                score = signalReady == true ? 100 : signalReady == false ? 0 : 50;
            }

            // While the SDK reports "settling" (not ready), cap the score — even if
            // every electrode reads as connected the stream isn't trustworthy yet.
            if (signalReady == false) score = Math.Min(score, 40);

            return Math.Max(0, Math.Min(100, score));
        }

        public static string Label(int score) =>
            score >= 75 ? "GOOD" : score >= 40 ? "FAIR" : "POOR";

        /// <summary>
        /// True when an impedance reading is a real measurement. A real skin-electrode contact
        /// is some kΩ; zero/negative is the SDK's "not measured" sentinel, NOT a perfect contact.
        /// </summary>
        public static bool HasImpedance(float kohm) => !float.IsNaN(kohm) && kohm > 0f;

        /// <summary>Advisory per-electrode grade from an impedance reading (kΩ).</summary>
        public static string GradeImpedance(float kohm)
        {
            if (!HasImpedance(kohm)) return "not measured";
            if (kohm <= GoodKohm) return "good";
            if (kohm <= FairKohm) return "fair";
            return "poor";
        }

        /// <summary>
        /// Display text for an impedance reading. Renders the not-measured sentinel as "—"
        /// rather than "0.0 kΩ", which reads to a human as an ideal contact when it means
        /// the opposite: no reading at all.
        /// </summary>
        public static string FormatImpedance(float kohm) =>
            HasImpedance(kohm) ? $"{kohm:F1} kΩ ({GradeImpedance(kohm)})" : "— (not measured)";
    }
}
