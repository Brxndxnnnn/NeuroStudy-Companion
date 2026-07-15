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
        public int? HeartRate;       // PPG-derived bpm, last-known value (null = not yet read)
        public int? Spo2;            // PPG-derived %, last-known value (null = not yet read)
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
    /// One whole SDK-filtered EEG frame queued for the <c>eeg_filtered_samples</c> hypertable.
    /// Mirrors <see cref="RawEegFrameRecord"/> but carries the filtered µV floats (frame layout
    /// [ch0 block][ch1][ch2][ch3], order Fp1,Fp2,T4,T3 — same as raw). Filtered frames carry no
    /// SDK arrival stamp, so <see cref="FrameEnd"/> is DbNow captured in the handler (≈ the last
    /// sample's time). Per-sample timestamps are derived at flush time (see CopyFiltered).
    /// </summary>
    public struct FilteredEegFrameRecord
    {
        public DateTime FrameEnd;
        public float[] Samples;
    }

    /// <summary>
    /// Advisory snapshot of how far the web-driven session flow has progressed, read from the DB
    /// (sessions + events + session_questionnaire_responses). Everything here is display-only for
    /// the technician; it never gates the write path.
    /// </summary>
    public struct SessionProgress
    {
        public bool Known;                 // false = not read yet / read failed this tick
        public string SyncStatus;
        public bool Claimed;               // website paired (claimed / recording / completed)
        public bool RecordingConfirmed;    // sessions.bridge_recording_at stamped
        public bool ImagesShown;           // ≥1 image event exists
        public bool QuestionsShown;        // ≥1 math-question event exists
        public bool Ended;                 // sync_status = 'completed'
        public bool SurveySubmitted;       // ≥1 questionnaire response row exists
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

        // ── Expected steady-state row rates while recording (sent-vs-expected reconciliation).
        // Raw and filtered stream one row per hardware sample (true 250 Hz); the summary row is
        // throttled to one per 500 ms in BridgeController; the band row fires once per
        // 256-sample FFT window (EegProcessor.FftSize) at the true 250 Hz hardware rate.
        public const double RawRowsPerSecond      = 250.0;
        public const double FilteredRowsPerSecond = 250.0;
        public const double SummaryRowsPerSecond  = 2.0;
        public const double BandRowsPerSecond     = 250.0 / 256.0;

        // Approximate per-row size on the binary-COPY wire (2 B column count + 4 B length prefix
        // per column + column data) — lets the UI show a human-scale upload volume.
        public const int RawRowBytes = 66, FilteredRowBytes = 66, SummaryRowBytes = 162, BandRowBytes = 242;

        private const int ChannelCount    = 4;        // Fp1, Fp2, T4, T3 (SDK frame order)

        /// <summary>
        /// Channel positions within an SDK frame. The SenzeBand delivers its four channels in the
        /// order Fp1, Fp2, T4, T3 — note that T4 comes BEFORE T3, so index 2 is T4 and index 3 is T3.
        /// Every DB table stores them as fp1, fp2, t3, t4.
        ///
        /// Always address frame data through these names, never a bare index. Getting the temporal
        /// pair backwards writes left-hemisphere signal into the right-hemisphere column: nothing
        /// throws, no test fails, and the only symptom is that lateralised activity appears on the
        /// wrong side of the head — which would silently invert any asymmetry result. Nothing
        /// downstream can catch it either, because the backend, the frontend and ml_service all
        /// address channels by COLUMN NAME and simply trust whatever the bridge wrote here.
        /// </summary>
        private static class FrameIdx
        {
            public const int Fp1 = 0;
            public const int Fp2 = 1;
            public const int T4  = 2;
            public const int T3  = 3;
        }

        /// <summary>
        /// Frame indices in the order every table lists its channel columns (fp1, fp2, t3, t4).
        /// Every COPY below writes its channel columns in this order, so a column list and the
        /// values filling it can only ever be read one way.
        /// </summary>
        private static readonly int[] SchemaChannelOrder = { FrameIdx.Fp1, FrameIdx.Fp2, FrameIdx.T3, FrameIdx.T4 };

        // How far real (arrival) time may lead the sample counter before the shortfall is treated as
        // genuine upstream frame loss rather than ordinary BLE burst latency (~1–2 s observed).
        // Shared by the raw and filtered drift guards and by SealTrailingGap.
        private static readonly long MaxDriftTicks = 3 * TimeSpan.TicksPerSecond;

        private const int FlushIntervalMs = 500;     // batch window for eeg_readings (~2 flushes/s)
        private const int MaxQueued       = 20000;    // bound each summary queue so a dead DB can't OOM us
        // Raw is 250 rows/s, and ML cannot tolerate gaps — give it a much deeper buffer
        // (~10 min of frames) before it is forced to drop. Durable spool-to-disk is the
        // planned follow-up that removes the drop entirely.
        private const int MaxRawFramesQueued = 200000;
        // Filtered runs at the same 250 rows/s as raw and feeds the same ML consumer — give it
        // the identical deep buffer so a DB stall drops it no sooner than the raw stream.
        private const int MaxFiltFramesQueued = 200000;

        private readonly string _connString;
        private readonly Action<string> _log;
        private readonly object _ioLock = new object();

        private readonly ConcurrentQueue<EegReadingRow> _eegQ = new ConcurrentQueue<EegReadingRow>();
        private readonly ConcurrentQueue<BandPowerRow>  _bandQ = new ConcurrentQueue<BandPowerRow>();
        private readonly ConcurrentQueue<RawEegFrameRecord> _rawQ = new ConcurrentQueue<RawEegFrameRecord>();
        private readonly ConcurrentQueue<FilteredEegFrameRecord> _filtQ = new ConcurrentQueue<FilteredEegFrameRecord>();

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
        private long _rawGapSamples;                    // total samples skipped at resyncs (= BLE dropout, not upload loss)
        // Filtered stream's own independent sample-counter clock (same scheme as the raw one above;
        // the two streams arrive on separate SDK callbacks and are anchored independently).
        private bool _filtAnchored;
        private long _filtBaseTicks;
        private long _filtSampleIndex;
        private long _filtResyncs;
        private TimeSpan _clockOffset = TimeSpan.Zero;  // DbNow = UtcNow + offset
        private long _eegRowsSent;
        private long _bandRowsSent;
        private long _rawRowsSent;
        private long _filtRowsSent;
        private long _rawFramesIn;                      // frames accepted into the raw queue (for reconciliation)
        private long _filtFramesIn;                     // frames accepted into the filtered queue
        private long _dropped;
        private long _rawDropped;
        private long _filtDropped;
        private volatile bool _disposed;
        private volatile bool _markCompletedOnDispose;
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
        public long FiltRowsSent => Interlocked.Read(ref _filtRowsSent);
        public long RawFramesIn  => Interlocked.Read(ref _rawFramesIn);
        public long FiltFramesIn => Interlocked.Read(ref _filtFramesIn);
        public long Dropped      => Interlocked.Read(ref _dropped);
        public long RawDropped   => Interlocked.Read(ref _rawDropped);
        public long FiltDropped  => Interlocked.Read(ref _filtDropped);
        /// <summary>Times the sample-counter clock resynced to arrival time (≈ genuine upstream frame loss).</summary>
        public long RawResyncs   => Interlocked.Read(ref _rawResyncs);
        public long FiltResyncs  => Interlocked.Read(ref _filtResyncs);
        /// <summary>Seconds of raw signal that never arrived over BLE (skipped at resyncs). This is
        /// upstream dropout, NOT rows lost between the bridge and DB — expected-row math subtracts it.</summary>
        public double RawGapSeconds => Interlocked.Read(ref _rawGapSamples) / (double)_sampleRate;
        public string LastError  => _lastError;

        /// <summary>Approximate bytes shipped to the DB so far (binary-COPY wire sizes).</summary>
        public long ApproxBytesSent =>
            RawRowsSent * RawRowBytes + FiltRowsSent * FilteredRowBytes +
            EegRowsSent * SummaryRowBytes + BandRowsSent * BandRowBytes;

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

        /// <summary>
        /// Requests that the session row be marked <c>'completed'</c> when this uploader is
        /// disposed — i.e. the technician explicitly ended the session via Stop. Deferring it to
        /// <see cref="Dispose"/> guarantees the status flip happens AFTER the final data flush, so
        /// a frontend polling sync_status never sees 'completed' before the last batch has landed.
        /// (Plain app shutdown disposes WITHOUT this, leaving the session in its prior state.)
        /// </summary>
        public void RequestComplete() => _markCompletedOnDispose = true;

        /// <summary>
        /// Reads this session's current <c>sync_status</c> for advisory display only — the frontend
        /// flips it to <c>'claimed'</c> when it pairs. Read-only and non-blocking: returns null if a
        /// flush is in progress (skips rather than contend) or on any error, so it can never delay or
        /// disturb the write path. This is the one place the bridge reads the DB; it never gates uploads.
        /// </summary>
        public string TryReadSyncStatus()
        {
            if (_disposed || _sessionId == Guid.Empty) return null;
            if (!Monitor.TryEnter(_ioLock)) return null;   // a flush holds the lock — try again next tick
            try
            {
                EnsureOpen();
                using (var cmd = new NpgsqlCommand("SELECT sync_status FROM sessions WHERE session_id = @sid", _conn))
                {
                    cmd.Parameters.AddWithValue("sid", NpgsqlDbType.Uuid, _sessionId);
                    var v = cmd.ExecuteScalar();
                    return v == null || v is DBNull ? null : v.ToString();
                }
            }
            catch (Exception ex) { _lastError = ex.Message; return null; }
            finally { Monitor.Exit(_ioLock); }
        }

        /// <summary>
        /// Reads the web-side session progress (paired / recording / images / questions / ended /
        /// survey submitted) for advisory display. Uses its OWN pooled connection — independent of
        /// the uploader's write connection — so it never contends with the write path and keeps
        /// working after the uploader is disposed (the survey is submitted AFTER the session ends).
        /// Best-effort: any failure returns Known=false and the caller just skips this tick.
        /// </summary>
        public static SessionProgress TryReadProgress(string connString, Guid sessionId)
        {
            var p = new SessionProgress();
            try
            {
                using (var conn = new NpgsqlConnection(connString))
                {
                    conn.Open();
                    using (var cmd = new NpgsqlCommand(
                        "SELECT s.sync_status, s.bridge_recording_at IS NOT NULL, " +
                        "EXISTS(SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.image_id IS NOT NULL), " +
                        "EXISTS(SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.question_id IS NOT NULL), " +
                        "EXISTS(SELECT 1 FROM session_questionnaire_responses r WHERE r.session_id = s.session_id) " +
                        "FROM sessions s WHERE s.session_id = @sid", conn))
                    {
                        cmd.Parameters.AddWithValue("sid", NpgsqlDbType.Uuid, sessionId);
                        using (var rd = cmd.ExecuteReader())
                        {
                            if (!rd.Read()) return p;
                            p.SyncStatus = rd.IsDBNull(0) ? "" : rd.GetString(0);
                            p.RecordingConfirmed = rd.GetBoolean(1);
                            p.ImagesShown = rd.GetBoolean(2);
                            p.QuestionsShown = rd.GetBoolean(3);
                            p.SurveySubmitted = rd.GetBoolean(4);
                            p.Claimed = p.SyncStatus == "claimed" || p.SyncStatus == "recording" || p.SyncStatus == "completed";
                            p.Ended = p.SyncStatus == "completed";
                            p.Known = true;
                        }
                    }
                }
            }
            catch { /* advisory only — a failed read means "unknown this tick" */ }
            return p;
        }

        /// <summary>
        /// Stamps sessions.bridge_recording_at = now() (DB clock) to confirm to the frontend that the
        /// bridge has actually begun recording — the web gates its first image on this. Written ONCE
        /// per session (only while still NULL), so calling it every poll tick is harmless. Non-blocking:
        /// skips if a flush holds the lock, returns false on any error so the caller retries next tick.
        /// Returns true only when the column is confirmed set (already-set counts as confirmed).
        /// </summary>
        public bool MarkRecordingStarted()
        {
            if (_disposed || _sessionId == Guid.Empty) return false;
            if (!Monitor.TryEnter(_ioLock)) return false;   // a flush holds the lock — try again next tick
            try
            {
                EnsureOpen();
                using (var cmd = new NpgsqlCommand(
                    "UPDATE sessions SET bridge_recording_at = now() " +
                    "WHERE session_id = @sid AND bridge_recording_at IS NULL", _conn))
                {
                    cmd.Parameters.AddWithValue("sid", NpgsqlDbType.Uuid, _sessionId);
                    cmd.ExecuteNonQuery();   // 0 rows = already stamped earlier; still "confirmed"
                    return true;
                }
            }
            catch (Exception ex) { _lastError = ex.Message; return false; }
            finally { Monitor.Exit(_ioLock); }
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

        /// <summary>
        /// Queue one full SDK-filtered frame for the eeg_filtered_samples table. <paramref name="frameEnd"/>
        /// should be DbNow captured at frame arrival (the last sample's time); <paramref name="samples"/>
        /// must be a private copy (the OnFiltered callback already clones per frame). Cheap: just enqueue;
        /// the per-sample expansion + COPY happens on the flush thread (see CopyFiltered).
        /// </summary>
        public void EnqueueFiltered(DateTime frameEnd, float[] samples)
        {
            if (_disposed || !Streaming || samples == null) return;
            _filtQ.Enqueue(new FilteredEegFrameRecord { FrameEnd = frameEnd, Samples = samples });
            Interlocked.Increment(ref _filtFramesIn);
            while (_filtQ.Count > MaxFiltFramesQueued && _filtQ.TryDequeue(out _))
                Interlocked.Increment(ref _filtDropped);
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
            if (_eegQ.IsEmpty && _bandQ.IsEmpty && _rawQ.IsEmpty && _filtQ.IsEmpty) return;
            EnsureOpen();

            int eeg = CopyEeg();
            int band = CopyBand();
            int raw = CopyRaw();
            int filt = CopyFiltered();
            if (eeg > 0)  Interlocked.Add(ref _eegRowsSent, eeg);
            if (band > 0) Interlocked.Add(ref _bandRowsSent, band);
            if (raw > 0)  Interlocked.Add(ref _rawRowsSent, raw);
            if (filt > 0) Interlocked.Add(ref _filtRowsSent, filt);
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
            long maxDriftTicks = MaxDriftTicks;
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
                            Interlocked.Add(ref _rawGapSamples, resyncIndex - _rawSampleIndex);
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
                        w.Write(samples[FrameIdx.Fp1 * spc + i], NpgsqlDbType.Integer);
                        w.Write(samples[FrameIdx.Fp2 * spc + i], NpgsqlDbType.Integer);
                        w.Write(samples[FrameIdx.T3  * spc + i], NpgsqlDbType.Integer);
                        w.Write(samples[FrameIdx.T4  * spc + i], NpgsqlDbType.Integer);
                        n++;
                    }
                }
                w.Complete();
            }
            return n;
        }

        /// <summary>
        /// Filtered-stream twin of <see cref="CopyRaw"/>: expands every queued filtered frame into one
        /// row per sample and bulk-COPYs them into eeg_filtered_samples. Uses the SAME monotonic 250 Hz
        /// sample-counter clock (uniform, µs-aligned, strictly increasing) and the SAME drift/resync guard
        /// as the raw path — but on its own independent anchor (filtered arrives on a separate SDK callback)
        /// and writes SDK-filtered µV floats (real) instead of raw ADC counts. Channel columns map the SDK
        /// frame order [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3 onto fp1,fp2,t3,t4 (note t3/t4 swap), identical to raw.
        /// </summary>
        private int CopyFiltered()
        {
            if (_filtQ.IsEmpty) return 0;
            long periodTicks = TimeSpan.TicksPerSecond / _sampleRate;
            long maxDriftTicks = MaxDriftTicks;
            int n = 0;
            using (var w = _conn.BeginBinaryImport(
                "COPY eeg_filtered_samples (session_id, time, fp1, fp2, t3, t4) FROM STDIN (FORMAT BINARY)"))
            {
                while (_filtQ.TryDequeue(out var f))
                {
                    var samples = f.Samples;
                    if (samples == null || samples.Length < ChannelCount) continue;
                    int spc = samples.Length / ChannelCount;

                    if (!_filtAnchored)
                    {
                        _filtBaseTicks = f.FrameEnd.Ticks - (long)(spc - 1) * periodTicks;
                        _filtBaseTicks -= _filtBaseTicks % (TimeSpan.TicksPerMillisecond / 1000);
                        _filtSampleIndex = 0;
                        _filtAnchored = true;
                    }

                    // Same drift/resync guard as CopyRaw — see there for the rationale.
                    long counterLastTicks = _filtBaseTicks + (_filtSampleIndex + spc - 1) * periodTicks;
                    if (f.FrameEnd.Ticks - counterLastTicks > maxDriftTicks)
                    {
                        long resyncIndex = (long)Math.Round((double)(f.FrameEnd.Ticks - _filtBaseTicks) / periodTicks) - (spc - 1);
                        if (resyncIndex > _filtSampleIndex)
                        {
                            _filtSampleIndex = resyncIndex;
                            Interlocked.Increment(ref _filtResyncs);
                        }
                    }

                    for (int i = 0; i < spc; i++)
                    {
                        long t = _filtBaseTicks + _filtSampleIndex * periodTicks;   // exact, uniform, µs-aligned
                        _filtSampleIndex++;

                        w.StartRow();
                        w.Write(_sessionId, NpgsqlDbType.Uuid);
                        w.Write(new DateTime(t, DateTimeKind.Utc), NpgsqlDbType.TimestampTz);
                        w.Write(samples[FrameIdx.Fp1 * spc + i], NpgsqlDbType.Real);
                        w.Write(samples[FrameIdx.Fp2 * spc + i], NpgsqlDbType.Real);
                        w.Write(samples[FrameIdx.T3  * spc + i], NpgsqlDbType.Real);
                        w.Write(samples[FrameIdx.T4  * spc + i], NpgsqlDbType.Real);
                        n++;
                    }
                }
                w.Complete();
            }
            return n;
        }

        /// <summary>
        /// Filtered-stream twin of <see cref="CopyRaw"/>: expands every queued filtered frame into one
        /// row per sample and bulk-COPYs them into eeg_filtered_samples. Uses the SAME monotonic 250 Hz
        /// sample-counter clock (uniform, µs-aligned, strictly increasing) and the SAME drift/resync guard
        /// as the raw path — but on its own independent anchor (filtered arrives on a separate SDK callback)
        /// and writes SDK-filtered µV floats (real) instead of raw ADC counts. Channel columns map the SDK
        /// frame order [0]=Fp1 [1]=Fp2 [2]=T4 [3]=T3 onto fp1,fp2,t3,t4 (note t3/t4 swap), identical to raw.
        /// </summary>
        private int CopyFiltered()
        {
            if (_filtQ.IsEmpty) return 0;
            long periodTicks = TimeSpan.TicksPerSecond / _sampleRate;
            long maxDriftTicks = 3 * TimeSpan.TicksPerSecond;
            int n = 0;
            using (var w = _conn.BeginBinaryImport(
                "COPY eeg_filtered_samples (session_id, time, fp1, fp2, t3, t4) FROM STDIN (FORMAT BINARY)"))
            {
                while (_filtQ.TryDequeue(out var f))
                {
                    var samples = f.Samples;
                    if (samples == null || samples.Length < ChannelCount) continue;
                    int spc = samples.Length / ChannelCount;

                    if (!_filtAnchored)
                    {
                        _filtBaseTicks = f.FrameEnd.Ticks - (long)(spc - 1) * periodTicks;
                        _filtBaseTicks -= _filtBaseTicks % (TimeSpan.TicksPerMillisecond / 1000);
                        _filtSampleIndex = 0;
                        _filtAnchored = true;
                    }

                    // Same drift/resync guard as CopyRaw — see there for the rationale.
                    long counterLastTicks = _filtBaseTicks + (_filtSampleIndex + spc - 1) * periodTicks;
                    if (f.FrameEnd.Ticks - counterLastTicks > maxDriftTicks)
                    {
                        long resyncIndex = (long)Math.Round((double)(f.FrameEnd.Ticks - _filtBaseTicks) / periodTicks) - (spc - 1);
                        if (resyncIndex > _filtSampleIndex)
                        {
                            _filtSampleIndex = resyncIndex;
                            Interlocked.Increment(ref _filtResyncs);
                        }
                    }

                    for (int i = 0; i < spc; i++)
                    {
                        long t = _filtBaseTicks + _filtSampleIndex * periodTicks;   // exact, uniform, µs-aligned
                        _filtSampleIndex++;

                        w.StartRow();
                        w.Write(_sessionId, NpgsqlDbType.Uuid);
                        w.Write(new DateTime(t, DateTimeKind.Utc), NpgsqlDbType.TimestampTz);
                        w.Write(samples[0 * spc + i], NpgsqlDbType.Real);  // fp1 = frame ch0
                        w.Write(samples[1 * spc + i], NpgsqlDbType.Real);  // fp2 = frame ch1
                        w.Write(samples[3 * spc + i], NpgsqlDbType.Real);  // t3  = frame ch3
                        w.Write(samples[2 * spc + i], NpgsqlDbType.Real);  // t4  = frame ch2
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
                "fp1_filt_last, fp2_filt_last, t3_filt_last, t4_filt_last, " +
                "fp1_filt_pkpk, fp2_filt_pkpk, t3_filt_pkpk, t4_filt_pkpk) FROM STDIN (FORMAT BINARY)"))
            {
                while (_eegQ.TryDequeue(out var r))
                {
                    w.StartRow();
                    w.Write(_sessionId, NpgsqlDbType.Uuid);
                    w.Write(r.Time, NpgsqlDbType.TimestampTz);
                    WriteChannels(w, r.RawLast);
                    WriteChannels(w, r.RawPkpk);
                    WriteChannels(w, r.FiltLast);
                    WriteChannels(w, r.FiltPkpk);
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
                "heart_rate, spo2, " +
                "fp1_alpha, fp1_beta, fp1_delta, fp1_theta, fp1_gamma, " +
                "fp2_alpha, fp2_beta, fp2_delta, fp2_theta, fp2_gamma, " +
                "t3_alpha, t3_beta, t3_delta, t3_theta, t3_gamma, " +
                "t4_alpha, t4_beta, t4_delta, t4_theta, t4_gamma) FROM STDIN (FORMAT BINARY)"))
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
                    WriteNullableInt(w, r.HeartRate);
                    WriteNullableInt(w, r.Spo2);
                    foreach (int ch in SchemaChannelOrder)
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

        /// <summary>Writes one per-channel family (four columns) in schema order — see <see cref="SchemaChannelOrder"/>.</summary>
        private static void WriteChannels(NpgsqlBinaryImporter w, float[] arr)
        {
            foreach (int ch in SchemaChannelOrder)
                WriteCh(w, arr, ch);
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

        private static void WriteNullableInt(NpgsqlBinaryImporter w, int? v)
        {
            if (v.HasValue) w.Write(v.Value, NpgsqlDbType.Integer);
            else w.WriteNull();
        }

        /// <summary>
        /// Flips sessions.sync_status to 'completed' for this session. Caller must hold
        /// <see cref="_ioLock"/>. Best-effort: a DB hiccup is logged, not thrown, so it can never
        /// break disposal. Only narrows from a non-completed state (won't disturb an already-final row).
        /// </summary>
        /// <summary>
        /// Accounts for a dropout that ran into the end of the session. <see cref="CopyRaw"/>'s drift
        /// guard can only notice a gap when a LATER frame arrives to reveal it, so a stream that dies
        /// and never comes back — headset stops sending at 16:00:15, technician stops the session at
        /// 16:00:27 — leaves those seconds uncounted. The WPF panel computes expected rows as
        /// (elapsed − dropout) × rate, so the uncounted dropout inflates "expected" and the missing
        /// seconds get reported as an upload shortfall: ~3000 phantom rows on session f0b59fc4
        /// (12 Jul), which read as the bridge losing data when the headset had simply stopped
        /// streaming. Nothing written to the DB was ever wrong — only the reconciliation.
        ///
        /// This does NOT overlap BridgeController's TailLossSeconds, which counts frames that DID
        /// arrive but landed after the drain window closed. In a trailing dropout no frame arrives at
        /// all, so neither counter sees it and there is nothing to double-count.
        ///
        /// Call once, after the final flush, with the instant recording stopped (local UTC). Only a
        /// gap beyond <see cref="MaxDriftTicks"/> counts — the same tolerance CopyRaw uses to
        /// distinguish genuine frame loss from ordinary BLE burst latency — so the sub-second jitter
        /// left at the tail of a healthy session is not reported as dropout.
        /// </summary>
        public void SealTrailingGap(DateTime stopUtc)
        {
            lock (_ioLock)
            {
                if (!_rawAnchored || _rawSampleIndex <= 0) return;

                long periodTicks = TimeSpan.TicksPerSecond / _sampleRate;
                // _rawSampleIndex is the NEXT index to write, so the last sample written sits one back.
                long lastSampleTicks = _rawBaseTicks + (_rawSampleIndex - 1) * periodTicks;
                long trailingTicks = ToDbTime(stopUtc).Ticks - lastSampleTicks;
                if (trailingTicks <= MaxDriftTicks) return;

                Interlocked.Add(ref _rawGapSamples, trailingTicks / periodTicks);
                Interlocked.Increment(ref _rawResyncs);   // it is a gap; the UI reports "Ns across N gap(s)"
                _log($"Stream ended {trailingTicks / (double)TimeSpan.TicksPerSecond:F1}s before the session was stopped " +
                     "— counted as Bluetooth dropout, not upload loss.");
            }
        }

        private void MarkCompletedInternal()
        {
            try
            {
                EnsureOpen();
                using (var cmd = new NpgsqlCommand(
                    "UPDATE sessions SET sync_status = 'completed' " +
                    "WHERE session_id = @sid AND sync_status IS DISTINCT FROM 'completed'", _conn))
                {
                    cmd.Parameters.AddWithValue("sid", NpgsqlDbType.Uuid, _sessionId);
                    int rows = cmd.ExecuteNonQuery();
                    _log(rows > 0 ? "Session marked 'completed'." : "Session already 'completed' (no change).");
                }
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _log("Mark-completed failed: " + ex.Message);
            }
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
                if (_markCompletedOnDispose) MarkCompletedInternal();   // after the drain, before close
                ResetConnection();
            }
            _log($"DB uploader stopped. Sent {EegRowsSent} eeg + {BandRowsSent} band + {RawRowsSent} raw + {FiltRowsSent} filt rows" +
                 (Dropped > 0 || RawDropped > 0 || FiltDropped > 0
                     ? $", dropped {Dropped} summary / {RawDropped} raw / {FiltDropped} filt frames (queue overflow)."
                     : ".") +
                 $"  Frames accepted: {RawFramesIn} raw / {FiltFramesIn} filt" +
                 (RawResyncs > 0 || FiltResyncs > 0
                     ? $"; {RawResyncs} raw / {FiltResyncs} filt timeline resync(s) (upstream frame loss)."
                     : "."));
        }
    }
}
