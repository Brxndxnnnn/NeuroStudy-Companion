using System;
using System.Collections.Generic;

namespace NeuuroBridge
{
    public enum ArtifactKind { Blink, Clench }

    /// <summary>
    /// ITP2 #5 — detects eye blinks and teeth clenches for the live chart's markers, from the SDK's
    /// 200 ms live packages (µV; see <see cref="SenzeBandService.OnLivePackage"/>), so a marker
    /// follows its event by well under a second.
    ///
    /// Tuned on a scripted capture on 19 Nov 2026 (10 deliberate blinks, 3 two-second clenches,
    /// still periods between) and checked against what the band shows in Neeuro's own MindViewer.
    /// One person, one session — expect to re-tune.
    ///
    /// BLINK. The band's reference is the middle forehead electrode, which sees a blink almost as
    /// strongly as the eyes do. Fp1/Fp2 sit next to it, so a blink largely cancels there; T3/T4 are
    /// far from it, so the reference's blink shows on them in full. A blink is therefore a positive
    /// bump of +150..+650 µV on T3 AND T4 together (0.5-10 Hz), 0.3-0.5 s wide, usually followed by a
    /// dip. Flagged when both channels exceed <see cref="BlinkRatio"/> x their own quiet background,
    /// kept between <see cref="BlinkMinUv"/> and <see cref="BlinkMaxThresholdUv"/>; the marker goes
    /// on the peak. The background is learnt only
    /// from quiet samples, and not for 1 s after a blink, whose dip would otherwise raise the bar.
    ///
    /// CLENCH. Jaw muscle activity: a sustained rise of 65-95 Hz power (clear of 50 Hz mains and its
    /// 100 Hz harmonic) to <see cref="EmgRatio"/> x its quiet level on at least two channels. It
    /// must hold for most of <see cref="EmgWindowSeconds"/>: a blink brings a short burst of the
    /// same activity, which this rejects. Blinks are not flagged while a clench is in progress (a
    /// clench also moves the slow signal). The marker goes on the onset.
    ///
    /// DROPOUTS. BLE loss leaves gaps of a fraction of a second every second or two. A gap up to
    /// <see cref="MaxBridgedGapSeconds"/> is bridged with a straight line (as the chart draws it) so
    /// the filters run on without restarting; nothing is detected inside it. Restarting the filters
    /// instead meant a 1 s settle after every gap, and with gaps that frequent the detector was
    /// almost never running (19 Nov live test: about 1 blink in 15 marked).
    ///
    /// Not thread-safe; feed it from the single data thread.
    /// </summary>
    public sealed class ArtifactDetector
    {
        private const int Channels = 4;            // frame order Fp1, Fp2, T4, T3
        private const int T4 = 2, T3 = 3;

        // scipy.signal.butter(2, [0.5, 10], btype='band', fs=250, output='sos')
        private static readonly double[][] BlinkSos =
        {
            new[] { 0.012151960625946295, 0.02430392125189259, 0.012151960625946295, 1.0, -1.6766309305407543, 0.726108624256915 },
            new[] { 1.0, -2.0, 1.0, 1.0, -1.982406101508787, 0.982577908403228 },
        };
        // scipy.signal.butter(4, [65, 95], btype='band', fs=250, output='sos')
        private static readonly double[][] EmgSos =
        {
            new[] { 0.008914457239463007, -0.017828914478926015, 0.008914457239463007, 1.0, 0.4327744047898774, 0.44311899369676416 },
            new[] { 1.0, -2.0, 1.0, 1.0, 0.8920855307474387, 0.5081266925820753 },
            new[] { 1.0, 2.0, 1.0, 1.0, 0.15389410615359797, 0.7290541763978443 },
            new[] { 1.0, 2.0, 1.0, 1.0, 1.2910314239016434, 0.802176617213938 },
        };

