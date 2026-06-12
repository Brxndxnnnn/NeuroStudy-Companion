using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using Npgsql;
using NpgsqlTypes;

namespace NeuuroBridge
{
    /// <summary>
    /// One snapshot row for the <c>eeg_readings</c> hypertable. Channel arrays are
    /// length 4 in SDK frame order: [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3. A null array
    /// means "no data for that family yet" and is written as NULL.
    /// </summary>
    public struct EegReadingRow
    {
        public DateTime Time;
        public float[] RawLast;
        public float[] RawPkpk;
        public float[] FiltLast;
        public float[] FiltPkpk;
    }

    /// <summary>One row for the <c>band_powers</c> hypertable. Bands are length 4 in frame order.</summary>
    public struct BandPowerRow
    {
        public DateTime Time;
        public float Attention;
        public float Relaxation;
        public float MentalWorkload;
        public int SignalQuality;
        public BandPowers[] Bands;   // [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3
    }

    /// <summary>
    /// One whole raw-EEG frame queued for the <c>eeg_raw_samples</c> hypertable. Unlike
    /// the decimated <c>eeg_readings</c> path, every sample is preserved: <see cref="Samples"/>
    /// is the SDK's int frame ([ch0 block][ch1][ch2][ch3], frame order Fp1,Fp2,T4,T3) and
    /// <see cref="FrameEnd"/> is DbNow captured at frame arrival — the time of the LAST sample.
    /// Per-sample timestamps are derived from these at flush time (see CopyRaw).
    /// </summary>
    public struct RawEegFrameRecord
    {
        public DateTime FrameEnd;
        public int[] Samples;
    }

    /// <summary>
    /// Write-only bridge → TimescaleDB sink (TS1.6). Owns the session row, anchors the
    /// bridge clock to DB time once, then streams batched EEG and per-second band powers
    /// via binary COPY. Fire-and-forget: a DB hiccup never blocks or crashes streaming —
    /// rows queue (bounded) and are flushed on a timer; failures are logged and dropped.
    /// </summary>
    public class DbUploader : IDisposable
    {
        // Placeholder identities for the NOT-NULL sessions.client_id / conducted_by columns.
        // The session is created "unclaimed"; the frontend's claim overwrites both at pairing
        // time. These rows are upserted idempotently so the FK is always satisfiable in dev,
        // even on a fresh DB without the dev seed. (Until the agreed nullable-column migration
        // lands — see docs/session-data-flow.md "open contract points #1".)
        private const string PlaceholderClientId = "11111111-1111-1111-1111-111111111111";
        private const string PlaceholderUserId   = "22222222-2222-2222-2222-222222222222";
        // The placeholder client/user reference these so the NOT-NULL FKs
        // (clients.clinic_id, users.role_id) are satisfied on a fresh DB without the dev seed.
        private const string PlaceholderClinicId = "33333333-3333-3333-3333-333333333333";
        private const string PlaceholderRoleId   = "44444444-4444-4444-4444-444444444444";

        private const int ChannelCount    = 4;        // Fp1, Fp2, T4, T3 (SDK frame order)
        private const int FlushIntervalMs = 500;     // batch window for eeg_readings (~2 flushes/s)
        private const int MaxQueued       = 20000;    // bound each summary queue so a dead DB can't OOM us
        // Raw is 250 rows/s, and ML cannot tolerate gaps — give it a much deeper buffer
        // (~10 min of frames) before it is forced to drop. Durable spool-to-disk is the
        // planned follow-up that removes the drop entirely.
        private const int MaxRawFramesQueued = 200000;

        private readonly string _connString;
        private readonly Action<string> _log;
        private readonly object _ioLock = new object();

        private readonly ConcurrentQueue<EegReadingRow> _eegQ = new ConcurrentQueue<EegReadingRow>();
        private readonly ConcurrentQueue<BandPowerRow>  _bandQ = new ConcurrentQueue<BandPowerRow>();
        private readonly ConcurrentQueue<RawEegFrameRecord> _rawQ = new ConcurrentQueue<RawEegFrameRecord>();

