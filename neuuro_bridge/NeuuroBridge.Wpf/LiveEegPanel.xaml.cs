using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Dependency-free live EEG visuals styled after the Neeuro reference app's paper
    /// strip charts (adapted to the dark theme): three tabs of stacked, labelled lanes
    /// with thin scrolling lines.
    ///   • EEG Waves      — 4 raw channels, auto-scaled per lane to strip the DC offset.
    ///   • Frequency Bands — δ θ α β γ band power (avg of 4 channels) over time + current value.
    ///   • Mental States   — Attention / Relaxation / Workload over time + current value.
    /// Fed from BridgeController.RawFrame / FftBandPowers / cognitive; redraws on a ~25 fps timer.
    /// </summary>
    public partial class LiveEegPanel : UserControl
    {
        private const int Channels = 4;
        private const int RawWindow = 1000;   // ~4 s @ 250 Hz
        private const int Bands = 5;
        private const int BandSources = 5;    // [0] = avg of channels, [1..4] = Fp1, Fp2, T4, T3
        private const int Cogs = 3;
        private const int Hist = 200;         // rolling history for band / cognitive strips
        private const double RightPad = 8;

        private static readonly string[] EegLabels = { "Ch1\nFp1", "Ch2\nFp2", "Ch3\nT4", "Ch4\nT3" };
        private static readonly string[] BandLabels =
        {
            "Delta\n(1–4 Hz)", "Theta\n(4–8 Hz)", "Alpha\n(8–12 Hz)",
            "Beta\n(12–30 Hz)", "Gamma\n(30–40 Hz)"
        };
        private static readonly string[] CogLabels = { "Attention", "Relaxation", "Mental\nWorkload" };
        private static readonly string[] SourceLabels = { "Avg", "Ch1", "Ch2", "Ch3", "Ch4" };

        private static readonly Brush LineBrush   = Br("#B7C5D9");   // thin paper-style trace
        private static readonly Brush SepBrush    = Br("#22303F");   // faint lane separator
        private static readonly Brush LabelBrush  = Br("#92A2B8");
        private static readonly Brush ValueBrush  = Br("#E6EDF6");
        private static readonly Brush ChipBrush   = Br("#1E2A3C");   // unselected channel chip
        private static readonly Brush AccentBrush = Br("#3B82F6");   // selected channel chip

        // ── Rolling buffers ──────────────────────────────────────────────────
        private readonly double[][] _raw = new double[Channels][];
        private int _rawHead, _rawCount;
        private readonly object _lock = new object();

        // Band history is kept per source: _bandHist[source][band][sample]. Source 0 is the
        // 4-channel average; 1..4 are the individual channels (Fp1, Fp2, T4, T3).
        private readonly double[][][] _bandHist = new double[BandSources][][];
        private readonly double[][] _bandLatest = new double[BandSources][];
        private int _bandHead, _bandCount;
        private int _selectedSource;          // 0 = Avg
        private Button[] _srcButtons;

        private readonly double[][] _cogHist = new double[Cogs][];
        private int _cogHead, _cogCount;
        private readonly double[] _cogLatest = { double.NaN, double.NaN, double.NaN };

        // ── Lane visuals ─────────────────────────────────────────────────────
        private sealed class Lane
        {
            public Polyline Wave;
            public Line Baseline;
            public TextBlock Label;
            public TextBlock Value;   // null when the lane shows no numeric readout

            // Envelope-smoothed auto-scale so the trace doesn't "breathe" each time a
            // spike scrolls out of the window. Fast attack, slow release (see DrawWave).
            public double SmMid, SmRange;
            public bool ScaleInit;
        }

        private Lane[] _eegLanes, _bandLanes, _cogLanes;

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

            _eegLanes  = BuildLanes(WaveCanvas, EegLabels, withValue: false);
            _bandLanes = BuildLanes(BandCanvas, BandLabels, withValue: true);
            _cogLanes  = BuildLanes(CogCanvas, CogLabels, withValue: true);
            BuildChannelSelector();

            // Drive redraws off the composition clock (vsync, ~60 fps and frame-synced)
            // instead of a 25 fps timer, so the trace scrolls continuously and evenly.
            Loaded += (_, __) => CompositionTarget.Rendering += OnRendering;
            Unloaded += (_, __) => CompositionTarget.Rendering -= OnRendering;
        }

        private void OnRendering(object sender, EventArgs e)
        {
            DrawEeg();
            DrawBands();
            DrawCog();
        }

        private static Lane[] BuildLanes(Canvas canvas, string[] labels, bool withValue)
        {
            var lanes = new Lane[labels.Length];
            for (int i = 0; i < labels.Length; i++)
            {
                var lane = new Lane
                {
                    Baseline = new Line { Stroke = SepBrush, StrokeThickness = 1 },
                    Wave = new Polyline { Stroke = LineBrush, StrokeThickness = 1.1, StrokeLineJoin = PenLineJoin.Round },
                    Label = new TextBlock
                    {
                        Text = labels[i], Foreground = LabelBrush, FontSize = 10,
                        FontWeight = FontWeights.SemiBold, TextAlignment = TextAlignment.Center,
                        LayoutTransform = new RotateTransform(-90)
                    }
                };
                canvas.Children.Add(lane.Baseline);
                canvas.Children.Add(lane.Wave);
                canvas.Children.Add(lane.Label);
                if (withValue)
                {
                    lane.Value = new TextBlock { Text = "—", Foreground = ValueBrush, FontSize = 15, FontWeight = FontWeights.Bold };
                    canvas.Children.Add(lane.Value);
                }
                lanes[i] = lane;
            }
            return lanes;
        }

        // Channel selector for the Frequency Bands tab (Avg · Ch1 · Ch2 · Ch3 · Ch4).
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
                btn.Click += (_, __) => { _selectedSource = idx; UpdateSelectorVisuals(); DrawBands(); };
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
            foreach (var l in _eegLanes) { l.Wave.Points = new PointCollection(); l.ScaleInit = false; }
            foreach (var l in _bandLanes) { l.Wave.Points = new PointCollection(); l.Value.Text = "—"; l.ScaleInit = false; }
            foreach (var l in _cogLanes) { l.Wave.Points = new PointCollection(); l.Value.Text = "—"; l.ScaleInit = false; }
        }

        // ── Rendering ────────────────────────────────────────────────────────
        private void DrawEeg()
        {
            double w = WaveCanvas.ActualWidth, h = WaveCanvas.ActualHeight;
            if (w < 4 || h < 4) return;

            int count, head;
            double[][] snap;
            lock (_lock)
            {
                count = _rawCount; head = _rawHead;
                snap = new double[Channels][];
                for (int ch = 0; ch < Channels; ch++)
                {
                    snap[ch] = new double[count];
                    for (int j = 0; j < count; j++) snap[ch][j] = _raw[ch][(head - count + j + RawWindow) % RawWindow];
                }
            }

            double laneH = h / Channels, gutter = 26;
            for (int ch = 0; ch < Channels; ch++)
            {
                double top = laneH * ch;
                PositionChrome(_eegLanes[ch], top, laneH, gutter, w);
                DrawWave(_eegLanes[ch], snap[ch], count, top, laneH, gutter, w);
            }
        }

        private void DrawBands()
        {
            double w = BandCanvas.ActualWidth, h = BandCanvas.ActualHeight;
            if (w < 4 || h < 4) return;

            int src = _selectedSource;
            double laneH = h / Bands, gutter = 64;
            for (int b = 0; b < Bands; b++)
            {
                double top = laneH * b;
                PositionChrome(_bandLanes[b], top, laneH, gutter, w);
                DrawWave(_bandLanes[b], Snapshot(_bandHist[src][b], _bandHead, _bandCount), _bandCount, top, laneH, gutter, w);
                _bandLanes[b].Value.Text = _bandCount == 0 ? "—" : Fmt(_bandLatest[src][b]);
            }
        }

        private void DrawCog()
        {
            double w = CogCanvas.ActualWidth, h = CogCanvas.ActualHeight;
            if (w < 4 || h < 4) return;

            double laneH = h / Cogs, gutter = 64;
            for (int c = 0; c < Cogs; c++)
            {
                double top = laneH * c;
                PositionChrome(_cogLanes[c], top, laneH, gutter, w);
                DrawWave(_cogLanes[c], Snapshot(_cogHist[c], _cogHead, _cogCount), _cogCount, top, laneH, gutter, w);
                _cogLanes[c].Value.Text = double.IsNaN(_cogLatest[c]) ? "—" : Fmt(_cogLatest[c]);
            }
        }

        private static double[] Snapshot(double[] ring, int head, int count)
        {
            var outp = new double[count];
            int cap = ring.Length;
            for (int j = 0; j < count; j++) outp[j] = ring[(head - count + j + cap) % cap];
            return outp;
        }

        /// <summary>Positions the lane separator, rotated label and (optional) value readout.</summary>
        private static void PositionChrome(Lane lane, double top, double laneH, double gutter, double w)
        {
            lane.Baseline.X1 = gutter;
            lane.Baseline.X2 = w - RightPad;
            lane.Baseline.Y1 = lane.Baseline.Y2 = top + laneH - 0.5;

            lane.Label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            double lblH = lane.Label.DesiredSize.Height;   // rotated bounding box height
            Canvas.SetLeft(lane.Label, lane.Value != null ? 32 : 6);
            Canvas.SetTop(lane.Label, top + Math.Max(0, (laneH - lblH) / 2));

            if (lane.Value != null)
            {
                lane.Value.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
                Canvas.SetLeft(lane.Value, 6);
                Canvas.SetTop(lane.Value, top + Math.Max(0, (laneH - lane.Value.DesiredSize.Height) / 2));
            }
        }

        /// <summary>Draws one auto-scaled trace within a lane. The min..max window scale is
        /// envelope-smoothed (fast attack / slow release) so a spike shows immediately but the
        /// gain doesn't snap — and thus the whole trace doesn't visibly jump — each time that
        /// spike later scrolls out of the window.</summary>
        private static void DrawWave(Lane lane, double[] data, int count, double top, double laneH, double gutter, double w)
        {
            var wave = lane.Wave;
            if (count < 2) { wave.Points = new PointCollection(); return; }

            double min = double.MaxValue, max = double.MinValue;
            for (int j = 0; j < count; j++) { double v = data[j]; if (v < min) min = v; if (v > max) max = v; }
            double tMid = (min + max) / 2, tRange = max - min;

            if (!lane.ScaleInit) { lane.SmMid = tMid; lane.SmRange = tRange; lane.ScaleInit = true; }
            else
            {
                lane.SmMid += (tMid - lane.SmMid) * 0.2;
                double aRange = tRange > lane.SmRange ? 0.35 : 0.03;   // grow fast, shrink slow
                lane.SmRange += (tRange - lane.SmRange) * aRange;
            }

            double mid = lane.SmMid, range = lane.SmRange;
            double cy = top + laneH / 2, amp = laneH * 0.38;
            double plotW = (w - RightPad) - gutter;
            double stepX = count > 1 ? plotW / (count - 1) : plotW;

            var pts = new PointCollection(count);
            for (int j = 0; j < count; j++)
            {
                double norm = range > 1e-9 ? (data[j] - mid) / (range / 2) : 0;   // flat → centered
                if (norm > 1.25) norm = 1.25; else if (norm < -1.25) norm = -1.25; // clamp attack overshoot
                pts.Add(new Point(gutter + j * stepX, cy - norm * amp));
            }
            wave.Points = pts;
        }

        private static string Fmt(double v) => Math.Abs(v) >= 10 ? v.ToString("F0") : v.ToString("0.#");

        private void WaveCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawEeg();
        private void BandCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawBands();
        private void CogCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawCog();

        private static SolidColorBrush Br(string hex)
        {
            var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex);
            b.Freeze();
            return b;
        }
    }
}
