using System;
using System.Windows.Controls;
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
    /// Fed from BridgeController.RawFrame / FftBandPowers / cognitive; redrawn off the composition
    /// clock, throttled to ~20 fps, and only the currently visible tab is refreshed.
    /// </summary>
    public partial class LiveEegPanel : UserControl
    {
        private const int Channels = 4;
        private const int RawWindow = 1000;   // ~4 s @ 250 Hz
        private const int Bands = 5;
        private const int BandSources = 5;    // [0] = avg of channels, [1..4] = Fp1, Fp2, T4, T3
        private const int Cogs = 3;
        private const int Hist = 200;         // rolling history for band / cognitive strips
        private const double LaneGap = 2.0;   // vertical spacing between normalised lanes
        private const double LaneAmp = 1.6;   // normalised peak-to-peak amplitude within a lane

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

        // ── Rolling source buffers ───────────────────────────────────────────
        private readonly double[][] _raw = new double[Channels][];
        private int _rawHead, _rawCount;
        private readonly object _lock = new object();

        // Band history per source: _bandHist[source][band][sample]. Source 0 is the 4-channel
        // average; 1..4 are the individual channels (Fp1, Fp2, T4, T3).
        private readonly double[][][] _bandHist = new double[BandSources][][];
        private readonly double[][] _bandLatest = new double[BandSources][];
        private int _bandHead, _bandCount;
        private int _selectedSource;          // 0 = Avg
        private Button[] _srcButtons;

        private readonly double[][] _cogHist = new double[Cogs][];
        private int _cogHead, _cogCount;
        private readonly double[] _cogLatest = { double.NaN, double.NaN, double.NaN };

        // ── ScottPlot display buffers (referenced live by the SignalPlots) ────
        private double[][] _eegPlot, _bandPlot, _cogPlot;
        private SignalPlot[] _eegSig, _bandSig, _cogSig;
        private int _frame;

        public LiveEegPanel()
        {
            InitializeComponent();

            for (int ch = 0; ch < Channels; ch++) _raw[ch] = new double[RawWindow];
            for (int s = 0; s < BandSources; s++)
            {
                _bandHist[s] = new double[Bands][];
                _bandLatest[s] = new double[Bands];
                for (int b = 0; b < Bands; b++) _bandHist[s][b] = new double[Hist];
            }
            for (int c = 0; c < Cogs; c++) _cogHist[c] = new double[Hist];

            SetupPlots();
            BuildChannelSelector();

            // Drive redraws off the composition clock (vsync) but only refresh the visible tab.
            Loaded   += (_, __) => CompositionTarget.Rendering += OnRendering;
            Unloaded += (_, __) => CompositionTarget.Rendering -= OnRendering;
        }

        private void OnRendering(object sender, EventArgs e)
        {
            if (++_frame % 3 != 0) return;          // ~20 fps is plenty for a strip chart
            if (EegPlot.IsVisible)       UpdateEeg();
            else if (BandPlot.IsVisible) UpdateBands();
            else if (CogPlot.IsVisible)  UpdateCog();
        }

        // ── Plot setup ───────────────────────────────────────────────────────
        private void SetupPlots()
        {
            _eegPlot  = Alloc(Channels, RawWindow);
            _bandPlot = Alloc(Bands, Hist);
            _cogPlot  = Alloc(Cogs, Hist);

            _eegSig  = AddStackedLanes(EegPlot, _eegPlot, ChNames);
            _bandSig = AddStackedLanes(BandPlot, _bandPlot, BandNames);
            _cogSig  = AddSharedAxis(CogPlot, _cogPlot, CogNames, yMin: 0, yMax: 100);
        }

        private static double[][] Alloc(int n, int len)
        {
            var a = new double[n][];
            for (int i = 0; i < n; i++) a[i] = new double[len];
            return a;
        }

        /// <summary>Stacked, per-lane auto-scaled strips (DC stripped). Used for EEG + bands.</summary>
        private static SignalPlot[] AddStackedLanes(WpfPlot ctrl, double[][] buf, string[] names)
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
            plt.SetAxisLimits(0, buf[0].Length - 1, -1.5, (n - 1) * LaneGap + 1.5);
            plt.YAxis.Ticks(false);     // lane offsets are arbitrary
            plt.XAxis.Ticks(false);     // x is just sample index
            plt.Legend(true, Alignment.UpperRight);
            ctrl.Refresh();
            return sigs;
        }

        /// <summary>Real-valued lines on a shared, fixed Y axis. Used for the 0–100 cognitive metrics.</summary>
        private static SignalPlot[] AddSharedAxis(WpfPlot ctrl, double[][] buf, string[] names, double yMin, double yMax)
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
            plt.SetAxisLimits(0, buf[0].Length - 1, yMin, yMax);
            plt.XAxis.Ticks(false);
            plt.Legend(true, Alignment.UpperRight);
            ctrl.Refresh();
            return sigs;
        }

        /// <summary>Locks the view: these are fixed-window live strips, so mouse pan/zoom (which
        /// would let the user scroll off into empty space) is disabled.</summary>
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
                    Padding = new System.Windows.Thickness(10, 3, 10, 3),
                    Margin = new System.Windows.Thickness(0, 0, 6, 0)
                };
                btn.Click += (_, __) => { _selectedSource = idx; UpdateSelectorVisuals(); };
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
                _srcButtons[i].FontWeight = sel ? System.Windows.FontWeights.SemiBold : System.Windows.FontWeights.Normal;
            }
        }

        // ── Data in ──────────────────────────────────────────────────────────
        public void PushRaw(int[] frame)
        {
            if (frame == null || frame.Length < Channels) return;
            int spc = frame.Length / Channels;
            lock (_lock)
            {
                for (int i = 0; i < spc; i++)
                {
                    for (int ch = 0; ch < Channels; ch++) _raw[ch][_rawHead] = frame[ch * spc + i];
                    _rawHead = (_rawHead + 1) % RawWindow;
                    if (_rawCount < RawWindow) _rawCount++;
                }
            }
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
                    _bandHist[c + 1][b][_bandHead] = vals[b];
                    avg[b] += vals[b];
                }
            }
            for (int b = 0; b < Bands; b++)
            {
                avg[b] /= nch;
                _bandLatest[0][b] = avg[b];
                _bandHist[0][b][_bandHead] = avg[b];
            }
            _bandHead = (_bandHead + 1) % Hist;
            if (_bandCount < Hist) _bandCount++;
        }

        public void SetCognitive(float attention, float relaxation, float workload)
        {
            double[] v = { attention, relaxation, workload };
            for (int c = 0; c < Cogs; c++)
            {
                _cogLatest[c] = v[c];
                _cogHist[c][_cogHead] = double.IsNaN(v[c]) ? 0 : v[c];   // keep the trace continuous
            }
            _cogHead = (_cogHead + 1) % Hist;
            if (_cogCount < Hist) _cogCount++;
        }

        public void Clear()
        {
            lock (_lock) { _rawHead = 0; _rawCount = 0; }
            _bandHead = _bandCount = _cogHead = _cogCount = 0;
            for (int s = 0; s < BandSources; s++)
                for (int b = 0; b < Bands; b++) _bandLatest[s][b] = 0;
            for (int c = 0; c < Cogs; c++) _cogLatest[c] = double.NaN;

            ZeroLanes(_eegPlot, Channels);
            ZeroLanes(_bandPlot, Bands);
            foreach (var buf in _cogPlot) Array.Clear(buf, 0, buf.Length);
            EegPlot.Refresh(); BandPlot.Refresh(); CogPlot.Refresh();
        }

        private static void ZeroLanes(double[][] buf, int n)
        {
            for (int i = 0; i < n; i++)
            {
                double off = (n - 1 - i) * LaneGap;
                for (int j = 0; j < buf[i].Length; j++) buf[i][j] = off;
            }
        }

        // ── Per-frame updates (only the visible tab) ─────────────────────────
        private void UpdateEeg()
        {
            lock (_lock)
            {
                for (int ch = 0; ch < Channels; ch++)
                    NormalizeInto(_eegPlot[ch], Snapshot(_raw[ch], _rawHead, _rawCount), _rawCount,
                                  (Channels - 1 - ch) * LaneGap);
            }
            EegPlot.Refresh();
        }

        private void UpdateBands()
        {
            int src = _selectedSource;
            for (int b = 0; b < Bands; b++)
            {
                NormalizeInto(_bandPlot[b], Snapshot(_bandHist[src][b], _bandHead, _bandCount), _bandCount,
                              (Bands - 1 - b) * LaneGap);
                _bandSig[b].Label = _bandCount == 0 ? BandNames[b] : $"{BandNames[b]}  {Fmt(_bandLatest[src][b])}";
            }
            BandPlot.Refresh();
        }

        private void UpdateCog()
        {
            for (int c = 0; c < Cogs; c++)
            {
                RightAlign(_cogPlot[c], Snapshot(_cogHist[c], _cogHead, _cogCount), _cogCount);
                _cogSig[c].Label = double.IsNaN(_cogLatest[c]) ? CogNames[c] : $"{CogNames[c]}  {Fmt(_cogLatest[c])}";
            }
            CogPlot.Refresh();
        }

        // ── Buffer helpers ───────────────────────────────────────────────────
        private static double[] Snapshot(double[] ring, int head, int count)
        {
            var outp = new double[count];
            int cap = ring.Length;
            for (int j = 0; j < count; j++) outp[j] = ring[(head - count + j + cap) % cap];
            return outp;
        }

        /// <summary>Right-aligns <paramref name="count"/> samples into <paramref name="dst"/>, with the
        /// DC offset removed and amplitude normalised onto the lane at <paramref name="off"/>.</summary>
        private static void NormalizeInto(double[] dst, double[] src, int count, double off)
        {
            int cap = dst.Length, pad = Math.Max(0, cap - count);
            double mean = 0, min = double.MaxValue, max = double.MinValue;
            for (int j = 0; j < count; j++) { double v = src[j]; mean += v; if (v < min) min = v; if (v > max) max = v; }
            if (count > 0) mean /= count;
            double range = max - min; if (range < 1e-9) range = 1;

            for (int j = 0; j < pad; j++) dst[j] = off;
            for (int j = 0; j < count && pad + j < cap; j++) dst[pad + j] = (src[j] - mean) / range * LaneAmp + off;
        }

        /// <summary>Right-aligns real-valued samples into <paramref name="dst"/>, padding the unused left
        /// with the oldest value so the line enters flat rather than from zero.</summary>
        private static void RightAlign(double[] dst, double[] src, int count)
        {
            int cap = dst.Length, pad = Math.Max(0, cap - count);
            double baseV = count > 0 ? src[0] : 0;
            for (int j = 0; j < pad; j++) dst[j] = baseV;
            for (int j = 0; j < count && pad + j < cap; j++) dst[pad + j] = src[j];
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