        private NpgsqlConnection _conn;
        private Timer _flushTimer;
        private Guid _sessionId;
        private int _sampleRate = 250;                  // true hardware rate (NOT EegProcessor.SampleRate=256)
        // Sample-counter clock (reconstructs a uniform 250 Hz timeline from a monotonic sample
        // index rather than bursty BLE frame-arrival times — see CopyRaw).
        private bool _rawAnchored;
        private long _rawBaseTicks;                     // DB-time ticks of global sample index 0 (µs-aligned)
        private long _rawSampleIndex;                   // monotonic 250 Hz sample counter
        private long _rawResyncs;                       // dropped-frame resync events (diagnostic)
        private TimeSpan _clockOffset = TimeSpan.Zero;  // DbNow = UtcNow + offset
        private long _eegRowsSent;
        private long _bandRowsSent;
        private long _rawRowsSent;
        private long _rawFramesIn;                      // frames accepted into the raw queue (for reconciliation)
        private long _dropped;
        private long _rawDropped;
        private volatile bool _disposed;
        private volatile string _lastError;

        public DbUploader(string connString, Action<string> log)
        {
            _connString = connString;
            _log = log ?? (_ => { });
        }

        public bool ClockAnchored { get; private set; }
        /// <summary>True once the session row exists and the flush timer is running — i.e. uploads are live.</summary>
        public bool Streaming { get; private set; }
        public long EegRowsSent  => Interlocked.Read(ref _eegRowsSent);
        public long BandRowsSent => Interlocked.Read(ref _bandRowsSent);
        public long RawRowsSent  => Interlocked.Read(ref _rawRowsSent);
        public long RawFramesIn  => Interlocked.Read(ref _rawFramesIn);
        public long Dropped      => Interlocked.Read(ref _dropped);
        public long RawDropped   => Interlocked.Read(ref _rawDropped);
        /// <summary>Times the sample-counter clock resynced to arrival time (≈ genuine upstream frame loss).</summary>
        public long RawResyncs   => Interlocked.Read(ref _rawResyncs);
        public string LastError  => _lastError;

        /// <summary>Bridge clock mapped onto the DB timeline (see clock-sync note in the design doc).</summary>
        public DateTime DbNow => DateTime.UtcNow + _clockOffset;

        /// <summary>Maps a UTC instant captured on the bridge clock (e.g. a frame's arrival time)
        /// onto the DB timeline, applying the same anchor offset as <see cref="DbNow"/>.</summary>
        public DateTime ToDbTime(DateTime utc) => utc + _clockOffset;

        /// <summary>
        /// Opens the connection and anchors the bridge clock to DB time once
        /// (SELECT now() → store offset). Returns false if the DB is unreachable;
        /// the caller may still stream (CSV capture etc.) without DB upload.
        /// </summary>
        public bool Connect()
        {
            lock (_ioLock)
            {
                try
                {
                    EnsureOpen();
                    using (var cmd = new NpgsqlCommand("SELECT now()", _conn))
                    {
                        // Npgsql maps timestamptz to a UTC DateTime; tolerate DateTimeOffset too.
                        var scalar = cmd.ExecuteScalar();
                        DateTime dbNow = scalar is DateTimeOffset dto
                            ? dto.UtcDateTime
                            : ((DateTime)scalar).ToUniversalTime();
                        _clockOffset = dbNow - DateTime.UtcNow;
                        ClockAnchored = true;
                    }
                    _log($"DB connected. Clock offset vs DB = {_clockOffset.TotalMilliseconds:F0} ms.");
                    return true;
                }
                catch (Exception ex)
                {
                    _lastError = ex.Message;
                    _log("DB connect failed: " + ex.Message + "  (streaming continues without upload).");
                    return false;
                }
            }
        }