        private const double BlinkMinUv = 100.0;
        private const double BlinkMaxThresholdUv = 150.0;
        private const double BlinkRatio = 4.0;
        private const double BlinkRefractorySeconds = 0.6;
        private const double EmgRmsSeconds = 0.25;
        private const double EmgRatio = 2.5;
        private const int EmgMinChannels = 2;
        private const double EmgWindowSeconds = 0.8;
        private const double EmgHotFraction = 0.6;    // of the window, to call it a clench
        private const double EmgBusyFraction = 0.25;  // of the window, to hold off blinks
        private const double EmgRefractorySeconds = 2.0;
        private const double BackgroundAlpha = 0.002; // per sample: ~2 s time constant
        // Once muscle activity has read as raised for longer than EmgStuckSeconds, its quiet level
        // moves toward it (~2 s time constant). A real clench is over in 1-3 s; anything that stays
        // "raised" longer means the learnt level is wrong. Without this the level could never recover: in a live test (20 Nov
        // 2026) it was learnt too low while the band was being put on, then every sample read as a
        // clench for the rest of the session and blinks were held off 100% of the time.
        private const double EmgBusyAlpha = 0.002;
        private const double EmgStuckSeconds = 3.0;
        // A swing this big in the blink band is the band moving or an electrode losing contact
        // (live: up to 150,000 µV while fitting), not a blink (150-650 µV). Nothing is detected or
        // learnt during it and for ContactHoldSeconds after.
        private const double ContactArtefactUv = 2000.0;
        private const double ContactHoldSeconds = 1.0;
        private const double MaxBridgedGapSeconds = 2.0;
        // After a start or a long gap, before detecting: the 0.5 Hz blink filter needs about a second
        // to settle; the 65-95 Hz filter and its 0.25 s RMS only a fraction of that.
        private const double BlinkSettleSeconds = 1.0;
        private const int EmgFilterSettleSamples = 15;   // 60 ms, after a start or any gap

        private readonly int _fs;
        private readonly double _stepMs;
        private readonly int _rmsLen, _hotLen, _blinkRefractory, _emgRefractory, _blinkSettle, _maxBridged;

        private SosFilter[] _blink, _emg;
        private readonly double[] _base = new double[Channels];
        private readonly double[] _last = new double[Channels];   // last real sample, base removed
        private bool _haveBase;
        private int _warm;
        private readonly double[][] _sq;
        private readonly double[] _sqSum = new double[Channels];
        private readonly bool[] _sqValid;
        private readonly double[] _emgBase = new double[Channels];
        private bool _emgNeedBase;
        private int _sqPos, _sqCount, _emgSkip;
        private readonly bool[] _hot;
        private int _hotPos, _hotCount;
        private readonly double[] _x = new double[Channels], _yb = new double[Channels], _rms = new double[Channels];

        // Learnt levels, kept across gaps: they describe this band on this head.
        private readonly double[] _bg = new double[Channels];
        private bool _bgInit;
        private readonly double[] _emgBg = new double[Channels];
        private bool _emgBgInit;

        private int _blinkRefr, _emgRefr, _quietHold, _contactHold, _hotRun;

        // Diagnostics since the last TakeStats (logged every few seconds by BridgeController).
        private int _stReal, _stGap, _stSettling, _stBusy, _stBlinks, _stClenches, _stResets, _stContact;
        private double _stMax4 = double.NegativeInfinity, _stMax3 = double.NegativeInfinity, _stThr4, _stThr3;
        private bool _hasBest, _hotNow;
        private double _bestScore;
        private DateTime _bestUtc;

