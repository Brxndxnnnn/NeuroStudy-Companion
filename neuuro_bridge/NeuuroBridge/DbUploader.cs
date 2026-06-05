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

        private const int FlushIntervalMs = 500;     // batch window for eeg_readings (~2 flushes/s)
        private const int MaxQueued       = 20000;    // bound each queue so a dead DB can't OOM us

        private readonly string _connString;
        private readonly Action<string> _log;
        private readonly object _ioLock = new object();

        private readonly ConcurrentQueue<EegReadingRow> _eegQ = new ConcurrentQueue<EegReadingRow>();
        private readonly ConcurrentQueue<BandPowerRow>  _bandQ = new ConcurrentQueue<BandPowerRow>();

        private NpgsqlConnection _conn;
        private Timer _flushTimer;
        private Guid _sessionId;
        private TimeSpan _clockOffset = TimeSpan.Zero;  // DbNow = UtcNow + offset
        private long _eegRowsSent;
        private long _bandRowsSent;
        private long _dropped;
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
        public long Dropped      => Interlocked.Read(ref _dropped);
        public string LastError  => _lastError;

        /// <summary>Bridge clock mapped onto the DB timeline (see clock-sync note in the design doc).</summary>
        public DateTime DbNow => DateTime.UtcNow + _clockOffset;

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
            lock (_ioLock)
            {
                try
                {
                    EnsureOpen();
                    using (var tx = _conn.BeginTransaction())
                    {
                        Exec(tx,
                            "INSERT INTO clients (client_id, name, notes) VALUES (@id, @name, @notes) " +
                            "ON CONFLICT (client_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderClientId)),
                            ("name", NpgsqlDbType.Text, "⟨Unclaimed⟩ — pending pairing"),
                            ("notes", NpgsqlDbType.Text, "Placeholder client for bridge-created sessions awaiting frontend claim."));

                        Exec(tx,
                            "INSERT INTO users (user_id, email, password_hash, clinic_id, display_name) " +
                            "VALUES (@id, @email, @pw, NULL, @name) ON CONFLICT (user_id) DO NOTHING",
                            ("id", NpgsqlDbType.Uuid, Guid.Parse(PlaceholderUserId)),
                            ("email", NpgsqlDbType.Text, "bridge-system@neurostudy.local"),
                            ("pw", NpgsqlDbType.Text, "!"),   // non-bcrypt sentinel: can never authenticate
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

        /// <summary>Drains both queues to the DB. Caller must hold <see cref="_ioLock"/>.</summary>
        private void Flush()
        {
            if (_eegQ.IsEmpty && _bandQ.IsEmpty) return;
            EnsureOpen();

            int eeg = CopyEeg();
            int band = CopyBand();
            if (eeg > 0)  Interlocked.Add(ref _eegRowsSent, eeg);
            if (band > 0) Interlocked.Add(ref _bandRowsSent, band);
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
            _log($"DB uploader stopped. Sent {EegRowsSent} eeg + {BandRowsSent} band rows" +
                 (Dropped > 0 ? $", dropped {Dropped} (queue overflow)." : "."));
        }
    }
}