        /// <summary>
        /// Creates the session row as 'unclaimed' (placeholder client/technician), then starts
        /// the flush timer. Idempotent. Safe to call after a failed Connect — it retries the open.
        /// </summary>
        public bool CreateSession(Guid sessionId, string deviceMac, string pairingCode, int sampleRate, DateTime startUtc)
        {
            _sessionId = sessionId;
            if (sampleRate == 125 || sampleRate == 250) _sampleRate = sampleRate;
            lock (_ioLock)
            {
                try
                {
                    EnsureOpen();
                    using (var tx = _conn.BeginTransaction())
                    {
                        // Placeholder clinic + role first, so the FK/NOT-NULL constraints on
                        // clients.clinic_id and users.role_id are always satisfiable.
                        Exec(tx,
                            "INSERT INTO clinics (clinic_id, name) VALUES (@id, @name) " +
                            "ON CONFLICT (clinic_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderClinicId)),
                            ("name", NpgsqlDbType.Text, "⟨Unclaimed⟩ — bridge placeholder clinic"));

                        // requires_clinic=false lets the placeholder user keep a NULL clinic_id
                        // (the enforce_clinic_membership trigger only fires for clinic-requiring roles).
                        Exec(tx,
                            "INSERT INTO roles (role_id, name, requires_clinic, description) " +
                            "VALUES (@id, @name, false, @desc) ON CONFLICT (role_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderRoleId)),
                            ("name", NpgsqlDbType.Text, "bridge_placeholder"),
                            ("desc", NpgsqlDbType.Text, "Non-login placeholder role for the bridge system user."));

                        Exec(tx,
                            "INSERT INTO clients (client_id, clinic_id, name, notes) VALUES (@id, @clinic, @name, @notes) " +
                            "ON CONFLICT (client_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderClientId)),
                            ("clinic", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderClinicId)),
                            ("name", NpgsqlDbType.Text, "⟨Unclaimed⟩ — pending pairing"),
                            ("notes", NpgsqlDbType.Text, "Placeholder client for bridge-created sessions awaiting frontend claim."));

                        Exec(tx,
                            "INSERT INTO users (user_id, email, password_hash, role_id, clinic_id, display_name) " +
                            "VALUES (@id, @email, @pw, @role, NULL, @name) ON CONFLICT (user_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderUserId)),
                            ("email", NpgsqlDbType.Text, "bridge-system@neurostudy.local"),
                            ("pw", NpgsqlDbType.Text, "!"),   // non-bcrypt sentinel: can never authenticate
                            ("role", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderRoleId)),
                            ("name", NpgsqlDbType.Text, "Neuuro Bridge (system)"));

                        Exec(tx,
                            "INSERT INTO sessions (session_id, client_id, conducted_by, device_id, pairing_code, sample_rate, sync_status) " +
                            "VALUES (@sid, @cid, @uid, @dev, @pair, @rate, 'unclaimed') ON CONFLICT (session_id) DO NOTHING",
                            ("sid", NpgsqlDbType.Uuid, sessionId),
                            ("cid", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderClientId)),
                            ("uid", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderUserId)),
                            ("dev", NpgsqlDbType.Text, (object)deviceMac ?? DBNull.Value),
                            ("pair", NpgsqlDbType.Text, (object)pairingCode ?? DBNull.Value),
                            ("rate", NpgsqlDbType.Integer, sampleRate));