        public ArtifactDetector(int sampleRateHz)
        {
            _fs = sampleRateHz;
            _stepMs = 1000.0 / sampleRateHz;
            _rmsLen = (int)(EmgRmsSeconds * sampleRateHz);
            _hotLen = (int)(EmgWindowSeconds * sampleRateHz);
            _blinkRefractory = (int)(BlinkRefractorySeconds * sampleRateHz);
            _emgRefractory = (int)(EmgRefractorySeconds * sampleRateHz);
            _blinkSettle = (int)(BlinkSettleSeconds * sampleRateHz);
            _maxBridged = (int)(MaxBridgedGapSeconds * sampleRateHz);
            _sq = new double[Channels][];
            for (int ch = 0; ch < Channels; ch++) _sq[ch] = new double[_rmsLen];
            _sqValid = new bool[_rmsLen];
            _hot = new bool[_hotLen];
            ResetSignal();
        }

        /// <summary>Starts over after a pause in the feed (impedance check, reconnect). Learnt
        /// background levels are kept.</summary>
        public void Reset()
        {
            ResetSignal();
            Array.Clear(_hot, 0, _hotLen);
            _hotCount = 0;
        }

        private void ResetSignal()
        {
            _stResets++;
            _blink = new SosFilter[Channels];
            for (int ch = 0; ch < Channels; ch++) _blink[ch] = new SosFilter(BlinkSos);
            ResetEmg();
            // The clench window (_hot) is kept across a long gap: a dropout in the middle of a
            // clench must not restart its 0.8 s count.
            _haveBase = false;
            _warm = 0;
            _hasBest = false;
        }

        /// <summary>Restarts the 65-95 Hz filters and empties the RMS window. Done at every gap: the
        /// join between the bridging line and the real signal is a kink, which rings in this band
        /// like a burst of muscle activity (with frequent dropouts it flagged a clench every few
        /// seconds). This filter settles in a few tens of ms, so it is cheap to restart.</summary>
        private void ResetEmg()
        {
            _emg = new SosFilter[Channels];
            for (int ch = 0; ch < Channels; ch++)
            {
                _emg[ch] = new SosFilter(EmgSos);
                Array.Clear(_sq[ch], 0, _rmsLen);
                _sqSum[ch] = 0;
            }
            Array.Clear(_sqValid, 0, _rmsLen);
            _sqPos = 0;
            _sqCount = 0;
            _emgSkip = EmgFilterSettleSamples;
            _hotNow = false;
            // Restarted from rest, the filter must see a signal near 0, not the electrode's
            // drifted offset (often thousands of µV), or it rings on that step.
            _emgNeedBase = true;
        }

        /// <summary>Feeds one live package (µV, block layout 4 x N) that follows
        /// <paramref name="gapSamples"/> lost samples and whose first sample is at
        /// <paramref name="firstSampleUtc"/> on the shared sample clock (see
        /// <see cref="LiveEegPackage"/>); appends any events it completes to <paramref name="found"/>.</summary>
        public void Process(float[] samplesUv, int gapSamples, DateTime firstSampleUtc,
                            List<(ArtifactKind Kind, DateTime AtUtc)> found)
        {
            if (samplesUv == null || samplesUv.Length < Channels) return;
            int spc = samplesUv.Length / Channels;
            for (int k = 0; k < Channels * spc; k++)
                if (float.IsNaN(samplesUv[k]) || float.IsInfinity(samplesUv[k])) return;   // never let a bad value into the filters

            if (!_haveBase || gapSamples > _maxBridged)
            {
                // Start, or a gap too long to bridge: restart the filters. Take the electrode offset
                // (tens of thousands of µV) out first, so they don't start with a huge step.
                ResetSignal();
                for (int ch = 0; ch < Channels; ch++) { _base[ch] = samplesUv[ch * spc]; _last[ch] = 0; }
                _haveBase = true;
                gapSamples = 0;
            }

            // A short dropout: a straight line from the last sample to this package's first.
            if (gapSamples > 0) ResetEmg();
            for (int g = 0; g < gapSamples; g++)
            {
                double f = (g + 1.0) / (gapSamples + 1);
                for (int ch = 0; ch < Channels; ch++)
                    _x[ch] = _last[ch] + f * (samplesUv[ch * spc] - _base[ch] - _last[ch]);
                Step(firstSampleUtc.AddMilliseconds((g - gapSamples) * _stepMs), real: false, found);
            }
            for (int i = 0; i < spc; i++)
            {
                for (int ch = 0; ch < Channels; ch++) _x[ch] = samplesUv[ch * spc + i] - _base[ch];
                Step(firstSampleUtc.AddMilliseconds(i * _stepMs), real: true, found);
            }
            Array.Copy(_x, _last, Channels);
        }

