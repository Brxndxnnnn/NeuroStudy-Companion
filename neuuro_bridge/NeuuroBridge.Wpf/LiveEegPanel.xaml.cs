using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using ScottPlot;
using ScottPlot.Plottable;
using Drawing = System.Drawing;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Live EEG visuals rendered with ScottPlot — three tabs of scrolling strip charts:
    ///   • EEG Waves       — 4 raw channels, auto-scaled per lane to strip the DC offset.
    ///   • Frequency Bands — δ θ α β γ band power over time (Avg or a single channel), current
    ///                       value shown live in the legend.
    ///   • Mental States   — Attention / Relaxation / Workload (0–100) over time.
    ///
    /// Two independent layers of history per tab:
    ///   1. A full-session ring buffer (big; minutes of data) — always appended to, regardless of
    ///      which tab is visible or whether the technician has scrubbed back. Source of truth.
    ///   2. A small "committed + staging" display buffer that ScottPlot actually renders — see the
    ///      smooth-scroll design note above <see cref="Track"/>.
    /// Fed from BridgeController.RawFrame / FftBandPowers / cognitive; redrawn off the composition
    /// clock, throttled to ~30 fps, and only the currently visible tab is refreshed/redrawn.
    /// </summary>
    public partial class LiveEegPanel : UserControl
    {
        private const int Channels = 4;
        private const int RawWindow = 1000;   // ~4 s @ 250 Hz — the live-view width, unchanged from before
        private const int EegSlack = 256;     // staging headroom for one PushRaw batch (glide source)
        private const int RawFullCapacity = 450_000; // ~30 min @ 250 Hz of full-session history

        private const int Bands = 5;
        private const int BandSources = 5;    // [0] = avg of channels, [1..4] = Fp1, Fp2, T4, T3
        private const int BandSlack = 6;
        private const int BandFullCapacity = 3600;    // ~1 h @ ~1 Hz

        private const int Cogs = 3;
        private const int Hist = 200;         // live-view width for bands/cognitive, unchanged from before
        private const int CogSlack = 6;
        private const int CogFullCapacity = 3600;     // ~1 h at the ~2 Hz refresh cadence

        private const double LaneGap = 2.0;   // vertical spacing between normalised lanes
        private const double LaneAmp = 1.6;   // normalised peak-to-peak amplitude within a lane
        private const double BaselineAlpha = 0.06; // EMA blend rate for the auto-gain baseline (slow, so it never reads as a jump)

        private static readonly string[] ChNames   = { "Ch1 Fp1", "Ch2 Fp2", "Ch3 T4", "Ch4 T3" };
        private static readonly string[] BandNames  = { "Delta", "Theta", "Alpha", "Beta", "Gamma" };
        private static readonly string[] CogNames   = { "Attention", "Relaxation", "Workload" };
        private static readonly string[] SourceLabels = { "Avg", "Ch1", "Ch2", "Ch3", "Ch4" };

        private static readonly Drawing.Color[] Palette =
        {
            Drawing.Color.FromArgb(0x3B, 0x82, 0xF6),   // blue
            Drawing.Color.FromArgb(0x22, 0xC5, 0x5E),   // green
            Drawing.Color.FromArgb(0xF5, 0x9E, 0x0B),   // amber
            Drawing.Color.FromArgb(0xE6, 0x7E, 0x22),   // orange
            Drawing.Color.FromArgb(0xA7, 0x8B, 0xFA),   // violet
        };

        private static readonly Brush LabelBrush  = Br("#92A2B8");
        private static readonly Brush ChipBrush    = Br("#1E2A3C");   // unselected channel chip
        private static readonly Brush AccentBrush  = Br("#3B82F6");   // selected channel chip

        // ── Full-session ring buffers (source of truth; always growing until wrap) ────────────
        private readonly double[][] _rawFull = new double[Channels][];
        private int _rawFullHead, _rawFullCount;
        private readonly object _lock = new object();

        // _bandFull[source][band]; source 0 = 4-channel average, 1..4 = Fp1/Fp2/T4/T3.
        private readonly double[][][] _bandFull = new double[BandSources][][];
        private readonly double[][] _bandLatest = new double[BandSources][];
        private int _bandFullHead, _bandFullCount;
        private int _selectedSource;          // 0 = Avg
        private Button[] _srcButtons;

        private readonly double[][] _cogFull = new double[Cogs][];
        private int _cogFullHead, _cogFullCount;
        private readonly double[] _cogLatest = { double.NaN, double.NaN, double.NaN };

        // ── Smooth-scroll state, one per tab ───────────────────────────────────────────────────
        // Display buffer layout (length Capacity + Slack, right-aligned):
        //   [0 .. Capacity-1]            committed, on-screen at rest — NEVER mutated once written.
        //   [Capacity .. Capacity+K-1]   staging: the newest not-yet-committed batch (size K).
        // While Pending > 0 the tab's axis is panned forward by an eased fraction of Pending, which
        // glides the staged points into view without ever touching an already-committed Y value.
        // At Pending's window end the buffer is shifted left by Pending (Array.Copy) and the axis
        // resets to [0, Capacity-1] — visually seamless because the data moved by exactly that much.
        private sealed class Track
        {
            public int Pending;
            public long ArrivalTicks;
            public long LastArrivalTicks = -1;  // previous staging time, for measuring the real gap
            public double IntervalMs;      // adaptive estimate of the real inter-arrival gap
            public bool Live = true;
            public int ScrubOffset;        // samples back from the live tail (0 = live edge)
            public double DragStartX;
            public int DragStartOffset;
            public bool Dragging;
        }

        private readonly Track _eegTrack = new Track { IntervalMs = 50 };
        private readonly Track _bandTrack = new Track { IntervalMs = 1000 };
        private readonly Track _cogTrack = new Track { IntervalMs = 500 };

        // ── ScottPlot display buffers (referenced live by the SignalPlots) ─────────────────────
        private double[][] _eegPlot, _bandPlot, _cogPlot;
        private SignalPlot[] _eegSig, _bandSig, _cogSig;
        private int _frame;

        // Auto-gain baseline (mean/range) per lane, EMA-updated on each commit — never recomputed
        // over the whole window, so a committed point's Y value is set once and held forever.
        private readonly double[] _eegBaseMean = new double[Channels];
        private readonly double[] _eegBaseRange = new double[Channels];
        // Indexed [source][band] so switching the band-tab source doesn't fight another source's gain.
        private readonly double[,] _bandBaseMean = new double[BandSources, Bands];
        private readonly double[,] _bandBaseRange = new double[BandSources, Bands];

        public LiveEegPanel()
        {
            InitializeComponent();

            for (int ch = 0; ch < Channels; ch++) _rawFull[ch] = new double[RawFullCapacity];
            for (int s = 0; s < BandSources; s++)
            {
                _bandFull[s] = new double[Bands][];
                _bandLatest[s] = new double[Bands];
                for (int b = 0; b < Bands; b++) _bandFull[s][b] = new double[BandFullCapacity];
            }
            for (int c = 0; c < Cogs; c++) _cogFull[c] = new double[CogFullCapacity];

            SetupPlots();
            BuildChannelSelector();
            HookScrub(EegPlot, _eegTrack, RawWindow, () => RebuildEegWindow());
            HookScrub(BandPlot, _bandTrack, Hist, () => RebuildBandWindow());
            HookScrub(CogPlot, _cogTrack, Hist, () => RebuildCogWindow());
            BtnEegLive.Click += (_, __) => JumpToLive(_eegTrack, RebuildEegWindow, BtnEegLive);
            BtnBandLive.Click += (_, __) => JumpToLive(_bandTrack, RebuildBandWindow, BtnBandLive);
            BtnCogLive.Click += (_, __) => JumpToLive(_cogTrack, RebuildCogWindow, BtnCogLive);

            // Drive redraws off the composition clock (vsync) but only refresh the visible tab.
            Loaded   += (_, __) => CompositionTarget.Rendering += OnRendering;
            Unloaded += (_, __) => CompositionTarget.Rendering -= OnRendering;
        }

        public void SetVitals(int? heartRate, int? spo2)
        {
            TxtHeartRate.Text = heartRate == null ? "—" : heartRate.Value + " bpm";
            TxtSpo2.Text = spo2 == null ? "—" : spo2.Value + " %";
        }

        private void Tabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            // Give the newly-shown tab an immediate redraw instead of waiting for the next tick.
            if (EegPlot.IsVisible) EegPlot.Refresh();
            else if (BandPlot.IsVisible) BandPlot.Refresh();
            else if (CogPlot.IsVisible) CogPlot.Refresh();
        }

        private void OnRendering(object sender, EventArgs e)
        {
            if (++_frame % 2 != 0) return;          // ~30 fps is plenty for a strip chart
            if (EegPlot.IsVisible)       AdvanceAndDraw(EegPlot, _eegTrack, RawWindow, EegSlack, _eegSig, _eegPlot);
            else if (BandPlot.IsVisible) AdvanceAndDraw(BandPlot, _bandTrack, Hist, BandSlack, _bandSig, _bandPlot);
            else if (CogPlot.IsVisible)  AdvanceAndDraw(CogPlot, _cogTrack, Hist, CogSlack, _cogSig, _cogPlot);
        }

        // ── Plot setup ───────────────────────────────────────────────────────
        private void SetupPlots()
        {
            _eegPlot  = Alloc(Channels, RawWindow + EegSlack);
            _bandPlot = Alloc(Bands, Hist + BandSlack);
            _cogPlot  = Alloc(Cogs, Hist + CogSlack);

            _eegSig  = AddStackedLanes(EegPlot, _eegPlot, ChNames, RawWindow);
            _bandSig = AddStackedLanes(BandPlot, _bandPlot, BandNames, Hist);
            _cogSig  = AddSharedAxis(CogPlot, _cogPlot, CogNames, Hist, yMin: 0, yMax: 100);

            ZeroLanes(_eegPlot, Channels);
            ZeroLanes(_bandPlot, Bands);
        }

        private static double[][] Alloc(int n, int len)
        {
            var a = new double[n][];
            for (int i = 0; i < n; i++) a[i] = new double[len];
            return a;
        }

        /// <summary>Stacked, per-lane auto-scaled strips (DC stripped). Used for EEG + bands. The
        /// backing arrays are longer than <paramref name="capacity"/> (staging headroom), but the
        /// axis only ever rests on <c>[0, capacity-1]</c> — the glide pans past that temporarily.</summary>
        private static SignalPlot[] AddStackedLanes(WpfPlot ctrl, double[][] buf, string[] names, int capacity)
        {
            var plt = ctrl.Plot;
            StyleDark(plt);
            LockView(ctrl);
            int n = names.Length;
            var sigs = new SignalPlot[n];
            for (int i = 0; i < n; i++)
            {
                var s = plt.AddSignal(buf[i]);
                s.Color = Palette[i % Palette.Length];
                s.LineWidth = 1;
                s.Label = names[i];
                sigs[i] = s;
            }
            plt.SetAxisLimits(0, capacity - 1, -1.5, (n - 1) * LaneGap + 1.5);
            plt.YAxis.Ticks(false);     // lane offsets are arbitrary
            plt.XAxis.Ticks(false);     // x is just sample index
            plt.Legend(true, Alignment.UpperRight);
            ctrl.Refresh();
            return sigs;
        }

        /// <summary>Real-valued lines on a shared, fixed Y axis. Used for the 0–100 cognitive metrics.</summary>
        private static SignalPlot[] AddSharedAxis(WpfPlot ctrl, double[][] buf, string[] names, int capacity, double yMin, double yMax)
        {
            var plt = ctrl.Plot;
            StyleDark(plt);
            LockView(ctrl);
            int n = names.Length;
            var sigs = new SignalPlot[n];
            for (int i = 0; i < n; i++)
            {
                var s = plt.AddSignal(buf[i]);
                s.Color = Palette[i % Palette.Length];
                s.LineWidth = 1.5f;
                s.Label = names[i];
                sigs[i] = s;
            }
            plt.SetAxisLimits(0, capacity - 1, yMin, yMax);
            plt.XAxis.Ticks(false);
            plt.Legend(true, Alignment.UpperRight);
            ctrl.Refresh();
            return sigs;
        }

        /// <summary>ScottPlot's own mouse pan/zoom stays off — scrubbing is handled explicitly (see
        /// <see cref="HookScrub"/>) so it can reach back into full-session history, not just the
        /// small window ScottPlot has loaded.</summary>
        private static void LockView(WpfPlot ctrl)
        {
            ctrl.Configuration.Pan = false;
            ctrl.Configuration.Zoom = false;
            ctrl.Configuration.ScrollWheelZoom = false;
            ctrl.Configuration.DoubleClickBenchmark = false;
        }

        private static void StyleDark(Plot plt)
        {
            plt.Style(
                figureBackground: Drawing.Color.FromArgb(0x0B, 0x12, 0x1C),
                dataBackground:   Drawing.Color.FromArgb(0x0B, 0x12, 0x1C),
                grid:             Drawing.Color.FromArgb(0x22, 0x30, 0x3F),
                tick:             Drawing.Color.FromArgb(0x6B, 0x7A, 0x90),
                axisLabel:        Drawing.Color.FromArgb(0x92, 0xA2, 0xB8),
                titleLabel:       Drawing.Color.FromArgb(0xE6, 0xED, 0xF6));
            plt.Margins(0, 0);
        }

        // ── Channel selector (Avg · Ch1 · Ch2 · Ch3 · Ch4) for the bands tab ──
        private void BuildChannelSelector()
        {
            _srcButtons = new Button[BandSources];
            for (int i = 0; i < BandSources; i++)
            {
                int idx = i;
                var btn = new Button
                {
                    Content = SourceLabels[i],
                    FontSize = 11,
                    Padding = new Thickness(10, 3, 10, 3),
                    Margin = new Thickness(0, 0, 6, 0)
                };
                btn.Click += (_, __) =>
                {
                    _selectedSource = idx;
                    UpdateSelectorVisuals();
                    // Switching source is a discontinuous jump — no glide, just a fresh reslice.
                    if (_bandTrack.Live) RebuildBandWindow();
                };
                _srcButtons[i] = btn;
                BandChannelBar.Children.Add(btn);
            }
            UpdateSelectorVisuals();
        }

        private void UpdateSelectorVisuals()
        {
            for (int i = 0; i < BandSources; i++)
            {
                bool sel = i == _selectedSource;
                _srcButtons[i].Background = sel ? AccentBrush : ChipBrush;
                _srcButtons[i].Foreground = sel ? Brushes.White : LabelBrush;
                _srcButtons[i].FontWeight = sel ? FontWeights.SemiBold : FontWeights.Normal;
            }
        }

        // ── Data in ──────────────────────────────────────────────────────────
        public void PushRaw(int[] frame)
        {
            if (frame == null || frame.Length < Channels) return;
            int spc = frame.Length / Channels;
            var batch = new double[Channels][];
            for (int ch = 0; ch < Channels; ch++) batch[ch] = new double[spc];

            lock (_lock)
            {
                for (int i = 0; i < spc; i++)
                {
                    for (int ch = 0; ch < Channels; ch++)
                    {
                        double v = frame[ch * spc + i];
                        _rawFull[ch][_rawFullHead] = v;
                        batch[ch][i] = v;
                    }
                    _rawFullHead = (_rawFullHead + 1) % RawFullCapacity;
                    if (_rawFullCount < RawFullCapacity) _rawFullCount++;
                }
            }

            if (_eegTrack.Live) StageEeg(batch, spc);
        }

        public void PushBands(BandPowers[] powers)
        {
            if (powers == null || powers.Length == 0) return;
            // powers is per channel (Fp1, Fp2, T4, T3), each with Delta/Theta/Alpha/Beta/Gamma.
            int nch = Math.Min(powers.Length, BandSources - 1);
            var avg = new double[Bands];
            for (int c = 0; c < nch; c++)
            {
                var p = powers[c];
                double[] vals = { p.Delta, p.Theta, p.Alpha, p.Beta, p.Gamma };
                for (int b = 0; b < Bands; b++)
                {
                    _bandLatest[c + 1][b] = vals[b];
                    _bandFull[c + 1][b][_bandFullHead] = vals[b];
                    avg[b] += vals[b];
                }
            }
            for (int b = 0; b < Bands; b++)
            {
                avg[b] /= Math.Max(1, nch);
                _bandLatest[0][b] = avg[b];
                _bandFull[0][b][_bandFullHead] = avg[b];
            }
            _bandFullHead = (_bandFullHead + 1) % BandFullCapacity;
            if (_bandFullCount < BandFullCapacity) _bandFullCount++;

            if (_bandTrack.Live)
            {
                var newVals = new double[Bands];
                for (int b = 0; b < Bands; b++) newVals[b] = _bandLatest[_selectedSource][b];
                StageOne(_bandTrack, _bandPlot, Hist, BandSlack, newVals, normalize: true,
                    baseMean: _bandBaseMean, baseRange: _bandBaseRange, baseRow: _selectedSource);
            }
        }

        public void SetCognitive(float attention, float relaxation, float workload)
        {
            double[] v = { attention, relaxation, workload };
            for (int c = 0; c < Cogs; c++)
            {
                double val = double.IsNaN(v[c]) ? 0 : v[c];   // keep the trace continuous
                _cogLatest[c] = v[c];
                _cogFull[c][_cogFullHead] = val;
            }
            _cogFullHead = (_cogFullHead + 1) % CogFullCapacity;
            if (_cogFullCount < CogFullCapacity) _cogFullCount++;

            if (_cogTrack.Live)
            {
                var newVals = new double[Cogs];
                for (int c = 0; c < Cogs; c++) newVals[c] = double.IsNaN(v[c]) ? 0 : v[c];
                StageOne(_cogTrack, _cogPlot, Hist, CogSlack, newVals, normalize: false, null, null, 0);
            }
        }

        public void Clear()
        {
            lock (_lock) { _rawFullHead = 0; _rawFullCount = 0; }
            _bandFullHead = _bandFullCount = _cogFullHead = _cogFullCount = 0;
            for (int s = 0; s < BandSources; s++)
                for (int b = 0; b < Bands; b++) { _bandLatest[s][b] = 0; _bandBaseMean[s, b] = 0; _bandBaseRange[s, b] = 1; }
            for (int c = 0; c < Cogs; c++) _cogLatest[c] = double.NaN;
            for (int ch = 0; ch < Channels; ch++) { _eegBaseMean[ch] = 0; _eegBaseRange[ch] = 1; }

            ResetTrack(_eegTrack); ResetTrack(_bandTrack); ResetTrack(_cogTrack);
            BtnEegLive.Visibility = BtnBandLive.Visibility = BtnCogLive.Visibility = Visibility.Collapsed;

            ZeroLanes(_eegPlot, Channels);
            ZeroLanes(_bandPlot, Bands);
            foreach (var buf in _cogPlot) Array.Clear(buf, 0, buf.Length);
            ResetAxis(EegPlot, RawWindow); ResetAxis(BandPlot, Hist); ResetAxis(CogPlot, Hist);
            EegPlot.Refresh(); BandPlot.Refresh(); CogPlot.Refresh();
        }

        private static void ResetTrack(Track t) { t.Pending = 0; t.Live = true; t.ScrubOffset = 0; t.Dragging = false; }

        private static void ZeroLanes(double[][] buf, int n)
        {
            for (int i = 0; i < n; i++)
            {
                double off = (n - 1 - i) * LaneGap;
                for (int j = 0; j < buf[i].Length; j++) buf[i][j] = off;
            }
        }

        private static void ResetAxis(WpfPlot ctrl, int capacity)
        {
            var lims = ctrl.Plot.GetAxisLimits();
            ctrl.Plot.SetAxisLimits(0, capacity - 1, lims.YMin, lims.YMax);
        }

        // ── Staging + commit (the smooth-scroll mechanism) ─────────────────────────────────────
        private void StageEeg(double[][] batch, int count)
        {
            if (count <= 0) return;
            var track = _eegTrack;
            int capacity = RawWindow, slack = EegSlack;

            // A batch bigger than the staging area can't glide as one unit — fold the oldest
            // overflow straight into history (no animation for those) and glide only the tail.
            int offset = 0;
            while (count - offset > slack)
            {
                int chunk = slack;
                if (track.Pending > 0) CommitEeg(track.Pending);      // flush whatever was mid-glide
                for (int ch = 0; ch < Channels; ch++)
                    Array.Copy(batch[ch], offset, _eegPlot[ch], capacity, chunk);
                NormalizeStagedEeg(chunk);
                CommitEeg(chunk);
                offset += chunk;
            }
            int remaining = count - offset;
            if (remaining <= 0) return;

            if (track.Pending > 0) CommitEeg(track.Pending);          // previous batch not yet shown — snap it in first
            for (int ch = 0; ch < Channels; ch++)
                Array.Copy(batch[ch], offset, _eegPlot[ch], capacity, remaining);
            NormalizeStagedEeg(remaining);

            track.Pending = remaining;
            Arrived(track);
        }

        /// <summary>Stamps the staging time and folds the real gap since the previous arrival into
        /// the glide-duration estimate, so the glide tracks the actual data rate.</summary>
        private static void Arrived(Track track)
        {
            long now = Environment.TickCount;
            if (track.LastArrivalTicks >= 0)
            {
                double gap = now - track.LastArrivalTicks;
                if (gap > 0 && gap < 5000) track.IntervalMs = track.IntervalMs * 0.8 + gap * 0.2;
            }
            track.LastArrivalTicks = now;
            track.ArrivalTicks = now;
        }

        /// <summary>Normalises the just-staged EEG samples (at buf[capacity..capacity+n-1]) against
        /// a slowly-adapting per-channel baseline, then overwrites them in place with the normalised
        /// value. Committed samples are never revisited, so this only ever touches staged data.</summary>
        private void NormalizeStagedEeg(int n)
        {
            for (int ch = 0; ch < Channels; ch++)
            {
                double mean = 0, min = double.MaxValue, max = double.MinValue;
                for (int j = 0; j < n; j++)
                {
                    double v = _eegPlot[ch][RawWindow + j];
                    mean += v; if (v < min) min = v; if (v > max) max = v;
                }
                mean /= n;
                double range = Math.Max(1e-9, max - min);
                BlendBaseline(ref _eegBaseMean[ch], ref _eegBaseRange[ch], mean, range);

                double off = (Channels - 1 - ch) * LaneGap;
                for (int j = 0; j < n; j++)
                {
                    double v = _eegPlot[ch][RawWindow + j];
                    _eegPlot[ch][RawWindow + j] = (v - _eegBaseMean[ch]) / _eegBaseRange[ch] * LaneAmp + off;
                }
            }
        }

        private void CommitEeg(int n)
        {
            for (int ch = 0; ch < Channels; ch++) ShiftLeft(_eegPlot[ch], n);
            _eegTrack.Pending = 0;
            EegPlot.Plot.SetAxisLimits(0, RawWindow - 1, EegPlot.Plot.GetAxisLimits().YMin, EegPlot.Plot.GetAxisLimits().YMax);
        }

        private void StageOne(Track track, double[][] plot, int capacity, int slack, double[] newVals,
            bool normalize, double[,] baseMean, double[,] baseRange, int baseRow)
        {
            if (track.Pending > 0) CommitGeneric(track, plot, capacity);  // previous point not yet shown — snap it in

            int lanes = plot.Length;
            for (int i = 0; i < lanes; i++) plot[i][capacity] = newVals[i];

            if (normalize)
            {
                for (int i = 0; i < lanes; i++)
                {
                    double v = newVals[i];
                    BlendBaseline2(baseMean, baseRange, baseRow, i, v);
                    double off = (lanes - 1 - i) * LaneGap;
                    plot[i][capacity] = (v - baseMean[baseRow, i]) / Math.Max(1e-9, baseRange[baseRow, i]) * LaneAmp + off;
                }
            }

            track.Pending = 1;
            Arrived(track);
        }

        private void CommitGeneric(Track track, double[][] plot, int capacity)
        {
            foreach (var lane in plot) ShiftLeft(lane, track.Pending);
            track.Pending = 0;
            var ctrl = plot == _bandPlot ? BandPlot : CogPlot;
            var lims = ctrl.Plot.GetAxisLimits();
            ctrl.Plot.SetAxisLimits(0, capacity - 1, lims.YMin, lims.YMax);
        }

        private static void ShiftLeft(double[] buf, int n)
        {
            if (n <= 0) return;
            n = Math.Min(n, buf.Length);
            Array.Copy(buf, n, buf, 0, buf.Length - n);
        }

        /// <summary>EMA blend toward a freshly-observed (mean, range) pair — slow, so a lane's gain
        /// drifts rather than jumps (see <see cref="BaselineAlpha"/>).</summary>
        private static void BlendBaseline(ref double baseMean, ref double baseRange, double obsMean, double obsRange)
        {
            if (baseRange <= 0) { baseMean = obsMean; baseRange = obsRange; return; }
            baseMean = baseMean * (1 - BaselineAlpha) + obsMean * BaselineAlpha;
            baseRange = baseRange * (1 - BaselineAlpha) + obsRange * BaselineAlpha;
        }

        private static void BlendBaseline2(double[,] baseMean, double[,] baseRange, int row, int col, double obs)
        {
            double m = baseMean[row, col], r = baseRange[row, col];
            if (r <= 0) { baseMean[row, col] = obs; baseRange[row, col] = Math.Max(1e-9, Math.Abs(obs)); return; }
            // Single-sample streams (bands/cognitive) don't have a per-batch range, so widen slowly
            // toward the observed deviation from the current mean instead.
            double dev = Math.Abs(obs - m);
            baseMean[row, col] = m * (1 - BaselineAlpha) + obs * BaselineAlpha;
            baseRange[row, col] = r * (1 - BaselineAlpha) + Math.Max(dev, r * 0.5) * BaselineAlpha;
        }

        // ── Per-frame glide advance + throttled redraw (visible tab only) ──────────────────────
        private void AdvanceAndDraw(WpfPlot ctrl, Track track, int capacity, int slack, SignalPlot[] sigs, double[][] plot)
        {
            if (track.Live && track.Pending > 0)
            {
                double elapsed = Environment.TickCount - track.ArrivalTicks;
                double t = Math.Min(1.0, Math.Max(0.0, elapsed / Math.Max(1.0, track.IntervalMs)));
                double eased = t * t * (3 - 2 * t);   // smoothstep
                double shift = eased * track.Pending;
                var lims = ctrl.Plot.GetAxisLimits();
                ctrl.Plot.SetAxisLimits(shift, capacity - 1 + shift, lims.YMin, lims.YMax);

                if (t >= 1.0)
                {
                    if (plot == _eegPlot) CommitEeg(track.Pending);
                    else CommitGeneric(track, plot, capacity);
                }
            }
            ctrl.Refresh();
            RefreshLabels();
        }

        private void RefreshLabels()
        {
            if (BandPlot.IsVisible)
                for (int b = 0; b < Bands; b++)
                    _bandSig[b].Label = _bandFullCount == 0 ? BandNames[b] : $"{BandNames[b]}  {Fmt(_bandLatest[_selectedSource][b])}";
            else if (CogPlot.IsVisible)
                for (int c = 0; c < Cogs; c++)
                    _cogSig[c].Label = double.IsNaN(_cogLatest[c]) ? CogNames[c] : $"{CogNames[c]}  {Fmt(_cogLatest[c])}";
        }

        // ── Scrubbing (drag to pan back through full-session history) ──────────────────────────
        private void HookScrub(WpfPlot ctrl, Track track, int capacity, Action rebuild)
        {
            ctrl.PreviewMouseLeftButtonDown += (s, e) =>
            {
                track.Dragging = true;
                track.DragStartX = e.GetPosition(ctrl).X;
                track.DragStartOffset = track.ScrubOffset;
                ctrl.CaptureMouse();
            };
            ctrl.PreviewMouseMove += (s, e) =>
            {
                if (!track.Dragging) return;
                double dx = e.GetPosition(ctrl).X - track.DragStartX;
                double pxPerSample = Math.Max(0.5, ctrl.ActualWidth / capacity);
                int deltaSamples = (int)Math.Round(dx / pxPerSample);
                // Dragging the content right (positive dx) should reveal OLDER data, i.e. increase offset.
                SetScrubOffset(track, track.DragStartOffset + deltaSamples, capacity, rebuild,
                    track == _eegTrack ? BtnEegLive : track == _bandTrack ? BtnBandLive : BtnCogLive, MaxOffsetFor(track));
            };
            ctrl.PreviewMouseLeftButtonUp += (s, e) => { track.Dragging = false; ctrl.ReleaseMouseCapture(); };
            ctrl.PreviewMouseWheel += (s, e) =>
            {
                int step = Math.Max(1, capacity / 20);
                var btn = track == _eegTrack ? BtnEegLive : track == _bandTrack ? BtnBandLive : BtnCogLive;
                SetScrubOffset(track, track.ScrubOffset - Math.Sign(e.Delta) * step, capacity, rebuild, btn, MaxOffsetFor(track));
                e.Handled = true;
            };
        }

        private int MaxOffsetFor(Track track)
        {
            int fullCount = track == _eegTrack ? _rawFullCount : track == _bandTrack ? _bandFullCount : _cogFullCount;
            int capacity = track == _eegTrack ? RawWindow : Hist;
            return Math.Max(0, fullCount - capacity);
        }

        private void SetScrubOffset(Track track, int offset, int capacity, Action rebuild, Button liveBtn, int maxOffset)
        {
            offset = Math.Max(0, Math.Min(maxOffset, offset));
            if (offset == track.ScrubOffset && track.Live == (offset == 0)) return;
            track.ScrubOffset = offset;
            bool wasLive = track.Live;
            track.Live = offset == 0;
            liveBtn.Visibility = track.Live ? Visibility.Collapsed : Visibility.Visible;
            if (!track.Live || !wasLive) rebuild();
        }

        private void JumpToLive(Track track, Action rebuild, Button liveBtn)
        {
            track.ScrubOffset = 0;
            track.Live = true;
            liveBtn.Visibility = Visibility.Collapsed;
            rebuild();
        }

        // ── Rebuild a display window from full history (mode changes, source switch, scrub move) ─
        private void RebuildEegWindow()
        {
            for (int ch = 0; ch < Channels; ch++)
            {
                double[] slice;
                lock (_lock) slice = SliceFromRing(_rawFull[ch], _rawFullHead, _rawFullCount, RawWindow, _eegTrack.ScrubOffset);
                double off = (Channels - 1 - ch) * LaneGap;
                SeedNormalized(slice, _eegPlot[ch], RawWindow, off, ref _eegBaseMean[ch], ref _eegBaseRange[ch]);
            }
            _eegTrack.Pending = 0;
            ResetAxis(EegPlot, RawWindow);
            EegPlot.Refresh();
        }

        private void RebuildBandWindow()
        {
            for (int b = 0; b < Bands; b++)
            {
                double[] slice = SliceFromRing(_bandFull[_selectedSource][b], _bandFullHead, _bandFullCount, Hist, _bandTrack.ScrubOffset);
                double off = (Bands - 1 - b) * LaneGap;
                double mean = 0, range = 1;
                SeedNormalized(slice, _bandPlot[b], Hist, off, ref mean, ref range);
                _bandBaseMean[_selectedSource, b] = mean;
                _bandBaseRange[_selectedSource, b] = range;
            }
            _bandTrack.Pending = 0;
            ResetAxis(BandPlot, Hist);
            BandPlot.Refresh();
        }

        private void RebuildCogWindow()
        {
            for (int c = 0; c < Cogs; c++)
            {
                double[] slice = SliceFromRing(_cogFull[c], _cogFullHead, _cogFullCount, Hist, _cogTrack.ScrubOffset);
                RightAlign(_cogPlot[c], slice, Hist);
            }
            _cogTrack.Pending = 0;
            ResetAxis(CogPlot, Hist);
            CogPlot.Refresh();
        }

        /// <summary>Right-aligns <paramref name="slice"/> into the committed region of
        /// <paramref name="dst"/> (length capacity+slack, only [0..capacity-1] written), padding any
        /// shortfall on the left with the lane's flat offset, and seeds a fresh (mean, range)
        /// baseline from the slice itself (a hard reset — this is a discontinuous jump anyway).</summary>
        private static void SeedNormalized(double[] slice, double[] dst, int capacity, double laneOffset, ref double baseMean, ref double baseRange)
        {
            int n = slice.Length, pad = Math.Max(0, capacity - n);
            double mean = 0, min = double.MaxValue, max = double.MinValue;
            for (int j = 0; j < n; j++) { double v = slice[j]; mean += v; if (v < min) min = v; if (v > max) max = v; }
            if (n > 0) mean /= n;
            double range = Math.Max(1e-9, max - min);
            baseMean = mean; baseRange = range;

            for (int j = 0; j < pad; j++) dst[j] = laneOffset;
            for (int j = 0; j < n; j++) dst[pad + j] = (slice[j] - mean) / range * LaneAmp + laneOffset;
        }

        /// <summary>Right-aligns real-valued samples, padding the unused left with the oldest value
        /// so the line enters flat rather than from zero.</summary>
        private static void RightAlign(double[] dst, double[] src, int capacity)
        {
            int n = src.Length, pad = Math.Max(0, capacity - n);
            double baseV = n > 0 ? src[0] : 0;
            for (int j = 0; j < pad; j++) dst[j] = baseV;
            for (int j = 0; j < n; j++) dst[pad + j] = src[j];
        }

        /// <summary>Extracts up to <paramref name="take"/> of the most recent samples from a ring
        /// buffer, ending <paramref name="backOffset"/> samples behind the live head (0 = the tail).</summary>
        private static double[] SliceFromRing(double[] ring, int head, int count, int take, int backOffset)
        {
            int available = Math.Max(0, count - backOffset);
            int n = Math.Min(take, available);
            if (n <= 0) return Array.Empty<double>();
            var outp = new double[n];
            int cap = ring.Length;
            int end = ((head - backOffset) % cap + cap) % cap; // one past the last included sample
            for (int j = 0; j < n; j++)
                outp[n - 1 - j] = ring[((end - 1 - j) % cap + cap) % cap];
            return outp;
        }

        private static string Fmt(double v) => Math.Abs(v) >= 10 ? v.ToString("F0") : v.ToString("0.#");

        private static SolidColorBrush Br(string hex)
        {
            var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex);
            b.Freeze();
            return b;
        }
    }
}
