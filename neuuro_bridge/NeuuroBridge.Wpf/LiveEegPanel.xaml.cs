using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using ScottPlot;
using ScottPlot.DataSources;
using ScottPlot.DataViews;
using ScottPlot.Plottables;
using ScottPlot.WPF;
using SPColor = ScottPlot.Color;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// Live EEG visuals — three tabs of scrolling strip charts:
    ///   • EEG Waves       — 4 raw channels, each in its OWN bordered mini-plot (own axis, own
    ///                       pixel region) so a channel's line can never visually cross into a
    ///                       neighbouring channel's section.
    ///   • Frequency Bands — δ θ α β γ band power for one selected channel (Fp1/Fp2/T4/T3) at a
    ///                       time, same one-plot-per-band isolation, current value in the legend.
    ///   • Mental States   — Attention / Relaxation / Workload (0–100), overlaid on one shared axis
    ///                       (a real multi-line comparison chart, not stacked lanes — left as-is).
    ///
    /// Built on ScottPlot 5's <see cref="DataStreamer"/> — a fixed-capacity scrolling plot type
    /// purpose-built for exactly this (its own docs cite ECG waveforms as the model case).
    ///
    /// Two independent layers of history per lane:
    ///   1. A full-session ring buffer (_rawFull / _bandFull / _cogFull; minutes of data) — always
    ///      appended to regardless of which tab is visible or whether the technician has scrubbed
    ///      back. Source of truth, and what the DataStreamer is reseeded from on resume-live.
    ///   2. Two ScottPlot plottables per lane, toggled by IsVisible: a DataStreamer for the live
    ///      edge, and a Signal (large fixed backing array, mutated in place) for the scrubbed/
    ///      historical view — DataStreamer's own buffer is only ~the visible window, it has no way
    ///      to look further back than that on its own.
    /// Scrubbing back through history works three ways, all driving the same per-tab state: drag
    /// (with a minimum-movement threshold so a plain click can't be mistaken for one), Ctrl+wheel,
    /// and a scrollbar under each chart.
    /// Fed from BridgeController.RawFrame / FftBandPowers / cognitive; redrawn off the composition
    /// clock, throttled to ~30 fps, and only the currently visible tab is refreshed/redrawn.
    /// </summary>
    public partial class LiveEegPanel : UserControl
    {
        private const int Channels = 4;
        private const int RawWindow = 2500;   // 10 s @ 250 Hz — the live-view width
        private const int RawFullCapacity = 450_000; // ~30 min @ 250 Hz of full-session history

        // EEG Waves live-edge RENDERER: false = the custom PooledScrollView (new data enters on the
        // right, old data slides off the left — see CreateLanePlots/PooledScrollView). true = the
        // ScottPlot-native wipe/sweep view instead. Kept as a toggle for future tuning even though
        // only false is in active use right now.
        private const bool EegWipeMode = false;

        // Independent of the renderer above: whether the live buffer hard-clears (blank, not a
        // gradual slide) the instant it's full, then refills from empty, instead of scrolling
        // forever. Orthogonal to EegWipeMode — this is about when data gets cleared, not how a full
        // buffer is drawn. See AddEegSample. Tried true (10s fill/blank/refill) — didn't fix the
        // periodic pause (that's real BLE data loss, not a rendering artifact — see
        // project_ble_packet_loss.md) and wasn't preferred either, so back to continuous scroll.
        private const bool EegFlushOnFull = false;

        private const int Bands = 5;
        // Fp1, Fp2, T4, T3 — SDK frame order (T4 before T3, see DbUploader.FrameIdx). No "Avg"
        // source: an average across 4 electrodes at different scalp sites isn't a meaningful signal.
        private const int BandSources = 4;
        private const int BandFullCapacity = 3600;    // ~1 h @ ~1 Hz

        private const int Cogs = 3;
        private const int Hist = 200;         // live-view width for bands/cognitive, unchanged from before
        private const int CogFullCapacity = 3600;     // ~1 h at the ~2 Hz refresh cadence

        // Each channel/band now owns its whole axis (no shared-lane offset stacking), so this is
        // just how far a normalised trace can swing from its own centre line.
        private const double NormAmp = 1.0;
        private const double AxisHalfHeight = 1.3;
        private const double BaselineAlpha = 0.06; // EMA blend rate for the bands auto-gain baseline

        private static readonly string[] ChNames   = { "Fp1", "Fp2", "T4", "T3" };
        private static readonly string[] BandNames  = { "Delta", "Theta", "Alpha", "Beta", "Gamma" };
        private static readonly string[] CogNames   = { "Attention", "Relaxation", "Workload" };
        private static readonly string[] SourceLabels = { "Fp1", "Fp2", "T4", "T3" };

        private static readonly SPColor[] Palette =
        {
            new("#3B82F6"),   // blue
            new("#22C55E"),   // green
            new("#F59E0B"),   // amber
            new("#E67E22"),   // orange
            new("#A78BFA"),   // violet
        };

        private static readonly Brush LabelBrush  = Br("#92A2B8");
        private static readonly Brush ChipBrush    = Br("#1E2A3C");   // unselected channel chip
        private static readonly Brush AccentBrush  = Br("#3B82F6");   // selected channel chip
        private static readonly Brush PlotBg       = Br("#0B121C");

        // ── Full-session ring buffers (source of truth; always growing until wrap) ────────────
        private readonly double[][] _rawFull = new double[Channels][];
        private int _rawFullHead, _rawFullCount;
        private readonly object _lock = new object();
        // Real wall-clock arrival time of the last PushRaw call — lets PushRaw itself detect a real
        // gap (elapsed time implies more samples than actually arrived) and write NaN placeholders
        // straight into _rawFull, so the PERSISTED history is gap-aware too, not just the live edge.
        // Without this, _rawFull only ever holds real samples packed back-to-back with no notion of
        // elapsed time — exactly the pre-ScottPlot5 behaviour that silently time-compressed real BLE
        // loss into an invisible smooth line (see the ITP1-era LiveEegPanel, commit a0ff01e).
        private DateTime? _rawLastUtc;

        // _bandFull[source][band]; source 0..3 = Fp1/Fp2/T4/T3 (SourceLabels order).
        private readonly double[][][] _bandFull = new double[BandSources][][];
        private readonly double[][] _bandLatest = new double[BandSources][];
        private int _bandFullHead, _bandFullCount;
        private int _selectedSource;          // 0 = Fp1
        private Button[] _srcButtons;

        private readonly double[][] _cogFull = new double[Cogs][];
        private int _cogFullHead, _cogFullCount;
        private readonly double[] _cogLatest = { double.NaN, double.NaN, double.NaN };

        // ── Per-lane plots: one bordered WpfPlot per channel/band, each with its own DataStreamer
        // (live) + Signal (scrub history) + locked AxisLimits ───────────────────────────────────
        private WpfPlot[] _eegPlots, _bandPlots;
        private WpfPlot[] _cogPlotArray;   // = { CogPlot } — UpdateTimeAxis takes an array; Cog has just the one shared plot
        private DataStreamer[] _eegStream, _bandStream, _cogStream;
        private double[][] _eegHistBuf, _bandHistBuf, _cogHistBuf;
        private Signal[] _eegHistSig, _bandHistSig, _cogHistSig;
        private AxisLimits[] _eegAxisLimits, _bandAxisLimits;
        private AxisLimits _cogAxisLimits;

        // EEG's scrub/history view can't use the plain Signal above (see _eegHistSig) once
        // _eegHistBuf may contain NaN gap placeholders — ScottPlot 5's Signal draws straight through
        // NaN with no break (verified against its own source; unlike DataStreamer it has no
        // gap-aware view hook). So the EEG lanes render history as a set of small line segments
        // instead, one per contiguous run of real samples, rebuilt whenever the scrub window moves —
        // see RebuildEegHistSegments. _eegHistSig[ch] for EEG lanes stays permanently invisible and
        // unused; kept only because CreateLanePlots is shared with the Bands tab, which has no gaps.
        private readonly List<IPlottable>[] _eegHistSegments = new List<IPlottable>[Channels];

        // Amplitude reference per EEG lane — Axes.Frameless() (see StyleDark) strips the axis
        // entirely for the clean look, which otherwise leaves no quantitative sense of scale on a
        // bare moving line. The trace is auto-gain normalised (RecalibrateEegGain), so a FIXED "100
        // µV" label would be dishonest — a normalised unit represents a different real µV span per
        // channel and drifts as the gain re-calibrates. The label is recomputed from that channel's
        // actual current _eegBaseRange (in raw ADC counts) via the SenzeBand 2's published
        // 0.02235 µV/count resolution (see the product spec), so it always reflects what's really on
        // screen — throttled to ~1/s so the number doesn't visibly jitter with every recalibration.
        private ScaleBar[] _eegScaleBars;
        private const double ScaleBarHeightUnits = 0.5;   // normalised-axis units the bar spans
        // Single shared source of truth in NeuuroBridge.Core.BridgeController — also used there
        // for the ITP2 #4 100Hz low-pass filter's raw-ADC-to-µV conversion.
        private const double MicrovoltsPerCount = NeuuroBridge.BridgeController.MicrovoltsPerCount;
        private int _scaleBarLastUpdateTicks;
        private const int ScaleBarUpdateIntervalMs = 1000;

        // Auto-gain baseline (mean/range) per EEG channel — recalibrated from a representative
        // window of full-session history each push (see RecalibrateEegGain), not from the incoming
        // batch: a batch spans well under a second, far too short to capture a channel's real
        // swing (an eye blink or an alpha cycle can easily run longer).
        private readonly double[] _eegBaseMean = new double[Channels];
        private readonly double[] _eegBaseRange = new double[Channels];

        // Real EEG arrives in ~5/s BLE bursts of ~50 samples each — pushing a whole burst into the
        // streamer in one frame revealed it as one visible jump every ~200ms. These queues hold
        // already-normalised, already-real samples (nothing fabricated) between arrival and
        // reveal; FeedEegPending drains them at the true 250 Hz hardware rate every render frame,
        // so the chart shows a smooth, constant trickle instead of a jump-then-hold. If a queue
        // empties (a real gap — e.g. actual BLE packet loss, see docs/ARCHITECTURE.md §8), the
        // trace holds its last value until more real data arrives, then a short dropout is drawn
        // as a straight line (see MaxBridgedGapSamples).
        private readonly Queue<double>[] _eegPending = new Queue<double>[Channels];
        // False until the first real PushRaw arrives — before that, FeedEegPending must not run at
        // all, otherwise its real-time clock treats the whole "not connected yet" span as one giant
        // gap and immediately treats the whole chart as a dropout before the SenzeBand has
        // even paired. See PushRaw/Clear.
        private bool _eegHasData;
        // Wall-clock moment of the first-ever real EEG sample — session t=0 for the time axis shown
        // on all three chart tabs (EEG Waves / Frequency Bands / Mental States), not just this one.
        // Distinct from _rawLastUtc, which moves every call; this one is fixed for the whole session.
        private DateTime? _sessionStartUtc;
        private int _eegFeedTicks;
        private double _eegFeedRemainder;   // fractional samples owed, carried across ticks to avoid drift
        private const double EegSampleIntervalMs = 1000.0 / 250.0;

        // Display-only 0.5 Hz high-pass per channel (see HighPassFilter): the raw stream carries the
        // electrode's DC offset and drift, which otherwise set the auto-gain and flatten the EEG.
        // Applied as samples enter _rawFull, so live, scrubbed history and the scale bar all show the
        // same signal. Reset after a gap so the offset jump across it does not ring. Nothing that is
        // stored or uploaded passes through here.
        private const double DisplayHighPassHz = 0.5;
        private readonly HighPassFilter[] _displayHighPass = new HighPassFilter[Channels];

        // EEG lane scale: 0 = auto-gain to the visible window; otherwise each lane is pinned to
        // ±that many µV (same choices as the web chart), so channels can be compared by eye.
        private static readonly double[] EegScalesUv = { 0, 5, 10, 25, 50, 100 };
        private double _eegFixedHalfUv;
        private Button[] _eegScaleButtons;

        // Caps how often the 4 EEG plots actually repaint, independent of how often real data is fed
        // into them (still every frame, at the true 250 Hz pace) — see RefreshVisibleTab.
        private int _eegLastRefreshTicks;
        private const int EegRefreshIntervalMs = 33; // ~30 fps

        // Counts samples pushed into each EEG lane since its last hard-clear, so AddEegSample can
        // blank the buffer the instant it's full (EegFlushOnFull) rather than scrolling forever.
        private readonly int[] _eegWipeCount = new int[Channels];

        // ── Session event markers on EEG Waves (images/questions/baseline phases) ──────────────
        // One IPlottable per lane (so they visually line up across all 4 channels), repositioned
        // every frame from the real shown_at timestamp — same 250 Hz virtual clock FeedEegPending
        // uses, which is exact now that gaps are paced with NaN rather than skipped (see
        // FeedEegPending). Pruned once fully scrolled past the live window so the list — and the
        // plottables on each of the 4 plots — don't grow for the whole session.
        private sealed class EegMarker
        {
            public DateTime ShownAtUtc;
            public DateTime EffectiveEndUtc;   // = ShownAtUtc for point events (images/questions)
            public bool IsPhase;
            public IPlottable[] Items;         // one slot per EEG lane plot; null for a lane this
                                                // marker doesn't apply to (e.g. blink only populates
                                                // Fp1/Fp2) — every consumer below must null-check
        }
        private readonly List<EegMarker> _eegMarkers = new List<EegMarker>();
        private static readonly SPColor MarkerLineColor = new SPColor("#F59E0B");
        private static readonly SPColor PhaseSpanColor = new SPColor("#3B82F6");
        // ITP2 #5 — blink/clench quality-check markers. Colors reuse the existing chart Palette
        // (already validated readable on this dark theme) rather than introducing new ad-hoc ones.
        private static readonly SPColor BlinkLineColor = Palette[4];  // violet
        private static readonly SPColor ClenchLineColor = Palette[3]; // orange

        // ── Dropouts (BLE data loss) ───────────────────────────────────────────────────────────
        // A dropout of up to MaxBridgedGapSamples is drawn as a straight line from the last sample
        // before it to the first sample after it, keeping its real duration on the time axis so the
        // event / blink / clench markers stay on the right part of the trace. While a dropout is
        // still in progress the live edge holds the last value, for up to the same limit. Longer
        // than that the headband has effectively disconnected and the line breaks (NaN — see
        // PooledScrollView). This is the usual approach for live wireless EEG (the OpenBCI GUI
        // interpolates lost packets) and for live charts generally (Grafana's "connect null values
        // below a threshold"). Display only: the stored EEG, the website and the PDF are untouched.
        private const int MaxBridgedGapSamples = 500;   // 2 s @ 250 Hz
        private readonly double[] _lastHp = NaNs(Channels);   // last high-passed sample written per channel
        private readonly double[] _lastFed = NaNs(Channels);  // last value fed to each live streamer
        private int _heldTicks;                               // consecutive live-edge ticks with no data

        private static double[] NaNs(int n)
        {
            var a = new double[n];
            for (int i = 0; i < n; i++) a[i] = double.NaN;
            return a;
        }

        /// <summary>The <paramref name="count"/> samples standing in for a dropout between
        /// <paramref name="from"/> and <paramref name="to"/>: a straight line if the dropout is short
        /// enough to bridge and there is a sample before it, otherwise NaN (a break).</summary>
        private static double[] GapFill(double from, double to, int count)
        {
            var fill = new double[count];
            bool bridge = count <= MaxBridgedGapSamples && !double.IsNaN(from) && !double.IsNaN(to);
            for (int k = 0; k < count; k++)
                fill[k] = bridge ? from + (to - from) * (k + 1) / (count + 1) : double.NaN;
            return fill;
        }

        // Bands keep the slower EMA approach — one discrete sample at a time (~1 Hz), not a batch,
        // so the "window too short" failure mode above doesn't apply the same way.
        private readonly double[,] _bandBaseMean = new double[BandSources, Bands];
        private readonly double[,] _bandBaseRange = new double[BandSources, Bands];

        // ── Per-tab scrub state ─────────────────────────────────────────────────────────────────
        private sealed class Track
        {
            public bool Live = true;
            public int ScrubOffset;        // samples back from the live tail (0 = live edge)
            public double DragStartX;
            public int DragStartOffset;
            public bool Dragging;
            public bool DragEngaged;
            // Snapshot taken the instant this tab leaves live mode — the time axis (and, for
            // Bands/Cog, the empirical samples/sec estimate it's built from) is computed from THESE
            // frozen values while scrubbed, never from a live-advancing DateTime.UtcNow, so browsing
            // history reads as a static snapshot (ticks/gridlines included) instead of the labels
            // continuing to creep forward under a frozen trace. See SetScrubOffset/UpdateTimeAxis.
            public DateTime FrozenNowUtc;
            public double FrozenSamplesPerSecond;
        }
        private const double DragThresholdPx = 6;   // avoids a plain click reading as a drag

        private readonly Track _eegTrack = new Track();
        private readonly Track _bandTrack = new Track();
        private readonly Track _cogTrack = new Track();
        private bool _syncingScrollbar;   // reentrancy guard: programmatic ScrollBar.Value writes must not re-trigger ValueChanged

        public LiveEegPanel()
        {
            InitializeComponent();

            for (int ch = 0; ch < Channels; ch++) { _rawFull[ch] = new double[RawFullCapacity]; _eegPending[ch] = new Queue<double>(); _eegHistSegments[ch] = new List<IPlottable>(); }
            for (int ch = 0; ch < Channels; ch++) _displayHighPass[ch] = new HighPassFilter(DisplayHighPassHz, 1000.0 / EegSampleIntervalMs);
            for (int s = 0; s < BandSources; s++)
            {
                _bandFull[s] = new double[Bands][];
                _bandLatest[s] = new double[Bands];
                for (int b = 0; b < Bands; b++) _bandFull[s][b] = new double[BandFullCapacity];
            }
            for (int c = 0; c < Cogs; c++) _cogFull[c] = new double[CogFullCapacity];

            SetupPlots();
            BuildChannelSelector();
            BuildEegScaleSelector();

            HookScrub(_eegPlots, _eegTrack, RawWindow, RebuildEegWindow);
            HookScrub(_bandPlots, _bandTrack, Hist, RebuildBandWindow);
            HookScrub(new[] { CogPlot }, _cogTrack, Hist, RebuildCogWindow);
            BtnEegLive.Click += (_, __) => JumpToLive(_eegTrack, RebuildEegWindow, BtnEegLive);
            BtnBandLive.Click += (_, __) => JumpToLive(_bandTrack, RebuildBandWindow, BtnBandLive);
            BtnCogLive.Click += (_, __) => JumpToLive(_cogTrack, RebuildCogWindow, BtnCogLive);

            _eegFeedTicks = Environment.TickCount;
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
            RefreshVisibleTab(force: true);
        }

        private void OnRendering(object sender, EventArgs e)
        {
            // Every composition frame (not throttled): the whole point of the pacing below is a
            // smooth reveal, and skipping frames would just reintroduce the chunkiness elsewhere.
            FeedEegPending();
            RefreshLabels();
            RefreshVisibleTab(force: false);
        }

        private void RefreshVisibleTab(bool force)
        {
            if (EegPlot0Visible())
            {
                bool anyNew = false;
                for (int i = 0; i < Channels; i++)
                {
                    _eegPlots[i].Plot.Axes.SetLimits(_eegAxisLimits[i]);
                    if (_eegStream[i].HasNewData) anyNew = true;
                }
                UpdateEegMarkers();
                UpdateScaleBars();
                UpdateTimeAxis(_eegPlots, _eegTrack, RawWindow);
                // Data is fed into the streamers at the true 250 Hz hardware rate every frame (see
                // FeedEegPending) so the underlying trace is exactly as smooth/accurate as before —
                // but that means HasNewData is true on essentially every single composition frame,
                // which was forcing a full redraw of all 4 separate per-channel plots at native
                // display refresh rate (4x the cost of the old single shared plot). Capping how often
                // we actually repaint (not how often we feed data) cuts that cost without changing
                // what data ends up on screen or when — ~30 fps reads as smooth motion to the eye for
                // a waveform like this, same as most video.
                int now = Environment.TickCount;
                bool due = now - _eegLastRefreshTicks >= EegRefreshIntervalMs;
                if (force || !_eegTrack.Live || (anyNew && due))
                {
                    for (int i = 0; i < Channels; i++) _eegPlots[i].Refresh();
                    _eegLastRefreshTicks = now;
                }
                SyncScrollbar(EegScrollBar, _eegTrack, RawWindow);
            }
            else if (BandPlot0Visible())
            {
                UpdateTimeAxis(_bandPlots, _bandTrack, Hist);
                for (int i = 0; i < Bands; i++)
                {
                    _bandPlots[i].Plot.Axes.SetLimits(_bandAxisLimits[i]);
                    if (force || _bandStream[i].HasNewData || !_bandTrack.Live) _bandPlots[i].Refresh();
                }
                SyncScrollbar(BandScrollBar, _bandTrack, Hist);
            }
            else if (CogPlot.IsVisible)
            {
                UpdateTimeAxis(_cogPlotArray, _cogTrack, Hist);
                CogPlot.Plot.Axes.SetLimits(_cogAxisLimits);
                bool anyNew = false;
                foreach (var s in _cogStream) if (s.HasNewData) anyNew = true;
                if (force || anyNew || !_cogTrack.Live) CogPlot.Refresh();
                SyncScrollbar(CogScrollBar, _cogTrack, Hist);
            }
        }

        // Any lane in a tab shares the same IsVisible state as the others in that tab (the whole
        // tab is shown/hidden together), so checking lane 0 is representative of the tab.
        private bool EegPlot0Visible() => _eegPlots[0].IsVisible;
        private bool BandPlot0Visible() => _bandPlots[0].IsVisible;

        // ── Plot setup ───────────────────────────────────────────────────────
        private void SetupPlots()
        {
            (_eegPlots, _eegStream, _eegHistSig, _eegHistBuf, _eegAxisLimits) =
                CreateLanePlots(EegPlotHost, Channels, RawWindow, ChNames, wipe: EegWipeMode);
            (_bandPlots, _bandStream, _bandHistSig, _bandHistBuf, _bandAxisLimits) =
                CreateLanePlots(BandPlotHost, Bands, Hist, BandNames, wipe: false);

            _eegScaleBars = new ScaleBar[Channels];
            for (int i = 0; i < Channels; i++)
            {
                var sb = _eegPlots[i].Plot.Add.ScaleBar(0, ScaleBarHeightUnits);
                sb.LineColor = new SPColor("#6B7A90");
                sb.LineWidth = 1.5f;
                sb.YLabelStyle.ForeColor = new SPColor("#92A2B8");
                sb.YLabelStyle.FontSize = 10;
                sb.YLabel = "…";   // set for real once a gain estimate exists — see UpdateScaleBars
                _eegScaleBars[i] = sb;
            }

            _cogPlotArray = new[] { CogPlot };
            _cogHistBuf = Alloc(Cogs, Hist);
            _cogStream = AddSharedAxisStreamers(CogPlot, Cogs, Hist, CogNames, yMin: 0, yMax: 100);
            _cogHistSig = AddHistSignalLanes(CogPlot, _cogHistBuf, CogNames);
            _cogAxisLimits = new AxisLimits(0, Hist - 1, 0, 100);
            CogPlot.Plot.Axes.SetLimits(_cogAxisLimits);
            CogPlot.Plot.Axes.Bottom.IsVisible = true;
            CogPlot.Plot.Axes.Bottom.TickLabelStyle.FontSize = 10;
            CogPlot.Refresh();
        }

        private static double[][] Alloc(int n, int len)
        {
            var a = new double[n][];
            for (int i = 0; i < n; i++) a[i] = new double[len];
            return a;
        }

        /// <summary>Builds one bordered WpfPlot per lane, hosted in <paramref name="host"/> (a Grid
        /// given one auto-added equal-height row per lane) — each lane's own axis and pixel region,
        /// so its line can never visually cross into a neighbour's section. Each hosts a live
        /// DataStreamer plus a hidden Signal used for the scrubbed/history view.
        /// <paramref name="wipe"/> selects the live DataStreamer's view mode: false = continuous
        /// scroll (oldest data flows off the left edge as new data enters on the right); true =
        /// wipe/sweep (fills left-to-right like an oscilloscope, then wipes and restarts at the left
        /// once the window is full). Both modes render the exact same underlying samples at the
        /// exact same true rate — wipe only changes how already-real data is laid out on screen, it
        /// doesn't invent or skip anything.</summary>
        private (WpfPlot[] plots, DataStreamer[] streams, Signal[] hist, double[][] histBuf, AxisLimits[] limits)
            CreateLanePlots(Grid host, int n, int capacity, string[] names, bool wipe = false)
        {
            var plots = new WpfPlot[n];
            var streams = new DataStreamer[n];
            var hist = new Signal[n];
            var histBuf = Alloc(n, capacity);
            var limits = new AxisLimits[n];

            host.RowDefinitions.Clear();
            for (int i = 0; i < n; i++) host.RowDefinitions.Add(new RowDefinition());

            for (int i = 0; i < n; i++)
            {
                var border = new Border
                {
                    Background = PlotBg,
                    CornerRadius = new CornerRadius(6),
                    ClipToBounds = true,
                    Margin = new Thickness(0, i == 0 ? 0 : 4, 0, 0)
                };
                var ctrl = new WpfPlot();
                border.Child = ctrl;
                Grid.SetRow(border, i);
                host.Children.Add(border);

                var plt = ctrl.Plot;
                StyleDark(plt);
                ctrl.UserInputProcessor.Disable();
                plt.Axes.ContinuouslyAutoscale = false;

                var s = plt.Add.DataStreamer(capacity);
                if (wipe) s.ViewWipeRight();
                // EEG's lanes are fed every render frame (true 250 Hz pacing) — ScottPlot's own
                // built-in Scroll view allocates a brand new Pixel[capacity] array from scratch on
                // EVERY render call (verified in ScottPlot 5.1.59's own source), which only reaches
                // its full, sustained cost once the 10 s window first fills — before that "capacity"
                // portion is still ramping up from empty. That matches exactly what was reported:
                // smooth for the first 10 s, then stutter once continuous scrolling kicks in. Once
                // full, that's ~20KB x 4 lanes every frame, ~30x/s — real, sustained GC pressure.
                // PooledScrollView below is pixel-identical output, just reusing one buffer instead
                // of allocating a fresh one every frame. Bands/Cog push far less often (~4 Hz / ~2 Hz)
                // so they don't hit this and are left on the stock view.
                else if (host == EegPlotHost) s.ViewCustom(new PooledScrollView(s));
                else s.ViewScrollLeft();
                s.ManageAxisLimits = false;
                s.LineColor = Palette[i % Palette.Length];
                s.LineWidth = 1;
                s.LegendText = names[i];
                if (host == EegPlotHost)
                {
                    // Area-fill down to the zero baseline (the trace is normalised around 0 — see
                    // RecalibrateEegGain) makes amplitude swings read more prominently, standard for
                    // physiological waveforms. DataStreamer builds this from the same GetSegments()
                    // PooledScrollView already implements, per-segment — so it respects the NaN gap
                    // breaks automatically: a real gap is left unfilled too, not bridged over.
                    s.FillY = true;
                    s.FillYValue = 0;
                    s.FillYAboveColor = Palette[i % Palette.Length].WithAlpha(0.12);
                    s.FillYBelowColor = Palette[i % Palette.Length].WithAlpha(0.12);
                }

                // Only the bottom-most lane of a stack shows a time axis — one shared x-axis reads
                // cleaner than repeating it on every mini-plot. StyleDark's Frameless() call above
                // already hid it; re-show just this one panel. Tick VALUES are set every frame by
                // UpdateTimeAxis (see its own comment), not ScottPlot's own generator — the underlying
                // axis limits are sample indices, not seconds, and the window is scrolling in real
                // time regardless.
                if (i == n - 1)
                {
                    plt.Axes.Bottom.IsVisible = true;
                    plt.Axes.Bottom.TickLabelStyle.FontSize = 10;
                }

                var sig = plt.Add.Signal(histBuf[i]);
                sig.LineColor = Palette[i % Palette.Length];
                sig.LineWidth = 1;
                sig.LegendText = names[i];
                sig.IsVisible = false;

                var lim = new AxisLimits(0, capacity - 1, -AxisHalfHeight, AxisHalfHeight);
                plt.Axes.SetLimits(lim);
                plt.ShowLegend(Alignment.UpperRight);
                ctrl.Refresh();

                plots[i] = ctrl; streams[i] = s; hist[i] = sig; limits[i] = lim;
            }

            return (plots, streams, hist, histBuf, limits);
        }

        /// <summary>Real-valued streamers on a shared, fixed Y axis (0–100 cognitive metrics) —
        /// a genuine multi-line overlay comparison, not stacked lanes, so it keeps one shared plot.</summary>
        /// <summary>Same output as ScottPlot's own built-in <c>ViewScrollLeft</c> (new data enters on
        /// the right, oldest slides off the left) — reimplemented for two reasons. First, to fix an
        /// allocation ScottPlot 5.1.59's own <c>DataViews.Scroll</c> makes every single render call: a
        /// brand new <c>Pixel[capacity]</c> array, from scratch, regardless of whether anything
        /// actually needs re-copying. Second — the real point of this version — to draw an honest
        /// BREAK in the line wherever a sample is <c>NaN</c>, instead of either a fabricated value or
        /// a frozen scroll: FeedEegPending keeps advancing the timeline at the true real-time rate even
        /// during a genuine data gap (see its own comment), filling the gap with NaN placeholders
        /// rather than skipping the Add() call, so the trace keeps moving through real time while a
        /// clean gap — not invented data — sits exactly where data was actually missing.
        /// <see cref="_buf"/>/<see cref="_valid"/> are reused across calls, reallocated only when the
        /// sample count itself changes (during the first ~10 s while the window is filling; never
        /// again after). Coordinate math is copied exactly from ScottPlot 5.1.59's
        /// DataViews/Scroll.cs (newOnRight=true case only, since that's the only mode EEG's lanes
        /// use) — verified against ScottPlot's own GitHub source before writing this.</summary>
        private sealed class PooledScrollView : IDataStreamerView
        {
            public DataStreamer Streamer { get; }
            private Pixel[] _buf = Array.Empty<Pixel>();
            private bool[] _valid = Array.Empty<bool>();
            private readonly List<Pixel[]> _segments = new List<Pixel[]>(4);

            public PooledScrollView(DataStreamer streamer) => Streamer = streamer;

            public void Render(RenderPack rp)
            {
                foreach (var seg in GetSegments(rp))
                {
                    ScottPlot.Drawing.DrawLines(rp.Canvas, rp.Paint, seg, Streamer.LineStyle);
                    ScottPlot.Drawing.DrawMarkers(rp.Canvas, rp.Paint, seg, Streamer.MarkerStyle);
                }
            }

            public IReadOnlyList<Pixel[]> GetSegments(RenderPack rp)
            {
                var data = Streamer.Data;
                int cap = data.Length;
                int samples = Math.Min(data.CountTotal, cap);
                _segments.Clear();
                if (samples < 2) return _segments;

                if (_buf.Length != samples) { _buf = new Pixel[samples]; _valid = new bool[samples]; }

                int nextIdx = data.NextIndex;
                bool wrapped = samples == cap;
                int oldCnt = wrapped ? cap - nextIdx : 0;
                int xShift = cap - samples;   // newOnRight=true case of the original algorithm
                var axes = Streamer.Axes;

                int dst = 0;
                bool anyGap = false;
                if (wrapped && oldCnt > 0)
                {
                    for (int i = 0; i < oldCnt; i++, dst++)
                        anyGap |= !WritePixel(dst, data.Data[nextIdx + i], dst + xShift, data, axes);
                }
                for (int i = 0; i < nextIdx && dst < samples; i++, dst++)
                    anyGap |= !WritePixel(dst, data.Data[i], dst + xShift, data, axes);

                if (!anyGap)
                {
                    _segments.Add(_buf);
                    return _segments;
                }

                // A real gap is present in the visible window — split into contiguous valid runs so
                // the line breaks cleanly instead of drawing through the missing region. Only built on
                // frames that actually contain a gap; the gap-free path above stays allocation-free.
                int runStart = -1;
                for (int i = 0; i < samples; i++)
                {
                    if (_valid[i]) { if (runStart < 0) runStart = i; }
                    else if (runStart >= 0) { AddRun(runStart, i); runStart = -1; }
                }
                if (runStart >= 0) AddRun(runStart, samples);
                return _segments;
            }

            private bool WritePixel(int dst, double raw, int plotIdx, DataStreamerSource data, IAxes axes)
            {
                if (double.IsNaN(raw)) { _valid[dst] = false; return false; }
                double x = plotIdx * data.SamplePeriod + data.OffsetX;
                double y = raw + data.OffsetY;
                _buf[dst] = new Pixel(axes.GetPixelX(x), axes.GetPixelY(y));
                _valid[dst] = true;
                return true;
            }

            private void AddRun(int start, int endExclusive)
            {
                int len = endExclusive - start;
                if (len < 2) return;
                var run = new Pixel[len];
                Array.Copy(_buf, start, run, 0, len);
                _segments.Add(run);
            }
        }

        private static DataStreamer[] AddSharedAxisStreamers(WpfPlot ctrl, int n, int capacity, string[] names, double yMin, double yMax)
        {
            var plt = ctrl.Plot;
            StyleDark(plt);
            ctrl.UserInputProcessor.Disable();
            plt.Axes.ContinuouslyAutoscale = false;
            var streams = new DataStreamer[n];
            for (int i = 0; i < n; i++)
            {
                var s = plt.Add.DataStreamer(capacity);
                s.ViewScrollLeft();
                s.ManageAxisLimits = false;
                s.LineColor = Palette[i % Palette.Length];
                s.LineWidth = 1.5f;
                s.LegendText = names[i];
                streams[i] = s;
            }
            plt.ShowLegend(Alignment.UpperRight);
            return streams;
        }

        private static Signal[] AddHistSignalLanes(WpfPlot ctrl, double[][] buf, string[] names)
        {
            var plt = ctrl.Plot;
            var sigs = new Signal[buf.Length];
            for (int i = 0; i < buf.Length; i++)
            {
                var s = plt.Add.Signal(buf[i]);
                s.LineColor = Palette[i % Palette.Length];
                s.LineWidth = 1;
                s.LegendText = names[i];
                s.IsVisible = false;
                sigs[i] = s;
            }
            return sigs;
        }

        private static void StyleDark(Plot plt)
        {
            plt.FigureBackground.Color = new SPColor("#0B121C");
            plt.DataBackground.Color = new SPColor("#0B121C");
            plt.Axes.Color(new SPColor("#6B7A90"));
            plt.Grid.MajorLineColor = new SPColor("#1C2635");
            plt.Axes.Frameless();
            plt.Legend.FontColor = new SPColor("#E6EDF6");
            plt.Legend.BackgroundColor = new SPColor("#0B121C").WithAlpha(0.6);
            plt.Legend.OutlineColor = ScottPlot.Colors.Transparent;
        }

        // ── Channel selector (Fp1 · Fp2 · T4 · T3) for the bands tab ──
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

        // ── Scale selector (Auto · ±5 … ±100 µV) for the EEG tab ──
        private void BuildEegScaleSelector()
        {
            _eegScaleButtons = new Button[EegScalesUv.Length];
            for (int i = 0; i < EegScalesUv.Length; i++)
            {
                double halfUv = EegScalesUv[i];
                var btn = new Button
                {
                    Content = halfUv > 0 ? $"±{halfUv:0} µV" : "Auto",
                    FontSize = 11,
                    Padding = new Thickness(10, 3, 10, 3),
                    Margin = new Thickness(0, 0, 6, 0)
                };
                btn.Click += (_, __) =>
                {
                    _eegFixedHalfUv = halfUv;
                    UpdateEegScaleVisuals();
                    RebuildEegWindow();
                };
                _eegScaleButtons[i] = btn;
                EegScaleBar.Children.Add(btn);
            }
            UpdateEegScaleVisuals();
        }

        private void UpdateEegScaleVisuals()
        {
            for (int i = 0; i < _eegScaleButtons.Length; i++)
            {
                bool sel = EegScalesUv[i] == _eegFixedHalfUv;
                _eegScaleButtons[i].Background = sel ? AccentBrush : ChipBrush;
                _eegScaleButtons[i].Foreground = sel ? Brushes.White : LabelBrush;
                _eegScaleButtons[i].FontWeight = sel ? FontWeights.SemiBold : FontWeights.Normal;
            }
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
            DateTime nowUtc = DateTime.UtcNow;

            // How many samples SHOULD have arrived since the last call, given real elapsed wall-clock
            // time at the true 250 Hz hardware rate — if that's more than what this frame actually
            // delivered, the shortfall is a real gap (BLE loss between bursts), and gets written as
            // NaN placeholders BEFORE this frame's real samples, in both _rawFull (permanent history)
            // and _eegPending (live edge) — the single source of truth both views now share. Capped
            // to RawWindow so one very long pause (device disconnect, app minimised) can't wipe out
            // ~30 min of real ring-buffer history with placeholder padding.
            int gapSamples = 0;
            if (!_eegHasData)
            {
                // First real sample of the session (or since the last Clear) — start the pacing
                // clock fresh from right now, so FeedEegPending's next tick doesn't see a huge
                // "owed" backlog spanning all the idle time before the device connected, and no gap
                // is fabricated for that idle span either.
                _eegHasData = true;
                _sessionStartUtc = nowUtc;
                _eegFeedTicks = Environment.TickCount;
                _eegFeedRemainder = 0;
            }
            else if (_rawLastUtc.HasValue)
            {
                double elapsedMs = (nowUtc - _rawLastUtc.Value).TotalMilliseconds;
                int expected = (int)Math.Round(elapsedMs / EegSampleIntervalMs);
                gapSamples = Math.Max(0, Math.Min(expected - spc, RawWindow));
            }
            _rawLastUtc = nowUtc;
            if (gapSamples > 0) foreach (var hp in _displayHighPass) hp.Reset();

            // High-pass this frame first, so a short dropout before it can be drawn as a line to its
            // first sample (see GapFill). After a gap the filter restarts at 0, the trace's baseline.
            var fresh = new double[Channels][];
            var gapFill = new double[Channels][];
            for (int ch = 0; ch < Channels; ch++)
            {
                fresh[ch] = new double[spc];
                for (int i = 0; i < spc; i++) fresh[ch][i] = _displayHighPass[ch].Process(frame[ch * spc + i]);
                gapFill[ch] = GapFill(_lastHp[ch], fresh[ch][0], gapSamples);
                _lastHp[ch] = fresh[ch][spc - 1];
            }

            lock (_lock)
            {
                for (int g = 0; g < gapSamples; g++)
                {
                    for (int ch = 0; ch < Channels; ch++) _rawFull[ch][_rawFullHead] = gapFill[ch][g];
                    _rawFullHead = (_rawFullHead + 1) % RawFullCapacity;
                    if (_rawFullCount < RawFullCapacity) _rawFullCount++;
                }
                for (int i = 0; i < spc; i++)
                {
                    for (int ch = 0; ch < Channels; ch++) _rawFull[ch][_rawFullHead] = fresh[ch][i];
                    _rawFullHead = (_rawFullHead + 1) % RawFullCapacity;
                    if (_rawFullCount < RawFullCapacity) _rawFullCount++;
                }
            }

            if (!_eegTrack.Live) return;

            // Stage into the pending queues rather than pushing straight to the streamer —
            // FeedEegPending drains these at the true hardware rate so a whole ~200ms burst
            // doesn't appear as one instantaneous jump. See the field comment on _eegPending.
            for (int ch = 0; ch < Channels; ch++)
            {
                RecalibrateEegGain(ch);
                double mean = _eegBaseMean[ch], range = _eegBaseRange[ch];
                var q = _eegPending[ch];
                foreach (var v in gapFill[ch]) q.Enqueue(Normalize(v, mean, range));
                foreach (var v in fresh[ch]) q.Enqueue(Normalize(v, mean, range));
                // CompositionTarget.Rendering (and so FeedEegPending) pauses while the window is
                // minimised, but PushRaw keeps arriving — bound growth instead of buffering an
                // unminimise-and-dump backlog. Dropping the OLDEST queued samples is fine: they were
                // already written to _rawFull and are still fully available there for scrub/history.
                while (q.Count > RawWindow) q.Dequeue();
            }
        }

        /// <summary>Drains _eegPending into the live streamer at a constant, true-to-hardware pace
        /// (250 Hz) every render frame, instead of PushRaw dumping a whole ~200ms BLE burst into
        /// the streamer in one shot. Only paces while the EEG tab is actually visible — otherwise
        /// (nobody watching) it just drains everything immediately so the streamer stays current
        /// without wasting per-frame work on pacing nobody sees.
        ///
        /// Critically, the real-time clock below keeps advancing the streamer regardless of whether
        /// real data is available: every owed 250 Hz slot gets filled, either with a real dequeued
        /// sample or — if a dropout has left the queue empty — with the last value held (for up to
        /// MaxBridgedGapSamples, then NaN, which PooledScrollView draws as a break). That keeps the
        /// chart's timeline scrolling through an outage instead of visibly freezing.</summary>
        private void FeedEegPending()
        {
            if (!_eegTrack.Live || !_eegHasData) return;

            if (!EegPlot0Visible())
            {
                for (int ch = 0; ch < Channels; ch++)
                {
                    var q = _eegPending[ch];
                    while (q.Count > 0) AddEegSample(ch, q.Dequeue());
                }
                return;
            }

            int now = Environment.TickCount;
            double elapsedMs = now - _eegFeedTicks;
            _eegFeedTicks = now;
            double owed = elapsedMs / EegSampleIntervalMs + _eegFeedRemainder;
            int samples = Math.Max(0, (int)owed);
            _eegFeedRemainder = owed - samples;
            // A long pause (window minimised, debugger break, etc.) must not fire years of samples
            // at once — cap to what a queue could plausibly hold, and let the remainder drop rather
            // than fabricate a burst that never happened.
            samples = Math.Min(samples, RawWindow);

            // Tick-major (not channel-major): all 4 channels are enqueued together in PushRaw (real
            // gaps are pre-filled as NaN there too — see PushRaw), so channel 0's fed value is
            // representative of whether THIS tick is a real gap tick. Per-channel AddEegSample calls
            // are independent either way, so this reorder changes nothing about what each streamer
            // receives. The double.NaN fallback below only fires if the queue is unexpectedly empty
            // (display pacing briefly outran arrival) — a safety net, not the primary gap signal.
            for (int i = 0; i < samples; i++)
            {
                // No data yet for this tick (a dropout still in progress): hold the last value so
                // the line stays joined, up to the same limit as a bridged gap; past it, break.
                bool waiting = _eegPending[0].Count == 0;
                _heldTicks = waiting ? _heldTicks + 1 : 0;
                bool hold = _heldTicks <= MaxBridgedGapSamples;
                for (int ch = 0; ch < Channels; ch++)
                {
                    var q = _eegPending[ch];
                    double v = q.Count > 0 ? q.Dequeue() : (hold ? _lastFed[ch] : double.NaN);
                    if (!double.IsNaN(v)) _lastFed[ch] = v;
                    AddEegSample(ch, v);
                }
            }
        }

        /// <summary>ITP2 #5 — eye-blink marker: a dashed vertical line on the Fp1/Fp2 lanes only
        /// (indices 0/1 — see BridgeController.ChannelLabels), a true instantaneous transient
        /// rather than a window. Items[2]/Items[3] (T4/T3) are left null — UpdateEegMarkers/
        /// RebuildEegWindow/Clear all null-check before touching a lane's item, since this is the
        /// first marker type that doesn't populate all 4 lanes.</summary>
        private EegMarker CreateBlinkMarker(DateTime shownAtUtc) =>
            CreateArtefactMarker(shownAtUtc, firstLane: 0, BlinkLineColor, "Blink");   // Fp1, Fp2

        /// <summary>ITP2 #5 — teeth-clench marker: same shape as the blink marker (a dashed
        /// vertical line at the detected onset, named at the top) on the T4/T3 lanes only
        /// (indices 2/3). Items[0]/Items[1] (Fp1/Fp2) left null.</summary>
        private EegMarker CreateClenchMarker(DateTime shownAtUtc) =>
            CreateArtefactMarker(shownAtUtc, firstLane: 2, ClenchLineColor, "Clench"); // T4, T3

        /// <summary>A dashed vertical line across two adjacent lanes, with <paramref name="text"/>
        /// printed at the top of the upper lane, just right of the line.
        ///
        /// ScottPlot draws an axis line's label OUTSIDE the data area by default (below it, or above
        /// it with LabelOppositeAxis). These lanes are frameless, so there is no room there and the
        /// label was clipped. With LabelOppositeAxis the anchor is the data area's top edge; aligning
        /// the label UpperLeft from that anchor hangs it down into the plot instead.</summary>
        private EegMarker CreateArtefactMarker(DateTime shownAtUtc, int firstLane, SPColor color, string text)
        {
            var marker = new EegMarker
            {
                ShownAtUtc = shownAtUtc,
                EffectiveEndUtc = shownAtUtc,
                IsPhase = false,
                Items = new IPlottable[Channels],
            };
            for (int i = firstLane; i <= firstLane + 1; i++)
            {
                var line = _eegPlots[i].Plot.Add.VerticalLine(0, 1.5f, color.WithAlpha(0.85), LinePattern.Dashed);
                SetTopLabel(line, i == firstLane ? text : null, color, bold: true);   // label once, at the top of the pair
                marker.Items[i] = line;
            }
            return marker;
        }

        /// <summary>Prints <paramref name="text"/> at the top of the lane, just right of the line, or
        /// no label when it's null. ScottPlot draws an axis line's label OUTSIDE the data area by
        /// default (below it, or above it with LabelOppositeAxis); these lanes are frameless, so
        /// there is no room there and the label was clipped. With LabelOppositeAxis the anchor is
        /// the data area's top edge, and aligning UpperLeft from it hangs the label into the plot.</summary>
        private static void SetTopLabel(VerticalLine line, string text, SPColor color, bool bold)
        {
            line.LabelStyle.Text = text ?? string.Empty;
            if (text == null) return;
            line.LabelStyle.ForeColor = color;
            line.LabelStyle.BackgroundColor = new SPColor("#0B121C").WithAlpha(0.75); // PlotBg: readable over traces
            line.LabelStyle.FontSize = 10;
            line.LabelStyle.Bold = bold;
            line.LabelStyle.PixelPadding = new PixelPadding(3, 3, 1, 1);
            line.LabelOppositeAxis = true;
            line.ManualLabelAlignment = Alignment.UpperLeft;
        }

        /// <summary>ITP2 #5 — live-chart-only annotation (not persisted to the DB) for a detected
        /// eye-blink artifact on Fp1/Fp2. See BridgeController.DetectBlink/BlinkDetected.</summary>
        public void PushBlinkMarker(DateTime shownAtUtc) => _eegMarkers.Add(CreateBlinkMarker(shownAtUtc));

        /// <summary>ITP2 #5 — live-chart-only annotation (not persisted to the DB) for a detected
        /// teeth-clench/EMG artifact on T3/T4. See BridgeController.DetectClench/ClenchDetected.</summary>
        public void PushClenchMarker(DateTime shownAtUtc) => _eegMarkers.Add(CreateClenchMarker(shownAtUtc));

        /// <summary>Pushes one real sample into an EEG lane's live streamer, hard-clearing the
        /// buffer (full blank, not an in-place overwrite) the instant it's full rather than letting
        /// ScottPlot's built-in wipe view silently start painting new data over the tail end of the
        /// previous sweep. See the _eegWipeCount field comment.</summary>
        private void AddEegSample(int ch, double value)
        {
            if (EegFlushOnFull && _eegWipeCount[ch] >= RawWindow)
            {
                _eegStream[ch].Clear();
                _eegWipeCount[ch] = 0;
            }
            _eegStream[ch].Add(value);
            _eegWipeCount[ch]++;
        }

        /// <summary>Recalibrates channel <paramref name="ch"/>'s gain from a representative window
        /// of FULL-SESSION HISTORY (the last RawWindow samples — the same span the chart shows),
        /// not from the tiny newly-arrived batch. A batch spans well under a second, far too short
        /// to capture a channel's real swing (an eye blink or an alpha cycle can easily run
        /// longer), so calibrating off it routinely undershot the true range.</summary>
        private void RecalibrateEegGain(int ch)
        {
            if (_eegFixedHalfUv > 0)
            {
                // Pinned scale: ±_eegFixedHalfUv µV fills ±NormAmp of the lane.
                _eegBaseMean[ch] = 0;
                _eegBaseRange[ch] = _eegFixedHalfUv / MicrovoltsPerCount;
                return;
            }
            // Scans the ring buffer directly (same window SliceFromRing would extract, backOffset=0)
            // instead of allocating a fresh double[RawWindow] copy every call. This runs 4x per
            // PushRaw burst (~20x/s), so the old version churned ~400KB/s of short-lived garbage —
            // enough to periodically trigger a GC pause that showed up as a chart stutter.
            double mean = 0, min = double.MaxValue, max = double.MinValue;
            int n, valid = 0;
            lock (_lock)
            {
                var ring = _rawFull[ch];
                int cap = ring.Length;
                n = Math.Min(RawWindow, _rawFullCount);
                int end = _rawFullHead; // one past the last included sample
                for (int j = 0; j < n; j++)
                {
                    double v = ring[((end - 1 - j) % cap + cap) % cap];
                    if (double.IsNaN(v)) continue;   // gap placeholder — must not poison the gain estimate
                    mean += v; if (v < min) min = v; if (v > max) max = v;
                    valid++;
                }
            }
            if (valid == 0) return;   // window is nothing but gap right now — keep the previous baseline
            _eegBaseMean[ch] = mean / valid;
            _eegBaseRange[ch] = Math.Max(1e-9, max - min);
        }

        private static double Normalize(double raw, double baseMean, double baseRange) =>
            (raw - baseMean) / Math.Max(1e-9, baseRange) * NormAmp;

        public void PushBands(BandPowers[] powers)
        {
            if (powers == null || powers.Length == 0) return;
            // powers is per channel (Fp1, Fp2, T4, T3), each with Delta/Theta/Alpha/Beta/Gamma.
            int nch = Math.Min(powers.Length, BandSources);
            for (int c = 0; c < nch; c++)
            {
                var p = powers[c];
                double[] vals = { p.Delta, p.Theta, p.Alpha, p.Beta, p.Gamma };
                for (int b = 0; b < Bands; b++)
                {
                    _bandLatest[c][b] = vals[b];
                    _bandFull[c][b][_bandFullHead] = vals[b];
                }
            }
            _bandFullHead = (_bandFullHead + 1) % BandFullCapacity;
            if (_bandFullCount < BandFullCapacity) _bandFullCount++;

            if (!_bandTrack.Live) return;
            for (int b = 0; b < Bands; b++)
            {
                double v = _bandLatest[_selectedSource][b];
                BlendBaseline(_bandBaseMean, _bandBaseRange, _selectedSource, b, v);
                _bandStream[b].Add(Normalize(v, _bandBaseMean[_selectedSource, b], _bandBaseRange[_selectedSource, b]));
            }
        }

        /// <summary>Adds newly-discovered session events (images/questions/baseline phases) as
        /// markers on all 4 EEG Waves lanes. Positions are set on the next UpdateEegMarkers tick, not
        /// here — they're recomputed every frame from the real timestamp, same as everything else on
        /// the live edge.</summary>
        public void PushEvents(List<SessionEventMarker> events)
        {
            if (events == null) return;
            foreach (var e in events)
            {
                var marker = new EegMarker
                {
                    ShownAtUtc = e.ShownAtUtc,
                    IsPhase = e.IsPhase,
                    EffectiveEndUtc = e.IsPhase
                        ? (e.HiddenAtUtc ?? e.ShownAtUtc.AddSeconds(e.PhaseDurationSeconds))
                        : e.ShownAtUtc,
                    Items = new IPlottable[Channels],
                };
                for (int i = 0; i < Channels; i++)
                {
                    var plt = _eegPlots[i].Plot;
                    if (e.IsPhase)
                    {
                        var span = plt.Add.HorizontalSpan(0, 0, PhaseSpanColor.WithAlpha(0.12));
                        span.LineColor = ScottPlot.Colors.Transparent;
                        // AxisSpan.Label is deprecated in favour of LegendText, but that would just
                        // add a row to the existing per-channel legend instead of labelling the span
                        // where it actually is — deliberately keeping the inline label here.
#pragma warning disable CS0618
                        span.Label.Text = e.Label;
                        span.Label.ForeColor = PhaseSpanColor;
                        span.Label.FontSize = 9;
                        span.Label.Bold = false;
#pragma warning restore CS0618
                        marker.Items[i] = span;
                    }
                    else
                    {
                        var line = plt.Add.VerticalLine(0, 1, MarkerLineColor.WithAlpha(0.6), LinePattern.Dashed);
                        // Name the image once, at the top of the first lane (Fp1).
                        SetTopLabel(line, i == 0 ? e.Label : null, MarkerLineColor, bold: false);
                        marker.Items[i] = line;
                    }
                }
                _eegMarkers.Add(marker);
            }
        }

        /// <summary>Repositions every active EEG marker from its real timestamp every frame, using
        /// the same 250 Hz virtual clock as the live trace itself (exact now that FeedEegPending paces
        /// gaps with NaN instead of skipping them — see its comment) — so a marker scrolls through the
        /// window in lockstep with the data it annotates, not on its own separate clock. Only runs
        /// while live; scrubbed history keeps whatever positions markers had when scrubbing began
        /// (the historical Signal view isn't on this same real-time coordinate system).</summary>
        private void UpdateEegMarkers()
        {
            if (!_eegTrack.Live || _eegMarkers.Count == 0) return;
            DateTime now = DateTime.UtcNow;
            double staleSeconds = RawWindow / 250.0 * 1.5;   // window width + slack before pruning

            for (int m = _eegMarkers.Count - 1; m >= 0; m--)
            {
                var mk = _eegMarkers[m];
                double endAgeSeconds = (now - mk.EffectiveEndUtc).TotalSeconds;
                if (endAgeSeconds > staleSeconds)
                {
                    // ITP2 #5's blink/clench markers only populate 2 of the 4 lanes (Fp1/Fp2 or
                    // T4/T3) — the other two stay null and must be skipped here.
                    for (int i = 0; i < Channels; i++)
                        if (mk.Items[i] != null) _eegPlots[i].Plot.Remove(mk.Items[i]);
                    _eegMarkers.RemoveAt(m);
                    continue;
                }

                double startAgeSeconds = (now - mk.ShownAtUtc).TotalSeconds;
                double startX = (RawWindow - 1) - startAgeSeconds * 250.0;
                if (mk.IsPhase)
                {
                    double endX = (RawWindow - 1) - endAgeSeconds * 250.0;
                    for (int i = 0; i < Channels; i++)
                    {
                        if (mk.Items[i] == null) continue;
                        var span = (HorizontalSpan)mk.Items[i];
                        span.X1 = startX;
                        span.X2 = endX;
                    }
                }
                else
                {
                    for (int i = 0; i < Channels; i++)
                        if (mk.Items[i] != null) ((VerticalLine)mk.Items[i]).X = startX;
                }
            }
        }

        /// <summary>Labels a tab's stack with real elapsed session time (m:ss). The underlying axis
        /// coordinates are always plain sample indices (0..capacity-1), so tick VALUES have to be
        /// projected into that space from real time each call — same direction of math as
        /// UpdateEegMarkers but inverted (there a known timestamp becomes an x position; here a chosen
        /// "nice" time becomes one).
        ///
        /// Ticks are computed explicitly (not left to ScottPlot's own automatic generator) so the
        /// spacing is chosen in REAL SECONDS, snapped to a round interval — letting the generator pick
        /// spacing in raw sample-index units risked a step smaller than FormatElapsed's 1-second label
        /// resolution, which showed as several consecutive ticks all printing the identical rounded
        /// time (e.g. "1:05" five times in a row before "1:06"). The same computed positions are then
        /// applied to EVERY lane in <paramref name="plots"/>, not just the bottom one — only the
        /// bottom-most lane's axis panel is IsVisible (see CreateLanePlots), so the others' tick text
        /// never renders, but ScottPlot's Grid draws vertical gridlines from each lane's own tick
        /// generator regardless of panel visibility. Giving every lane the identical tick set keeps
        /// their gridlines aligned; leaving upper lanes on the default generator (as an earlier version
        /// did) let it pick different "nice" positions than the bottom lane's manual ticks, visibly
        /// mismatching the stack's background lines.
        ///
        /// While live, the reference "now" and (for Bands/Cog) the empirically-measured rate are both
        /// recomputed fresh every call, so the axis genuinely scrolls in real time. The instant a tab
        /// enters scrub, both are frozen (see SetScrubOffset) and reused unchanged for as long as the
        /// tab stays scrubbed — otherwise the real clock kept advancing underneath a supposedly-static
        /// historical view, visibly dragging the ticks across a trace that wasn't actually moving.
        /// Further scrub moves only change ScrubOffset, shifting which part of that one frozen snapshot
        /// is on screen, exactly like the (already-static) data itself.</summary>
        private void UpdateTimeAxis(WpfPlot[] plots, Track track, int capacity)
        {
            if (_sessionStartUtc == null) return;

            DateTime refNow = track.Live ? DateTime.UtcNow : track.FrozenNowUtc;
            double rate = track.Live ? SamplesPerSecondFor(track) : track.FrozenSamplesPerSecond;
            if (rate <= 0)
            {
                foreach (var p in plots) p.Plot.Axes.Bottom.SetTicks(Array.Empty<double>(), Array.Empty<string>());
                return;
            }

            double rightEdgeSeconds = (refNow - _sessionStartUtc.Value).TotalSeconds - track.ScrubOffset / rate;
            double windowSeconds = capacity / rate;
            double leftEdgeSeconds = rightEdgeSeconds - windowSeconds;
            double interval = NiceTickIntervalSeconds(windowSeconds);

            var xs = new List<double>();
            var labels = new List<string>();
            double firstTick = Math.Ceiling(Math.Max(0, leftEdgeSeconds) / interval) * interval;
            for (double t = firstTick; t <= rightEdgeSeconds + 1e-6; t += interval)
            {
                xs.Add((capacity - 1) - (rightEdgeSeconds - t) * rate);
                labels.Add(FormatElapsed(t));
            }
            var xsArr = xs.ToArray();
            var labelsArr = labels.ToArray();
            var blank = new string[labels.Count];   // upper lanes: same gridline positions, no visible text (their axis panel is hidden anyway)
            for (int i = 0; i < plots.Length; i++)
                plots[i].Plot.Axes.Bottom.SetTicks(xsArr, i == plots.Length - 1 ? labelsArr : blank);
        }

        /// <summary>Picks a round tick spacing (in real seconds) that lands roughly 5 ticks across the
        /// given window — EEG's 10 s window wants ~2 s ticks, but Bands/Cog's ~100-200 s window would
        /// be unreadably dense at the same fixed interval, so this scales instead of hard-coding one.</summary>
        private static double NiceTickIntervalSeconds(double windowSeconds)
        {
            double[] niceSteps = { 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900 };
            double raw = windowSeconds / 5.0;
            foreach (var step in niceSteps) if (step >= raw) return step;
            return niceSteps[niceSteps.Length - 1];
        }

        private static string FormatElapsed(double totalSeconds)
        {
            int s = (int)Math.Round(Math.Max(0, totalSeconds));
            return $"{s / 60}:{s % 60:D2}";
        }

        /// <summary>Recomputes each lane's scale-bar label from that channel's current auto-gain
        /// range — see the _eegScaleBars field comment for why a fixed label would be dishonest here.
        /// Throttled so the number doesn't visibly jitter with every recalibration.</summary>
        private void UpdateScaleBars()
        {
            int now = Environment.TickCount;
            if (now - _scaleBarLastUpdateTicks < ScaleBarUpdateIntervalMs) return;
            _scaleBarLastUpdateTicks = now;
            for (int ch = 0; ch < Channels; ch++)
            {
                double uv = ScaleBarHeightUnits * _eegBaseRange[ch] * MicrovoltsPerCount;
                _eegScaleBars[ch].YLabel = $"≈{uv:F0} µV";
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

            if (!_cogTrack.Live) return;
            for (int c = 0; c < Cogs; c++)
                _cogStream[c].Add(double.IsNaN(v[c]) ? 0 : v[c]);
        }

        public void Clear()
        {
            lock (_lock) { _rawFullHead = 0; _rawFullCount = 0; }
            _bandFullHead = _bandFullCount = _cogFullHead = _cogFullCount = 0;
            for (int s = 0; s < BandSources; s++)
                for (int b = 0; b < Bands; b++) { _bandLatest[s][b] = 0; _bandBaseMean[s, b] = 0; _bandBaseRange[s, b] = 1; }
            for (int c = 0; c < Cogs; c++) _cogLatest[c] = double.NaN;
            for (int ch = 0; ch < Channels; ch++) { _eegBaseMean[ch] = 0; _eegBaseRange[ch] = 1; }
            foreach (var hp in _displayHighPass) hp.Reset();
            foreach (var q in _eegPending) q.Clear();
            _eegHasData = false;
            _rawLastUtc = null;
            _sessionStartUtc = null;
            foreach (var p in _eegPlots) p.Plot.Axes.Bottom.SetTicks(Array.Empty<double>(), Array.Empty<string>());
            foreach (var p in _bandPlots) p.Plot.Axes.Bottom.SetTicks(Array.Empty<double>(), Array.Empty<string>());
            CogPlot.Plot.Axes.Bottom.SetTicks(Array.Empty<double>(), Array.Empty<string>());
            _eegFeedTicks = Environment.TickCount;
            _eegFeedRemainder = 0;

            foreach (var s in _eegStream) s.Clear();
            Array.Clear(_eegWipeCount, 0, _eegWipeCount.Length);
            foreach (var mk in _eegMarkers)
                for (int i = 0; i < Channels; i++)
                    if (mk.Items[i] != null) _eegPlots[i].Plot.Remove(mk.Items[i]);
            _eegMarkers.Clear();
            for (int ch = 0; ch < Channels; ch++) { _lastHp[ch] = double.NaN; _lastFed[ch] = double.NaN; }
            _heldTicks = 0;
            for (int ch = 0; ch < Channels; ch++)
            {
                foreach (var seg in _eegHistSegments[ch]) _eegPlots[ch].Plot.Remove(seg);
                _eegHistSegments[ch].Clear();
            }
            foreach (var s in _bandStream) s.Clear();
            foreach (var s in _cogStream) s.Clear();
            ResetTrack(_eegTrack); ResetTrack(_bandTrack); ResetTrack(_cogTrack);
            BtnEegLive.Visibility = BtnBandLive.Visibility = BtnCogLive.Visibility = Visibility.Collapsed;
            SetEegHistVisible(live: true);
            SetHistVisible(_bandStream, _bandHistSig, live: true);
            SetHistVisible(_cogStream, _cogHistSig, live: true);

            ZeroHistLanes(_eegHistBuf);
            ZeroHistLanes(_bandHistBuf);
            foreach (var buf in _cogHistBuf) Array.Clear(buf, 0, buf.Length);
            foreach (var p in _eegPlots) p.Refresh();
            foreach (var p in _bandPlots) p.Refresh();
            CogPlot.Refresh();
        }

        private static void ResetTrack(Track t)
        {
            t.Live = true; t.ScrubOffset = 0; t.Dragging = false; t.DragEngaged = false;
            t.FrozenNowUtc = default; t.FrozenSamplesPerSecond = 0;
        }

        private static void ZeroHistLanes(double[][] buf)
        {
            foreach (var lane in buf) Array.Clear(lane, 0, lane.Length);
        }

        private static void SetHistVisible(DataStreamer[] streams, Signal[] hist, bool live)
        {
            foreach (var s in streams) s.IsVisible = live;
            foreach (var s in hist) s.IsVisible = !live;
        }

        /// <summary>EEG-lane equivalent of <see cref="SetHistVisible"/> — toggles the live
        /// DataStreamer vs. the segment-based history view (see RebuildEegHistSegments) instead of a
        /// plain Signal, since EEG's history can contain real NaN gap breaks a Signal can't render.</summary>
        private void SetEegHistVisible(bool live)
        {
            for (int ch = 0; ch < Channels; ch++)
            {
                _eegStream[ch].IsVisible = live;
                foreach (var seg in _eegHistSegments[ch]) seg.IsVisible = !live;
            }
        }

        /// <summary>EMA blend toward a freshly-observed value — slow, so a lane's gain drifts
        /// rather than jumps (bands arrive one discrete sample at a time, ~1 Hz).</summary>
        private static void BlendBaseline(double[,] baseMean, double[,] baseRange, int row, int col, double obs)
        {
            double m = baseMean[row, col], r = baseRange[row, col];
            if (r <= 0) { baseMean[row, col] = obs; baseRange[row, col] = Math.Max(1e-9, Math.Abs(obs)); return; }
            double dev = Math.Abs(obs - m);
            baseMean[row, col] = m * (1 - BaselineAlpha) + obs * BaselineAlpha;
            baseRange[row, col] = r * (1 - BaselineAlpha) + Math.Max(dev, r * 0.5) * BaselineAlpha;
        }

        private void RefreshLabels()
        {
            if (BandPlot0Visible())
                for (int b = 0; b < Bands; b++)
                    _bandStream[b].LegendText = _bandFullCount == 0 ? BandNames[b] : $"{BandNames[b]}  {Fmt(_bandLatest[_selectedSource][b])}";
            else if (CogPlot.IsVisible)
                for (int c = 0; c < Cogs; c++)
                    _cogStream[c].LegendText = double.IsNaN(_cogLatest[c]) ? CogNames[c] : $"{CogNames[c]}  {Fmt(_cogLatest[c])}";
        }

        // ── Scrubbing: drag / Ctrl+wheel / scrollbar, all driving the same per-tab Track ────────
        private void HookScrub(WpfPlot[] ctrls, Track track, int capacity, Action rebuild)
        {
            Button LiveBtn() => track == _eegTrack ? BtnEegLive : track == _bandTrack ? BtnBandLive : BtnCogLive;

            foreach (var ctrl in ctrls)
            {
                ctrl.PreviewMouseLeftButtonDown += (s, e) =>
                {
                    track.Dragging = true;
                    track.DragEngaged = false;
                    track.DragStartX = e.GetPosition(ctrl).X;
                    track.DragStartOffset = track.ScrubOffset;
                    ctrl.CaptureMouse();
                };
                ctrl.PreviewMouseMove += (s, e) =>
                {
                    if (!track.Dragging) return;
                    double dx = e.GetPosition(ctrl).X - track.DragStartX;
                    // Require real, deliberate movement before this counts as a scrub — otherwise
                    // an ordinary click (mouse-down/up rarely land on the exact same pixel) reads as a drag.
                    if (!track.DragEngaged)
                    {
                        if (Math.Abs(dx) < DragThresholdPx) return;
                        track.DragEngaged = true;
                    }
                    double pxPerSample = Math.Max(0.5, ctrl.ActualWidth / capacity);
                    int deltaSamples = (int)Math.Round(dx / pxPerSample);
                    // Dragging the content right (positive dx) should reveal OLDER data, i.e. increase offset.
                    SetScrubOffset(track, track.DragStartOffset + deltaSamples, capacity, rebuild, LiveBtn(), MaxOffsetFor(track, capacity));
                };
                ctrl.PreviewMouseLeftButtonUp += (s, e) => { track.Dragging = false; ctrl.ReleaseMouseCapture(); };
                ctrl.PreviewMouseWheel += (s, e) =>
                {
                    // Ctrl+wheel to scrub, like zoom shortcuts elsewhere — plain scrolling with the
                    // mouse resting over a (now full-bleed) chart must never silently freeze the live view.
                    if ((Keyboard.Modifiers & ModifierKeys.Control) == 0) return;
                    int step = Math.Max(1, capacity / 20);
                    SetScrubOffset(track, track.ScrubOffset - Math.Sign(e.Delta) * step, capacity, rebuild, LiveBtn(), MaxOffsetFor(track, capacity));
                    e.Handled = true;
                };
            }
        }

        private int MaxOffsetFor(Track track, int capacity)
        {
            int fullCount = track == _eegTrack ? _rawFullCount : track == _bandTrack ? _bandFullCount : _cogFullCount;
            return Math.Max(0, fullCount - capacity);
        }

        private void SetScrubOffset(Track track, int offset, int capacity, Action rebuild, Button liveBtn, int maxOffset)
        {
            offset = Math.Max(0, Math.Min(maxOffset, offset));
            if (offset == track.ScrubOffset && track.Live == (offset == 0)) return;
            bool enteringScrub = track.Live && offset != 0;
            if (enteringScrub)
            {
                // Freeze the reference clock the moment this tab leaves live mode — further scrub
                // moves within this session only change ScrubOffset, not this snapshot, so the whole
                // browse stays anchored to one static "now" instead of drifting with the real clock.
                track.FrozenNowUtc = DateTime.UtcNow;
                track.FrozenSamplesPerSecond = SamplesPerSecondFor(track);
            }
            track.ScrubOffset = offset;
            track.Live = offset == 0;
            liveBtn.Visibility = track.Live ? Visibility.Collapsed : Visibility.Visible;
            rebuild();
        }

        /// <summary>Samples-per-second for a track's coordinate space. EEG's is a true hardware
        /// constant (see EegSampleIntervalMs); Bands/Cog have no fixed cadence — each PushBands/
        /// SetCognitive call is just "whenever the next real value arrived" — so their rate is
        /// measured empirically from real counts vs. real elapsed time rather than assumed, which
        /// would risk mislabelling the axis with a rate no faster/slower than reality actually ran.
        /// Self-corrects as more of the session accumulates.</summary>
        private double SamplesPerSecondFor(Track track)
        {
            if (track == _eegTrack) return 250.0;
            if (_sessionStartUtc == null) return 0;
            double elapsed = (DateTime.UtcNow - _sessionStartUtc.Value).TotalSeconds;
            if (elapsed <= 0) return 0;
            int count = track == _bandTrack ? _bandFullCount : _cogFullCount;
            return count < 2 ? 0 : count / elapsed;
        }

        private void JumpToLive(Track track, Action rebuild, Button liveBtn)
        {
            track.ScrubOffset = 0;
            track.Live = true;
            liveBtn.Visibility = Visibility.Collapsed;
            rebuild();
        }

        /// <summary>Keeps a tab's scrollbar in sync with its Track: grows Maximum as more session
        /// history accumulates, and reflects the current scrub position. Value increases toward the
        /// LEFT (0 = live edge, at the right) to match "scroll up/left = further into history," the
        /// usual reading direction for a scrollback log. Guarded against feeding back into
        /// <see cref="OnScrollBarValueChanged"/> — see <see cref="_syncingScrollbar"/>.</summary>
        private void SyncScrollbar(ScrollBar sb, Track track, int capacity)
        {
            int maxOffset = MaxOffsetFor(track, capacity);
            _syncingScrollbar = true;
            sb.Minimum = 0;
            sb.Maximum = maxOffset;
            sb.ViewportSize = capacity;
            sb.Value = maxOffset - track.ScrubOffset;
            _syncingScrollbar = false;
        }

        private void OnScrollBarValueChanged(ScrollBar sb, Track track, int capacity, Action rebuild, Button liveBtn)
        {
            if (_syncingScrollbar) return;
            int maxOffset = (int)sb.Maximum;
            int offset = maxOffset - (int)Math.Round(sb.Value);
            SetScrubOffset(track, offset, capacity, rebuild, liveBtn, maxOffset);
        }

        private void EegScrollBar_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e) =>
            OnScrollBarValueChanged(EegScrollBar, _eegTrack, RawWindow, RebuildEegWindow, BtnEegLive);
        private void BandScrollBar_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e) =>
            OnScrollBarValueChanged(BandScrollBar, _bandTrack, Hist, RebuildBandWindow, BtnBandLive);
        private void CogScrollBar_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e) =>
            OnScrollBarValueChanged(CogScrollBar, _cogTrack, Hist, RebuildCogWindow, BtnCogLive);

        // ── Rebuild a display window from full history (mode changes, source switch, scrub move) ─
        private void RebuildEegWindow()
        {
            // Whatever's still queued in _eegPending is now stale relative to the reslice/reseed
            // about to happen (either direction — entering scrub or resuming live) — drop it rather
            // than let FeedEegPending replay it on top of freshly-seeded data.
            foreach (var q in _eegPending) q.Clear();
            _eegFeedRemainder = 0;

            if (_eegTrack.Live)
            {
                // Resuming live: reseed each streamer from fresh history so it doesn't jump from
                // wherever scrubbing left off, then show it again.
                _eegFeedTicks = Environment.TickCount;
                for (int ch = 0; ch < Channels; ch++)
                {
                    double[] recent;
                    lock (_lock) recent = SliceFromRing(_rawFull[ch], _rawFullHead, _rawFullCount, RawWindow, 0);
                    RecalibrateEegGain(ch);
                    _eegStream[ch].Clear();
                    _eegWipeCount[ch] = 0;
                    foreach (var v in recent) AddEegSample(ch, Normalize(v, _eegBaseMean[ch], _eegBaseRange[ch]));
                }
                SetEegHistVisible(live: true);
            }
            else
            {
                for (int ch = 0; ch < Channels; ch++)
                {
                    double[] slice;
                    lock (_lock) slice = SliceFromRing(_rawFull[ch], _rawFullHead, _rawFullCount, RawWindow, _eegTrack.ScrubOffset);
                    SeedHistLane(slice, _eegHistBuf[ch], RawWindow, ref _eegBaseMean[ch], ref _eegBaseRange[ch],
                        _eegFixedHalfUv > 0 ? _eegFixedHalfUv / MicrovoltsPerCount : 0);
                    RebuildEegHistSegments(ch);
                }
                SetEegHistVisible(live: false);
            }

            // Markers (session events, blinks, clenches) are only ever repositioned while live (see
            // UpdateEegMarkers) — their pixel positions are frozen the instant scrubbing starts, but
            // the axis coordinate space they were drawn in is reused for the historical Signal view
            // too, so a left-in-place marker would visually overlap whatever real data is now shown
            // at that same x position. Hide them for the duration of the scrub; they're accurate
            // again the moment live resumes (RefreshVisibleTab calls UpdateEegMarkers every frame).
            foreach (var mk in _eegMarkers)
                for (int i = 0; i < Channels; i++)
                    if (mk.Items[i] != null) mk.Items[i].IsVisible = _eegTrack.Live;

            foreach (var p in _eegPlots) p.Refresh();
        }

        /// <summary>Rebuilds channel <paramref name="ch"/>'s historical-view line from scratch as a
        /// set of small <see cref="Scatter"/> segments, one per contiguous run of real (non-NaN)
        /// samples in <see cref="_eegHistBuf"/> — <see cref="Signal"/> draws one continuous path with
        /// no gap-break support, so a NaN gap placeholder in the buffer would otherwise just get
        /// silently skipped/glitched over, reproducing the exact "gap closes up" bug this replaces.
        /// Only called on a scrub move (drag/wheel/scrollbar), not every frame, so rebuilding from
        /// scratch each time is cheap enough — nothing like the live edge's per-frame budget.</summary>
        private void RebuildEegHistSegments(int ch)
        {
            var plt = _eegPlots[ch].Plot;
            foreach (var seg in _eegHistSegments[ch]) plt.Remove(seg);
            _eegHistSegments[ch].Clear();

            double[] buf = _eegHistBuf[ch];
            int n = buf.Length;
            int runStart = -1;
            for (int i = 0; i <= n; i++)
            {
                bool validHere = i < n && !double.IsNaN(buf[i]);
                if (validHere) { if (runStart < 0) runStart = i; }
                else if (runStart >= 0)
                {
                    AddEegHistSegment(ch, plt, buf, runStart, i - runStart);
                    runStart = -1;
                }
            }
        }

        private void AddEegHistSegment(int ch, Plot plt, double[] buf, int start, int len)
        {
            if (len < 2) return;
            var xs = new double[len];
            var ys = new double[len];
            for (int j = 0; j < len; j++) { xs[j] = start + j; ys[j] = buf[start + j]; }
            var line = plt.Add.Scatter(xs, ys);
            line.LineColor = Palette[ch % Palette.Length];
            line.LineWidth = 1;
            line.MarkerSize = 0;
            // Only the first segment carries the lane name — otherwise a multi-gap window would add
            // one duplicate legend row per segment.
            line.LegendText = _eegHistSegments[ch].Count == 0 ? ChNames[ch] : string.Empty;
            _eegHistSegments[ch].Add(line);
        }

        private void RebuildBandWindow()
        {
            if (_bandTrack.Live)
            {
                for (int b = 0; b < Bands; b++)
                {
                    double[] recent = SliceFromRing(_bandFull[_selectedSource][b], _bandFullHead, _bandFullCount, Hist, 0);
                    _bandStream[b].Clear();
                    foreach (var v in recent)
                    {
                        BlendBaseline(_bandBaseMean, _bandBaseRange, _selectedSource, b, v);
                        _bandStream[b].Add(Normalize(v, _bandBaseMean[_selectedSource, b], _bandBaseRange[_selectedSource, b]));
                    }
                }
                SetHistVisible(_bandStream, _bandHistSig, live: true);
            }
            else
            {
                for (int b = 0; b < Bands; b++)
                {
                    double[] slice = SliceFromRing(_bandFull[_selectedSource][b], _bandFullHead, _bandFullCount, Hist, _bandTrack.ScrubOffset);
                    double mean = 0, range = 1;
                    SeedHistLane(slice, _bandHistBuf[b], Hist, ref mean, ref range);
                    _bandBaseMean[_selectedSource, b] = mean;
                    _bandBaseRange[_selectedSource, b] = range;
                }
                SetHistVisible(_bandStream, _bandHistSig, live: false);
            }
            foreach (var p in _bandPlots) p.Refresh();
        }

        private void RebuildCogWindow()
        {
            if (_cogTrack.Live)
            {
                for (int c = 0; c < Cogs; c++)
                {
                    double[] recent = SliceFromRing(_cogFull[c], _cogFullHead, _cogFullCount, Hist, 0);
                    _cogStream[c].Clear();
                    foreach (var v in recent) _cogStream[c].Add(v);
                }
                SetHistVisible(_cogStream, _cogHistSig, live: true);
            }
            else
            {
                for (int c = 0; c < Cogs; c++)
                {
                    double[] slice = SliceFromRing(_cogFull[c], _cogFullHead, _cogFullCount, Hist, _cogTrack.ScrubOffset);
                    RightAlign(_cogHistBuf[c], slice, Hist);
                }
                SetHistVisible(_cogStream, _cogHistSig, live: false);
            }
            CogPlot.Refresh();
        }

        /// <summary>Right-aligns <paramref name="slice"/> into <paramref name="dst"/> (a fixed backing
        /// array for the scrub-view history), padding any shortfall on the left with 0 (the lane's own
        /// centreline — no more shared-lane offset; this is the "not enough history yet" case, e.g.
        /// scrubbed near session start, not a real gap), and seeding a fresh (mean, range) baseline
        /// from the slice's real (non-NaN) samples — a hard reset, since this is a discontinuous jump
        /// anyway. Shared with Bands (which never has NaN, so this is a no-op there); for EEG, any NaN
        /// gap placeholder in the slice (see PushRaw) passes through untouched into <paramref
        /// name="dst"/> rather than being normalised into a fabricated value — see
        /// RebuildEegHistSegments for how those NaN runs become real breaks on screen.</summary>
        /// <param name="fixedRange">When &gt; 0, use this range around zero instead of auto-gaining
        /// to the slice (the EEG lanes' pinned µV scale).</param>
        private static void SeedHistLane(double[] slice, double[] dst, int capacity, ref double baseMean, ref double baseRange,
            double fixedRange = 0)
        {
            int n = slice.Length, pad = Math.Max(0, capacity - n);
            double mean = 0, min = double.MaxValue, max = double.MinValue;
            int valid = 0;
            for (int j = 0; j < n; j++)
            {
                double v = slice[j];
                if (double.IsNaN(v)) continue;
                mean += v; if (v < min) min = v; if (v > max) max = v;
                valid++;
            }
            if (valid > 0) mean /= valid;
            double range = valid > 0 ? Math.Max(1e-9, max - min) : 1;
            if (fixedRange > 0) { mean = 0; range = fixedRange; }
            baseMean = mean; baseRange = range;

            for (int j = 0; j < pad; j++) dst[j] = 0;
            for (int j = 0; j < n; j++)
            {
                double v = slice[j];
                dst[pad + j] = double.IsNaN(v) ? double.NaN : (v - mean) / range * NormAmp;
            }
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