        private void Step(DateTime at, bool real, List<(ArtifactKind, DateTime)> found)
        {
            // Muscle power only from real samples once the 65-95 Hz filter has settled; the RMS is
            // over however many of those the 0.25 s window holds.
            if (real && _emgNeedBase) { Array.Copy(_x, _emgBase, Channels); _emgNeedBase = false; }
            bool emgSample = real && _emgSkip == 0;
            if (real && _emgSkip > 0) _emgSkip--;
            if (_sqValid[_sqPos]) _sqCount--;
            _sqValid[_sqPos] = emgSample;
            if (emgSample) _sqCount++;
            for (int ch = 0; ch < Channels; ch++)
            {
                _yb[ch] = _blink[ch].Process(_x[ch]);
                double e = real ? _emg[ch].Process(_x[ch] - _emgBase[ch]) : 0;
                double sq = emgSample ? e * e : 0;
                _sqSum[ch] += sq - _sq[ch][_sqPos];
                _sq[ch][_sqPos] = sq;
                _rms[ch] = _sqCount > 0 ? Math.Sqrt(Math.Max(0, _sqSum[ch]) / _sqCount) : 0;
            }
            _sqPos = (_sqPos + 1) % _rmsLen;
            _warm++;
            if (real) _stReal++; else _stGap++;
            if (real && _warm < _blinkSettle) _stSettling++;

            // Fitting / contact junk: stop everything (and drop a blink in progress) until it's over.
            for (int ch = 0; ch < Channels; ch++)
                if (Math.Abs(_yb[ch]) > ContactArtefactUv) { _contactHold = (int)(ContactHoldSeconds * _fs); _hasBest = false; }
            if (_contactHold > 0)
            {
                _contactHold--;
                if (real) _stContact++;
                return;
            }

            if (_warm >= _blinkSettle) DetectBlink(at, real, found);
            // Clench needs a third of a window of clean muscle samples to judge.
            if (emgSample && _sqCount >= _rmsLen / 3) DetectClench(at, found);
        }

        /// <summary>One line on what the detector saw since the last call, then starts a new count:
        /// share of samples lost, how much it was still settling, the largest blink-band swing on
        /// T4/T3 against the threshold it needed to beat, and how often muscle activity held blinks
        /// off. Enough to tell from a log why a blink was or wasn't marked.</summary>
        public string TakeStats()
        {
            int all = _stReal + _stGap;
            string Pct(int n, int of) => of > 0 ? $"{100.0 * n / of:0}%" : "-";
            string Uv(double v) => double.IsNegativeInfinity(v) ? "-" : $"{v:0}";
            string s = $"lost {Pct(_stGap, all)}, settling {Pct(_stSettling, _stReal)}, restarts {_stResets}, contact junk {Pct(_stContact, _stReal)}; " +
                       $"peak T4 {Uv(_stMax4)}/{_stThr4:0} µV, T3 {Uv(_stMax3)}/{_stThr3:0} µV (peak/needed); " +
                       $"muscle hold-off {Pct(_stBusy, _stReal)}; marked {_stBlinks} blink(s), {_stClenches} clench(es).";
            _stReal = _stGap = _stSettling = _stBusy = _stBlinks = _stClenches = _stResets = _stContact = 0;
            _stMax4 = _stMax3 = double.NegativeInfinity;
            return s;
        }

