using System;

namespace NeuuroBridge
{
    /// <summary>
    /// ITP2 #5 — detects eye blinks on Fp1/Fp2 for the live chart's "Blink" marker.
    ///
    /// A blink is a slow bump of a few hundred milliseconds that shows on BOTH frontal electrodes
    /// at once. The detector band-passes each channel to 0.5–10 Hz (drops the electrode's DC offset
    /// and drift below, muscle and mains noise above), then measures the peak-to-peak swing over
    /// the last 0.5 s, re-checked every 0.1 s, so a whole blink always falls inside one window.
    ///
    /// The threshold is relative, not a fixed µV figure. On real recordings from this headband a
    /// deliberate blink swings Fp1/Fp2 by only ~10–35 µV against a ~3 µV background, so the old
    /// fixed 100 µV threshold almost never fired; contact quality also changes the scale from one
    /// session to the next. A window counts as a blink when the swing on BOTH channels is at least
    /// <see cref="Ratio"/> times that channel's own running background (and above a small floor,
    /// so a flat, disconnected electrode can't trigger on its own noise). Requiring both channels
    /// rejects a single electrode popping or shifting, which used to read as a blink.
    ///
    /// Not thread-safe; feed it from the single raw-frame thread.
    /// </summary>
    public sealed class BlinkDetector
    {
        private const double HighPassHz = 0.5;
        private const double LowPassHz = 10.0;
        private const double WindowSeconds = 0.5;
        private const double StepSeconds = 0.1;
        private const double Ratio = 3.0;              // swing must be this many times the background
        private const double FloorUv = 6.0;            // ...and at least this big, in µV
        private const double BaselineAlpha = 0.03;     // per 0.1 s step: ~3 s time constant
        private const int WarmupSteps = 30;            // 3 s of background before detecting
        private const double RefractorySeconds = 0.6;  // one blink, one marker (> window length)
        private const double MinSeparationSeconds = 0.8; // a blink's tail can re-trigger just after the
                                                         // refractory period; ignore peaks this close
        private const double GapResetSeconds = 0.25;   // longer silence than this = start over

        private readonly int _sampleRate;
        private readonly int _window;
        private readonly int _step;
        private readonly int _refractory;

        private HighPassFilter[] _hp;
        private LowPassFilter[] _lp;
        private readonly double[][] _ring;   // last _window band-passed samples per channel
        private int _head;                   // next write position in _ring
        private int _filled;                 // valid samples in _ring (<= _window)
        private int _sinceStep;
        private int _refractoryLeft;
        private readonly double[] _baseline = new double[2];
        private int _baselineSteps;
        private DateTime _lastFrameEndUtc = DateTime.MinValue;
        private DateTime _lastPeakUtc = DateTime.MinValue;

        public BlinkDetector(int sampleRateHz)
        {
            _sampleRate = sampleRateHz;
            _window = (int)Math.Round(WindowSeconds * sampleRateHz);
            _step = Math.Max(1, (int)Math.Round(StepSeconds * sampleRateHz));
            _refractory = (int)Math.Round(RefractorySeconds * sampleRateHz);
            _ring = new[] { new double[_window], new double[_window] };
            ResetSignal();
        }

        /// <summary>Restart the filters and window (after a gap). The background level is kept:
        /// it describes this headband on this head, which a dropout doesn't change.</summary>
        public void ResetSignal()
        {
            _hp = new[] { new HighPassFilter(HighPassHz, _sampleRate), new HighPassFilter(HighPassHz, _sampleRate) };
            _lp = new[] { new LowPassFilter(LowPassHz, _sampleRate, order: 2), new LowPassFilter(LowPassHz, _sampleRate, order: 2) };
            _head = 0;
            _filled = 0;
            _sinceStep = 0;
            _refractoryLeft = 0;
        }

        /// <summary>Feeds one frame. <paramref name="samples"/> is the bridge's block layout
        /// ([ch0][ch1][ch2][ch3], µV) with Fp1 = channel 0 and Fp2 = channel 1;
        /// <paramref name="frameEndUtc"/> is the time of the frame's last sample. Returns the time
        /// of the blink's peak if this frame completed a blink, otherwise null.</summary>
        public DateTime? Process(float[] samples, int channelCount, DateTime frameEndUtc)
        {
            int spc = samples.Length / channelCount;
            if (spc == 0) return null;

            // A dropout leaves a jump in the signal that the filters would ring on: start over.
            if (_lastFrameEndUtc != DateTime.MinValue)
            {
                double expected = (double)spc / _sampleRate;
                double elapsed = (frameEndUtc - _lastFrameEndUtc).TotalSeconds;
                if (elapsed > expected + GapResetSeconds) ResetSignal();
            }
            _lastFrameEndUtc = frameEndUtc;

            DateTime? found = null;
            for (int i = 0; i < spc; i++)
            {
                for (int ch = 0; ch < 2; ch++)
                {
                    double y = _hp[ch].Process(samples[ch * spc + i]);
                    _ring[ch][_head] = _lp[ch].Process((float)y);
                }
                _head = (_head + 1) % _window;
                if (_filled < _window) _filled++;
                if (_refractoryLeft > 0) _refractoryLeft--;

                if (++_sinceStep < _step || _filled < _window) continue;
                _sinceStep = 0;

                double swing0 = Swing(0, out int peakAge0);
                double swing1 = Swing(1, out _);

                bool warm = _baselineSteps >= WarmupSteps;
                bool blink = warm && _refractoryLeft == 0
                    && swing0 >= FloorUv && swing1 >= FloorUv
                    && swing0 >= Ratio * _baseline[0] && swing1 >= Ratio * _baseline[1];

                if (blink)
                {
                    _refractoryLeft = _refractory;
                    // Mark the peak itself, not the moment the window first crossed the threshold.
                    int samplesAfterThis = spc - 1 - i;
                    DateTime peak = frameEndUtc.AddSeconds(-(double)(samplesAfterThis + peakAge0) / _sampleRate);
                    if ((peak - _lastPeakUtc).TotalSeconds >= MinSeparationSeconds) found = peak;
                    _lastPeakUtc = peak;
                }
                else if (_refractoryLeft == 0)
                {
                    // Learn the background only from windows that aren't a blink, so blinking a lot
                    // doesn't slowly raise the bar.
                    if (_baselineSteps == 0) { _baseline[0] = swing0; _baseline[1] = swing1; }
                    else
                    {
                        _baseline[0] += BaselineAlpha * (swing0 - _baseline[0]);
                        _baseline[1] += BaselineAlpha * (swing1 - _baseline[1]);
                    }
                    _baselineSteps++;
                }
            }
            return found;
        }

        /// <summary>Peak-to-peak over the current window for one channel, plus how many samples ago
        /// (from the newest) its largest absolute value was.</summary>
        private double Swing(int ch, out int peakAge)
        {
            double min = double.MaxValue, max = double.MinValue, peakAbs = -1;
            peakAge = 0;
            var r = _ring[ch];
            for (int age = 0; age < _window; age++)
            {
                double v = r[(_head - 1 - age + _window) % _window];
                if (v < min) min = v;
                if (v > max) max = v;
                double a = Math.Abs(v);
                if (a > peakAbs) { peakAbs = a; peakAge = age; }
            }
            return max - min;
        }
    }
}