                        tx.Commit();
                    }
                    _log($"Session row created (unclaimed): {sessionId}");
                    StartFlushTimer();
                    Streaming = true;
                    return true;
                }
                catch (Exception ex)
                {
                    _lastError = ex.Message;
                    _log("Session INSERT failed: " + ex.Message);
                    return false;
                }
            }
        }

        public void EnqueueEeg(EegReadingRow row)
        {
            if (_disposed || !Streaming) return;
            _eegQ.Enqueue(row);
            Trim(_eegQ, MaxQueued);
        }

        public void EnqueueBand(BandPowerRow row)
        {
            if (_disposed || !Streaming) return;
            _bandQ.Enqueue(row);
            Trim(_bandQ, MaxQueued);
        }

        /// <summary>
        /// Queue one full raw frame for the eeg_raw_samples table. <paramref name="frameEnd"/>
        /// must be DbNow captured at frame arrival (the last sample's time); <paramref name="samples"/>
        /// must be a private copy — the SDK reuses its buffer. Cheap: just enqueue; the per-sample
        /// expansion + COPY happens on the flush thread.
        /// </summary>
        public void EnqueueRaw(DateTime frameEnd, int[] samples)
        {
            if (_disposed || !Streaming || samples == null) return;
            _rawQ.Enqueue(new RawEegFrameRecord { FrameEnd = frameEnd, Samples = samples });
            Interlocked.Increment(ref _rawFramesIn);
            while (_rawQ.Count > MaxRawFramesQueued && _rawQ.TryDequeue(out _))
                Interlocked.Increment(ref _rawDropped);
        }

        private void Trim<T>(ConcurrentQueue<T> q, int cap)
        {
            while (q.Count > cap && q.TryDequeue(out _))
                Interlocked.Increment(ref _dropped);
        }

        // ── Flush ────────────────────────────────────────────────────────────
        private void StartFlushTimer()
        {
            if (_flushTimer != null) return;
            _flushTimer = new Timer(_ => FlushTick(), null, FlushIntervalMs, FlushIntervalMs);
        }

        private void FlushTick()
        {
            // Skip this tick if a flush (or session insert) is already in progress —
            // never let timer callbacks pile up on a slow DB.
            if (!Monitor.TryEnter(_ioLock)) return;
            try { Flush(); }
            catch (Exception ex) { _lastError = ex.Message; _log("Flush error: " + ex.Message); ResetConnection(); }
            finally { Monitor.Exit(_ioLock); }
        }

        /// <summary>Drains all queues to the DB. Caller must hold <see cref="_ioLock"/>.</summary>
        private void Flush()
        {
            if (_eegQ.IsEmpty && _bandQ.IsEmpty && _rawQ.IsEmpty) return;
            EnsureOpen();

            int eeg = CopyEeg();
            int band = CopyBand();
            int raw = CopyRaw();
            if (eeg > 0)  Interlocked.Add(ref _eegRowsSent, eeg);
            if (band > 0) Interlocked.Add(ref _bandRowsSent, band);
            if (raw > 0)  Interlocked.Add(ref _rawRowsSent, raw);
        }

        /// <summary>
        /// Expands every queued raw frame into one row per sample and bulk-COPYs them into
        /// eeg_raw_samples. Per-sample time comes from a monotonic SAMPLE COUNTER
        /// (base + index/sampleRate), NOT the frame's arrival time: the SenzeBand samples
        /// continuously at a true 250 Hz but BLE delivers frames in uneven bursts, so anchoring
        /// to arrival warps the timeline (a 38 s stream spread across 53 s). The counter
        /// reconstructs a uniform 250 Hz axis with exact, µs-aligned, strictly-increasing
        /// timestamps (so the (session_id, time) PK can never collide). A drift guard against
        /// real arrival time resynchronises the counter when frames are GENUINELY lost, inserting
        /// a real gap rather than silently compressing everything after it. Channel columns map
        /// the SDK frame order [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3 onto fp1,fp2,t3,t4 (note t3/t4 swap).
        /// </summary>
        private int CopyRaw()
        {
            if (_rawQ.IsEmpty) return 0;
            long periodTicks = TimeSpan.TicksPerSecond / _sampleRate;   // 40000 ticks = 4 ms @ 250 Hz (µs-aligned)
            // How far real (arrival) time may lead the counter before we treat the shortfall as
            // genuine frame loss and resync. Must exceed normal burst latency (~1–2 s observed).
            long maxDriftTicks = 3 * TimeSpan.TicksPerSecond;
            int n = 0;
            using (var w = _conn.BeginBinaryImport(
                "COPY eeg_raw_samples (session_id, time, fp1, fp2, t3, t4) FROM STDIN (FORMAT BINARY)"))
            {
                while (_rawQ.TryDequeue(out var f))
                {
                    var samples = f.Samples;
                    if (samples == null || samples.Length < ChannelCount) continue;
                    int spc = samples.Length / ChannelCount;   // samples per channel in this frame

                    if (!_rawAnchored)
                    {
                        // Index 0 = the first sample of the first frame. Snap to µs so every derived
                        // timestamp is µs-aligned (the DB stores no finer) and uniquely keyed.
                        _rawBaseTicks = f.FrameEnd.Ticks - (long)(spc - 1) * periodTicks;
                        _rawBaseTicks -= _rawBaseTicks % (TimeSpan.TicksPerMillisecond / 1000);
                        _rawSampleIndex = 0;
                        _rawAnchored = true;
                    }

                    // If arrival time has run far ahead of where the counter says this frame's last
                    // sample should sit, frames were genuinely dropped upstream — jump the counter
                    // forward (insert a real gap) so we don't compress the rest of the timeline.
                    long counterLastTicks = _rawBaseTicks + (_rawSampleIndex + spc - 1) * periodTicks;
                    if (f.FrameEnd.Ticks - counterLastTicks > maxDriftTicks)
                    {
                        long resyncIndex = (long)Math.Round((double)(f.FrameEnd.Ticks - _rawBaseTicks) / periodTicks) - (spc - 1);
                        if (resyncIndex > _rawSampleIndex)
                        {
                            _rawSampleIndex = resyncIndex;
                            Interlocked.Increment(ref _rawResyncs);
                        }
                    }

                    for (int i = 0; i < spc; i++)
                    {
                        long t = _rawBaseTicks + _rawSampleIndex * periodTicks;   // exact, uniform, µs-aligned
                        _rawSampleIndex++;

                        w.StartRow();
                        w.Write(_sessionId, NpgsqlDbType.Uuid);
                        w.Write(new DateTime(t, DateTimeKind.Utc), NpgsqlDbType.TimestampTz);
                        w.Write(samples[0 * spc + i], NpgsqlDbType.Integer);  // fp1 = frame ch0
                        w.Write(samples[1 * spc + i], NpgsqlDbType.Integer);  // fp2 = frame ch1
                        w.Write(samples[3 * spc + i], NpgsqlDbType.Integer);  // t3  = frame ch3
                        w.Write(samples[2 * spc + i], NpgsqlDbType.Integer);  // t4  = frame ch2
                        n++;
                    }
                }
                w.Complete();
            }
            return n;
        }

        private int CopyEeg()
        {
            if (_eegQ.IsEmpty) return 0;
            int n = 0;
            using (var w = _conn.BeginBinaryImport(
                "COPY eeg_readings (session_id, time, " +
                "fp1_raw_last, fp2_raw_last, t3_raw_last, t4_raw_last, " +
                "fp1_raw_pkpk, fp2_raw_pkpk, t3_raw_pkpk, t4_raw_pkpk, " +
                "fp1_filt_last, fp2_filt_last, t4_filt_last, t3_filt_last, " +
                "fp1_filt_pkpk, fp2_filt_pkpk, t4_filt_pkpk, t3_filt_pkpk) FROM STDIN (FORMAT BINARY)"))
            {
                while (_eegQ.TryDequeue(out var r))
                {
                    w.StartRow();
                    w.Write(_sessionId, NpgsqlDbType.Uuid);
                    w.Write(r.Time, NpgsqlDbType.TimestampTz);
                    // Column order pairs the channel index map [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3
                    // with the schema's fp1,fp2,t3,t4 ordering — note t3/t4 swap per family.
                    WriteCh(w, r.RawLast, 0); WriteCh(w, r.RawLast, 1); WriteCh(w, r.RawLast, 3); WriteCh(w, r.RawLast, 2);
                    WriteCh(w, r.RawPkpk, 0); WriteCh(w, r.RawPkpk, 1); WriteCh(w, r.RawPkpk, 3); WriteCh(w, r.RawPkpk, 2);
                    WriteCh(w, r.FiltLast, 0); WriteCh(w, r.FiltLast, 1); WriteCh(w, r.FiltLast, 2); WriteCh(w, r.FiltLast, 3);
                    WriteCh(w, r.FiltPkpk, 0); WriteCh(w, r.FiltPkpk, 1); WriteCh(w, r.FiltPkpk, 2); WriteCh(w, r.FiltPkpk, 3);
                    n++;
                }
                w.Complete();
            }
            return n;
        }

        private int CopyBand()
        {
            if (_bandQ.IsEmpty) return 0;
            int n = 0;
            using (var w = _conn.BeginBinaryImport(
                "COPY band_powers (session_id, time, attention, relaxation, mental_workload, signal_quality, " +
                "fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma, " +
                "fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma, " +
                "t4_alpha, t4_beta, t4_delta, t4_theta, t4_gamma, " +
                "t3_alpha, t3_beta, t3_delta, t3_theta, t3_gamma) FROM STDIN (FORMAT BINARY)"))
            {
                while (_bandQ.TryDequeue(out var r))
                {
                    w.StartRow();
                    w.Write(_sessionId, NpgsqlDbType.Uuid);
                    w.Write(r.Time, NpgsqlDbType.TimestampTz);
                    WriteReal(w, r.Attention);
                    WriteReal(w, r.Relaxation);
                    WriteReal(w, r.MentalWorkload);
                    w.Write(r.SignalQuality, NpgsqlDbType.Integer);
                    // Bands order Fp1, Fp2, T4, T3 — matches the schema's column grouping.
                    foreach (int ch in new[] { 0, 1, 2, 3 })
                        WriteBand(w, r.Bands, ch);
                    n++;
                }
                w.Complete();
            }
            return n;
        }

        private static void WriteBand(NpgsqlBinaryImporter w, BandPowers[] bands, int ch)
        {
            if (bands == null || ch >= bands.Length)
            {
                for (int i = 0; i < 5; i++) w.WriteNull();
                return;
            }
            var b = bands[ch];
            WriteReal(w, b.Alpha);
            WriteReal(w, b.Beta);
            WriteReal(w, b.Delta);
            WriteReal(w, b.Theta);
            WriteReal(w, b.Gamma);
        }

        private static void WriteCh(NpgsqlBinaryImporter w, float[] arr, int ch)
        {
            if (arr == null || ch >= arr.Length) { w.WriteNull(); return; }
            WriteReal(w, arr[ch]);
        }

        private static void WriteReal(NpgsqlBinaryImporter w, float v)
        {
            if (float.IsNaN(v) || float.IsInfinity(v)) w.WriteNull();
            else w.Write(v, NpgsqlDbType.Real);
        }

        // ── Connection plumbing ──────────────────────────────────────────────
        private void EnsureOpen()
        {
            if (_conn == null)
                _conn = new NpgsqlConnection(_connString);
            if (_conn.State != System.Data.ConnectionState.Open)
                _conn.Open();
        }

        private void ResetConnection()
        {
            try { _conn?.Dispose(); } catch { /* ignore */ }
            _conn = null;
        }

        private void Exec(NpgsqlTransaction tx, string sql, params (string name, NpgsqlDbType type, object val)[] ps)
        {
            using (var cmd = new NpgsqlCommand(sql, _conn, tx))
            {
                foreach (var (name, type, val) in ps)
                    cmd.Parameters.AddWithValue(name, type, val ?? DBNull.Value);
                cmd.ExecuteNonQuery();
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _flushTimer?.Dispose(); } catch { /* ignore */ }
            lock (_ioLock)
            {
                try { Flush(); }   // final drain
                catch (Exception ex) { _log("Final flush error: " + ex.Message); }
                ResetConnection();
            }
            _log($"DB uploader stopped. Sent {EegRowsSent} eeg + {BandRowsSent} band + {RawRowsSent} raw rows" +
                 (Dropped > 0 || RawDropped > 0
                     ? $", dropped {Dropped} summary / {RawDropped} raw frames (queue overflow)."
                     : ".") +
                 $"  Raw frames accepted: {RawFramesIn}" +
                 (RawResyncs > 0 ? $"; {RawResyncs} timeline resync(s) (upstream frame loss)." : "."));
        }
    }
}
