using System;
using System.Collections.Generic;

namespace NeuuroBridge
{
    public struct BandPowers
    {
        public float Delta;  // 0.5–4 Hz
        public float Theta;  // 4–8 Hz
        public float Alpha;  // 8–13 Hz
        public float Beta;   // 13–30 Hz
        public float Gamma;  // 30–45 Hz  (not available from SDK ABDT)

        public override string ToString() =>
            $"δ={Delta,9:F5}  θ={Theta,9:F5}  α={Alpha,9:F5}  β={Beta,9:F5}  γ={Gamma,9:F5}";
    }

    /// <summary>
    /// Buffers filtered EEG frames and computes per-channel band powers via a
    /// Cooley-Tukey radix-2 FFT, using a sliding OVERLAPPING window: each window is still a full
    /// FftSize samples (so frequency resolution, binHz = SampleRate/FftSize = 1.0 Hz, is unchanged),
    /// but only FftStep of those samples are new — the rest carry over from the previous window.
    /// Fires OnBandPowers every FftStep samples (~SampleRate/FftStep ≈ 3.9/s) instead of every
    /// FftSize, giving band powers roughly every ~256ms instead of every ~1s without requiring the
    /// underlying signal to change any faster than it physically does — this is the same
    /// overlapping-window technique the ML pipeline's elliptic/Welch features already use
    /// (2s window / 0.5s step) for the same "smoother without inventing anything" reason.
    /// Independent of the Neeuro SDK's own analysis pipeline.
    /// </summary>
    public class EegProcessor
    {
        public const int SampleRate  = 256;
        public const int FftSize     = 256;   // window length; binHz = SampleRate/FftSize = 1.0 Hz
        public const int FftStep     = 64;    // slide amount; new-output rate = SampleRate/FftStep
        public const int ChannelCount = 4;

        private readonly object   _lock = new object();
        private readonly float[][] _buf;
        private readonly int[]     _pos;

        /// <summary>Fires every FftStep new samples (~SampleRate/FftStep windows/s); array is
        /// [ChannelCount] in channel order (Fp1, Fp2, T4, T3). Consecutive windows overlap — see
        /// the class summary — so consecutive BandPowers are correlated, not independent samples.</summary>
        public event Action<BandPowers[]> OnBandPowers;

        public EegProcessor()
        {
            _buf = new float[ChannelCount][];
            _pos = new int[ChannelCount];
            for (int i = 0; i < ChannelCount; i++)
                _buf[i] = new float[FftSize];
        }

        /// <summary>
        /// Feed one filtered frame from assignFilteredDataDelegate.
        /// Layout: [ch0 block][ch1 block][ch2 block][ch3 block] — same as raw frames.
        /// BLE delivers filtered frames in uneven bursts (see DbUploader's raw-frame notes), so a
        /// single call's samplesPerCh can straddle — or span several multiples of — a FftSize window
        /// boundary. Consume the frame in a loop so the leftover tail past a boundary carries into
        /// the next window (and a big-enough burst can fire OnBandPowers more than once) instead of
        /// being silently discarded, which previously dropped ~half the windows.
        /// </summary>
        public void AddFilteredFrame(float[] frame)
        {
            if (frame == null || frame.Length < ChannelCount) return;
            int samplesPerCh = frame.Length / ChannelCount;

            List<float[][]> snapshots = null;

            lock (_lock)
            {
                int i = 0;
                while (i < samplesPerCh)
                {
                    int take = Math.Min(FftSize - _pos[0], samplesPerCh - i);
                    for (int ch = 0; ch < ChannelCount; ch++)
                    {
                        Array.Copy(frame, ch * samplesPerCh + i, _buf[ch], _pos[ch], take);
                        _pos[ch] += take;
                    }
                    i += take;

                    // All channels fill at the same rate; ch0 reaching FftSize means all are ready.
                    if (_pos[0] >= FftSize)
                    {
                        var snapshot = new float[ChannelCount][];
                        for (int ch = 0; ch < ChannelCount; ch++)
                        {
                            snapshot[ch] = (float[])_buf[ch].Clone();
                            // Slide forward by FftStep instead of resetting to 0: keep the trailing
                            // (FftSize-FftStep) samples so the next window overlaps this one — see
                            // the class summary. _pos[ch] lands at FftSize-FftStep, so the next
                            // window only needs FftStep new samples to complete.
                            Array.Copy(_buf[ch], FftStep, _buf[ch], 0, FftSize - FftStep);
                            _pos[ch] = FftSize - FftStep;
                        }
                        (snapshots ?? (snapshots = new List<float[][]>())).Add(snapshot);
                    }
                }
            }

            if (snapshots == null) return;

            foreach (var snapshot in snapshots)
            {
                var powers = new BandPowers[ChannelCount];
                for (int ch = 0; ch < ChannelCount; ch++)
                    powers[ch] = ComputeBands(snapshot[ch]);
                OnBandPowers?.Invoke(powers);
            }
        }

