using System;

namespace NeuuroBridge
{
    /// <summary>
    /// A steady 250 Hz timeline for the SDK's 200 ms live packages (see
    /// <see cref="SenzeBandService.OnLivePackage"/>), shared by the live chart and the blink/clench
    /// detector so both put a given sample at the same moment.
    ///
    /// Each sample gets a fixed slot on the clock instead of a time worked back from when its package
    /// arrived: arrival jitters by tens of ms, which made anything positioned by time (markers) jump
    /// against a trace that moves evenly. A dropout shows up as the clock running clearly ahead of
    /// the samples that have arrived; the shortfall is reported so the caller can place a gap of its
    /// real length. A package that is merely late is absorbed by the tolerance, and one that arrives
    /// early (or a band clock running slightly fast) re-anchors the clock.
    ///
    /// Not thread-safe; feed it from one thread.
    /// </summary>
    public sealed class PackageSampleClock
    {
        private readonly double _intervalMs;
        private readonly int _maxGapSamples;
        private readonly double _toleranceSamples;
        private double _delivered;   // samples (real + gap) placed since OriginUtc

        /// <param name="maxGapSamples">Longest gap reported at once; anything beyond is dropped from
        /// the timeline rather than carried, so a long disconnect doesn't pad the history.</param>
        /// <param name="toleranceSamples">Delivery jitter allowed before a gap is declared (~1.25
        /// packages by default).</param>
        public PackageSampleClock(int sampleRateHz, int maxGapSamples, double toleranceSamples = 62)
        {
            _intervalMs = 1000.0 / sampleRateHz;
            _maxGapSamples = maxGapSamples;
            _toleranceSamples = toleranceSamples;
        }

        public bool Started { get; private set; }

        /// <summary>Start of the timeline: the first sample of the first package.</summary>
        public DateTime OriginUtc { get; private set; }

        public void Reset()
        {
            Started = false;
            _delivered = 0;
        }

        /// <summary>Places a package of <paramref name="samplesPerChannel"/> samples whose last
        /// sample arrived at <paramref name="endUtc"/>. Returns how many gap samples go before it,
        /// and in <paramref name="firstIndex"/> the clock position of the first of them (or of the
        /// package's first sample when there is no gap).</summary>
        public int Advance(int samplesPerChannel, DateTime endUtc, out double firstIndex)
        {
            int gap = 0;
            if (!Started)
            {
                Started = true;
                OriginUtc = endUtc.AddMilliseconds(-samplesPerChannel * _intervalMs);
                _delivered = 0;
            }
            else
            {
                double expected = (endUtc - OriginUtc).TotalMilliseconds / _intervalMs;
                double debt = expected - (_delivered + samplesPerChannel);
                if (debt < 0) _delivered += debt;                 // early: re-anchor
                else if (debt > _toleranceSamples)
                {
                    gap = (int)Math.Min(Math.Round(debt), _maxGapSamples);
                    _delivered += debt - gap;                     // beyond the cap is forgotten
                }
            }
            firstIndex = _delivered;
            _delivered += gap + samplesPerChannel;
            return gap;
        }

        /// <summary>Time of the sample at clock position <paramref name="index"/>, taken as the end
        /// of its slot (so a package's last sample lands on its arrival time).</summary>
        public DateTime TimeOf(double index) =>
            OriginUtc.AddTicks((long)Math.Round((index + 1) * _intervalMs * TimeSpan.TicksPerMillisecond));
    }
}