        private void DetectBlink(DateTime at, bool real, List<(ArtifactKind, DateTime)> found)
        {
            double t4 = _yb[T4], t3 = _yb[T3];
            if (!_bgInit)
            {
                _bg[T4] = Math.Abs(t4);
                _bg[T3] = Math.Abs(t3);
                _bgInit = true;
            }
            // The background only raises the bar so far: in a live test it learnt enough from blink
            // tails and dropout joins to put the bar at 200-400 µV, above ordinary blinks (150-200).
            double thr4 = Math.Min(BlinkMaxThresholdUv, Math.Max(BlinkMinUv, BlinkRatio * _bg[T4]));
            double thr3 = Math.Min(BlinkMaxThresholdUv, Math.Max(BlinkMinUv, BlinkRatio * _bg[T3]));
            bool emgBusy = _hotCount > EmgBusyFraction * _hotLen;
            // Inside a bridged gap nothing new is started; a blink already under way ends there.
            bool above = real && t4 > thr4 && t3 > thr3 && !emgBusy;
            if (real)
            {
                if (t4 > _stMax4) _stMax4 = t4;
                if (t3 > _stMax3) _stMax3 = t3;
                _stThr4 = thr4; _stThr3 = thr3;
                if (emgBusy) _stBusy++;
            }

            if (_blinkRefr > 0) _blinkRefr--;
            if (above && _blinkRefr == 0)
            {
                double score = t4 + t3;
                if (!_hasBest || score > _bestScore) { _hasBest = true; _bestScore = score; _bestUtc = at; }
            }
            else if (_hasBest && !above)
            {
                // Dropped if muscle activity has started by the time the bump is over: a clench
                // shifts T3/T4 the same way, and its window may not have filled at the peak yet.
                if (!(emgBusy || _hotNow))
                {
                    found.Add((ArtifactKind.Blink, _bestUtc));
                    _stBlinks++;
                }
                _hasBest = false;
                _blinkRefr = _blinkRefractory;
                _quietHold = _fs;
            }

            if (real && _blinkRefr == 0 && !_hasBest && _quietHold == 0)
            {
                foreach (int ch in new[] { T4, T3 })
                {
                    double a = Math.Abs(_yb[ch]);
                    if (a < 3 * _bg[ch] + 20) _bg[ch] += BackgroundAlpha * (a - _bg[ch]);
                }
            }
            if (_quietHold > 0) _quietHold--;
        }

        private void DetectClench(DateTime at, List<(ArtifactKind, DateTime)> found)
        {
            if (!_emgBgInit)
            {
                Array.Copy(_rms, _emgBg, Channels);
                _emgBgInit = true;
            }
            int hot = 0;
            for (int ch = 0; ch < Channels; ch++)
                if (_rms[ch] > EmgRatio * _emgBg[ch]) hot++;

            if (_emgRefr > 0) _emgRefr--;
            bool isHot = hot >= EmgMinChannels;
            _hotNow = isHot;
            if (_hot[_hotPos]) _hotCount--;
            _hot[_hotPos] = isHot;
            if (isHot) _hotCount++;
            _hotPos = (_hotPos + 1) % _hotLen;

            double fraction = (double)_hotCount / _hotLen;
            if (fraction >= EmgHotFraction && _emgRefr == 0)
            {
                found.Add((ArtifactKind.Clench, at.AddMilliseconds(-_hotLen * _stepMs)));
                _stClenches++;
                _emgRefr = _emgRefractory;
            }
            _hotRun = fraction >= EmgBusyFraction ? _hotRun + 1 : 0;
            double alpha = fraction < 0.2 && hot == 0 ? BackgroundAlpha
                         : _hotRun > EmgStuckSeconds * _fs ? EmgBusyAlpha
                         : 0;
            for (int ch = 0; ch < Channels; ch++)
                _emgBg[ch] += alpha * (_rms[ch] - _emgBg[ch]);
        }
    }
}