        // ── FFT + band integration ───────────────────────────────────────────

        private static BandPowers ComputeBands(float[] samples)
        {
            int n = samples.Length;
            double[] re = new double[n];
            double[] im = new double[n];

            // Hanning window — reduces spectral leakage at band edges.
            for (int i = 0; i < n; i++)
            {
                double w = 0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (n - 1)));
                re[i] = samples[i] * w;
            }

            Fft(re, im);

            // One-sided power spectrum: power[k] maps to frequency k * (SampleRate/N) Hz.
            double binHz = (double)SampleRate / n;   // 1.0 Hz for N=256 @ 256 Hz
            int half = n / 2;
            double[] power = new double[half];
            for (int k = 0; k < half; k++)
                power[k] = (re[k] * re[k] + im[k] * im[k]) / ((double)n * n);

            return new BandPowers
            {
                Delta = SumBand(power, binHz,  0.5,  4.0),
                Theta = SumBand(power, binHz,  4.0,  8.0),
                Alpha = SumBand(power, binHz,  8.0, 13.0),
                Beta  = SumBand(power, binHz, 13.0, 30.0),
                Gamma = SumBand(power, binHz, 30.0, 45.0),
            };
        }

        private static float SumBand(double[] power, double binHz, double lo, double hi)
        {
            int kLo = (int)Math.Ceiling(lo / binHz);
            int kHi = Math.Min((int)Math.Floor(hi / binHz), power.Length - 1);
            double sum = 0;
            for (int k = kLo; k <= kHi; k++) sum += power[k];
            return (float)sum;
        }

        // Cooley-Tukey radix-2 DIT FFT. N must be a power of 2.
        private static void Fft(double[] re, double[] im)
        {
            int n = re.Length;

            // Bit-reversal permutation.
            for (int i = 1, j = 0; i < n; i++)
            {
                int bit = n >> 1;
                for (; (j & bit) != 0; bit >>= 1) j ^= bit;
                j ^= bit;
                if (i < j)
                {
                    double t;
                    t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
                }
            }

            // Butterfly stages.
            for (int len = 2; len <= n; len <<= 1)
            {
                double ang = -2.0 * Math.PI / len;
                double wRe = Math.Cos(ang), wIm = Math.Sin(ang);
                for (int i = 0; i < n; i += len)
                {
                    double uRe = 1.0, uIm = 0.0;
                    int half = len / 2;
                    for (int j = 0; j < half; j++)
                    {
                        int a = i + j, b = i + j + half;
                        double tRe = uRe * re[b] - uIm * im[b];
                        double tIm = uRe * im[b] + uIm * re[b];
                        re[b] = re[a] - tRe;  im[b] = im[a] - tIm;
                        re[a] += tRe;          im[a] += tIm;
                        double nRe = uRe * wRe - uIm * wIm;
                        uIm     = uRe * wIm + uIm * wRe;
                        uRe     = nRe;
                    }
                }
            }
        }
    }
}
