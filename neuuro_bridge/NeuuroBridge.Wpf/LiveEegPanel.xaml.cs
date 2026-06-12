using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Dependency-free live EEG visuals: a rolling 4-channel raw waveform (auto-scaled per
    /// channel to strip the large DC offset), FFT band-power bars (δ θ α β γ, averaged across
    /// channels), and the SDK cognitive readouts. Fed from BridgeController.RawFrame /
    /// FftBandPowers; the waveform redraws on an internal ~25 fps timer.
    /// </summary>
    public partial class LiveEegPanel : UserControl
    {
        private const int Channels = 4;
        private const int Window = 1000;     // ~4 s @ 250 Hz
        private static readonly string[] ChLabels = { "Fp1", "Fp2", "T4", "T3" };
        private static readonly string[] BandLabels = { "δ", "θ", "α", "β", "γ" };
        private static readonly Brush[] ChBrush =
        {
            Brush("#60A5FA"), Brush("#34D399"), Brush("#FBBF24"), Brush("#F472B6")
        };
        private static readonly string[] CogNames = { "Attention", "Relaxation", "Workload" };
        private static readonly Brush[] CogBrush = { Brush("#60A5FA"), Brush("#34D399"), Brush("#FBBF24") };

        private readonly double[][] _buf = new double[Channels][];
        private int _head, _count;
        private readonly object _lock = new object();

        private readonly Polyline[] _waves = new Polyline[Channels];
        private readonly TextBlock[] _waveLabels = new TextBlock[Channels];
        private readonly Rectangle[] _bandRects = new Rectangle[5];
        private readonly TextBlock[] _bandCaps = new TextBlock[5];
        private readonly Border[] _cogBars = new Border[3];
        private readonly TextBlock[] _cogVals = new TextBlock[3];

        private float[] _bandAvg;            // latest 5 band averages, for re-layout on resize
        private readonly DispatcherTimer _render = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(40) };

        public LiveEegPanel()
        {
            InitializeComponent();
            for (int ch = 0; ch < Channels; ch++) _buf[ch] = new double[Window];

            for (int ch = 0; ch < Channels; ch++)
            {
                _waves[ch] = new Polyline { Stroke = ChBrush[ch], StrokeThickness = 1.2 };
                WaveCanvas.Children.Add(_waves[ch]);
                _waveLabels[ch] = new TextBlock { Text = ChLabels[ch], Foreground = ChBrush[ch], FontSize = 11, FontWeight = FontWeights.SemiBold };
                WaveCanvas.Children.Add(_waveLabels[ch]);
            }

            for (int b = 0; b < 5; b++)
            {
                _bandRects[b] = new Rectangle { Fill = Brush("#3B82F6"), RadiusX = 2, RadiusY = 2 };
                BandCanvas.Children.Add(_bandRects[b]);
                _bandCaps[b] = new TextBlock { Text = BandLabels[b], Foreground = Brush("#C2CCDA"), FontSize = 12, TextAlignment = TextAlignment.Center };
                BandCanvas.Children.Add(_bandCaps[b]);
            }

            for (int i = 0; i < 3; i++)
            {
                var row = new StackPanel { Margin = new Thickness(0, 0, 0, 8) };
                var head = new DockPanel();
                head.Children.Add(new TextBlock { Text = CogNames[i], Foreground = Brush("#C2CCDA"), FontSize = 11 });
                _cogVals[i] = new TextBlock { Text = "—", Foreground = Brush("#92A2B8"), FontSize = 11, HorizontalAlignment = HorizontalAlignment.Right };
                DockPanel.SetDock(_cogVals[i], Dock.Right);
                head.Children.Add(_cogVals[i]);
                row.Children.Add(head);
                var track = new Border { Background = Brush("#22303F"), CornerRadius = new CornerRadius(3), Height = 6, Margin = new Thickness(0, 3, 0, 0) };
                _cogBars[i] = new Border { Background = CogBrush[i], CornerRadius = new CornerRadius(3), Height = 6, HorizontalAlignment = HorizontalAlignment.Left, Width = 0 };
                track.Child = _cogBars[i];
                row.Children.Add(track);
                CogPanel.Children.Add(row);
            }

            _render.Tick += (_, __) => DrawWaves();
            Loaded += (_, __) => _render.Start();
            Unloaded += (_, __) => _render.Stop();
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
                    for (int ch = 0; ch < Channels; ch++) _buf[ch][_head] = frame[ch * spc + i];
                    _head = (_head + 1) % Window;
                    if (_count < Window) _count++;
                }
            }
        }

        public void PushBands(BandPowers[] powers)
        {
            if (powers == null || powers.Length == 0) return;
            // BandPowers order: Delta, Theta, Alpha, Beta, Gamma.
            var sum = new float[5];
            foreach (var p in powers) { sum[0] += p.Delta; sum[1] += p.Theta; sum[2] += p.Alpha; sum[3] += p.Beta; sum[4] += p.Gamma; }
            for (int b = 0; b < 5; b++) sum[b] /= powers.Length;
            _bandAvg = sum;
            LayoutBands();
        }

        public void SetCognitive(float attention, float relaxation, float workload)
        {
            float[] v = { attention, relaxation, workload };
            for (int i = 0; i < 3; i++)
            {
                if (float.IsNaN(v[i])) { _cogVals[i].Text = "—"; _cogBars[i].Width = 0; continue; }
                _cogVals[i].Text = v[i].ToString("F2");
                double frac = v[i] > 1f ? Math.Min(v[i] / 100.0, 1.0) : Math.Max(0.0, Math.Min(v[i], 1.0));
                double track = Math.Max(0, ((Border)_cogBars[i].Parent).ActualWidth);
                _cogBars[i].Width = track * frac;
            }
        }

        public void Clear()
        {
            lock (_lock) { _head = 0; _count = 0; }
            _bandAvg = null;
            for (int b = 0; b < 5; b++) _bandRects[b].Height = 0;
            for (int ch = 0; ch < Channels; ch++) _waves[ch].Points = new PointCollection();
        }

        // ── Rendering ────────────────────────────────────────────────────────
        private void DrawWaves()
        {
            double w = WaveCanvas.ActualWidth, h = WaveCanvas.ActualHeight;
            if (w < 4 || h < 4) return;

            int count, head;
            double[][] snap;
            lock (_lock)
            {
                count = _count; head = _head;
                if (count < 2) { for (int ch = 0; ch < Channels; ch++) _waves[ch].Points = new PointCollection(); return; }
                snap = new double[Channels][];
                for (int ch = 0; ch < Channels; ch++)
                {
                    snap[ch] = new double[count];
                    for (int j = 0; j < count; j++)
                        snap[ch][j] = _buf[ch][(head - count + j + Window) % Window];
                }
            }

            double bandH = h / Channels;
            for (int ch = 0; ch < Channels; ch++)
            {
                double min = double.MaxValue, max = double.MinValue;
                for (int j = 0; j < count; j++) { double v = snap[ch][j]; if (v < min) min = v; if (v > max) max = v; }
                double mid = (min + max) / 2, half = Math.Max((max - min) / 2, 1);
                double cy = bandH * ch + bandH / 2, amp = bandH * 0.42;

                var pts = new PointCollection(count);
                double stepX = count > 1 ? w / (count - 1) : w;
                for (int j = 0; j < count; j++)
                {
                    double norm = (snap[ch][j] - mid) / half;       // −1 … 1
                    pts.Add(new Point(j * stepX, cy - norm * amp));
                }
                _waves[ch].Points = pts;

                Canvas.SetLeft(_waveLabels[ch], 6);
                Canvas.SetTop(_waveLabels[ch], bandH * ch + 3);
            }
        }

        private void LayoutBands()
        {
            double w = BandCanvas.ActualWidth, h = BandCanvas.ActualHeight;
            if (w < 4 || h < 4 || _bandAvg == null) return;

            double maxv = 1e-9;
            foreach (var v in _bandAvg) if (v > maxv) maxv = v;
            double slot = w / 5, barW = slot * 0.6, capH = 16, plotH = h - capH;

            for (int b = 0; b < 5; b++)
            {
                double bh = Math.Max(1, plotH * (_bandAvg[b] / maxv));
                _bandRects[b].Width = barW;
                _bandRects[b].Height = bh;
                Canvas.SetLeft(_bandRects[b], slot * b + (slot - barW) / 2);
                Canvas.SetTop(_bandRects[b], plotH - bh);

                _bandCaps[b].Width = slot;
                Canvas.SetLeft(_bandCaps[b], slot * b);
                Canvas.SetTop(_bandCaps[b], plotH + 1);
            }
        }

        private void WaveCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => DrawWaves();
        private void BandCanvas_SizeChanged(object sender, SizeChangedEventArgs e) => LayoutBands();

        private static SolidColorBrush Brush(string hex)
        {
            var b = (SolidColorBrush)new BrushConverter().ConvertFromString(hex);
            b.Freeze();
            return b;
        }
    }
}
