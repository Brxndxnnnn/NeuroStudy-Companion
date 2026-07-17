"""
tests/test_feature_worker.py

The worker's contract, and the two things the elliptic adapter exists to guarantee.

These run against a fake connection — no database needed. What is being pinned here is
not arithmetic but ORDERING and OWNERSHIP, which is where this kind of code goes wrong:
who deletes, who commits, and what survives a crash.
"""

import pytest
from sqlalchemy import text

from app.features import elliptic, fft_bandpower, session_features
from app.workers import feature_jobs


class FakeResult:
    def __init__(self, rowcount=0, rows=None):
        self.rowcount = rowcount
        self._rows = rows or []

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows

    def __iter__(self):
        return iter(self._rows)


class FakeConn:
    """Records every statement, so the ORDER of operations can be asserted."""

    def __init__(self, results=None):
        self.statements = []
        self.committed = False
        self._results = results or {}

    def execute(self, stmt, params=None):
        sql = str(stmt.text if hasattr(stmt, "text") else stmt)
        self.statements.append((" ".join(sql.split()), params))
        for needle, result in self._results.items():
            if needle in sql:
                return result
        return FakeResult()

    def commit(self):
        self.committed = True


class TestEllipticAdapter:

    def test_deletes_the_sessions_rows_before_writing(self, monkeypatch):
        """
        The writer inserts with ON CONFLICT ... DO NOTHING, so without a prior DELETE a
        recompute would silently keep the OLD values — appearing to succeed while
        changing nothing. The DELETE must happen, and must happen FIRST.
        """
        order = []

        conn = FakeConn(results={"DELETE FROM elliptic_band_stats": FakeResult(rowcount=2084)})

        def fake_pipeline(c, sid, window_size_s, step_s):
            order.append("pipeline")
            return {"n_rows": 4168, "window_size_s": window_size_s, "step_s": step_s}

        monkeypatch.setattr(elliptic, "run_elliptic_pipeline", fake_pipeline)

        n = elliptic.compute_session_features(conn, "abc")

        deletes = [s for s, _ in conn.statements if s.startswith("DELETE FROM elliptic_band_stats")]
        assert len(deletes) == 1, conn.statements
        # The DELETE was issued before the pipeline ran.
        assert conn.statements[0][0].startswith("DELETE FROM elliptic_band_stats")
        assert order == ["pipeline"]
        assert n == 4168

    def test_delete_is_not_scoped_to_one_window_size(self, monkeypatch):
        """
        window_size_s is part of the writer's ON CONFLICT key, so 1.0s and 2.0s rows do
        not collide — they ACCUMULATE. A session already holding 1.0s rows would end up
        holding both, and the read endpoint (a bare SELECT *) would hand the frontend two
        different analyses interleaved on the same time axis.

        So the DELETE must NOT mention window_size_s. One session, one configuration.
        """
        conn = FakeConn()
        monkeypatch.setattr(
            elliptic, "run_elliptic_pipeline",
            lambda c, sid, window_size_s, step_s: {
                "n_rows": 0, "window_size_s": window_size_s, "step_s": step_s
            },
        )

        elliptic.compute_session_features(conn, "abc")

        delete_sql = conn.statements[0][0]
        assert "window_size_s" not in delete_sql, (
            "the DELETE must clear every row for the session, whatever window size "
            f"produced it — got: {delete_sql}"
        )

    def test_uses_the_specified_1s_window(self, monkeypatch):
        """
        1s / 0.5s is the client's specification. Pinned so it cannot drift silently.

        Carry the caveat, don't act on it: delta runs to 0.5 Hz, which is half a cycle
        in a 1s window, so the delta statistics are not really measuring delta. Theta is
        the lowest band this window fully resolves. Widen the WINDOW (not the step) if
        delta ever needs to be believed.
        """
        captured = {}

        def fake_pipeline(c, sid, window_size_s, step_s):
            captured.update(window_size_s=window_size_s, step_s=step_s)
            return {"n_rows": 1, "window_size_s": window_size_s, "step_s": step_s}

        monkeypatch.setattr(elliptic, "run_elliptic_pipeline", fake_pipeline)
        elliptic.compute_session_features(FakeConn(), "abc")

        assert captured["window_size_s"] == 1.0
        assert captured["step_s"] == 0.5

    def test_does_not_commit(self, monkeypatch):
        """
        The worker owns the transaction. That is what makes the DELETE safe: if the
        pipeline throws, the DELETE rolls back with it and the PREVIOUS analysis
        survives, rather than the session being left with an empty table.
        """
        conn = FakeConn()
        monkeypatch.setattr(
            elliptic, "run_elliptic_pipeline",
            lambda c, sid, window_size_s, step_s: {
                "n_rows": 1, "window_size_s": window_size_s, "step_s": step_s
            },
        )

        elliptic.compute_session_features(conn, "abc")
        assert conn.committed is False

    def test_propagates_failure(self, monkeypatch):
        """A session with no filtered EEG must raise, not quietly write zero rows."""
        def boom(c, sid, window_size_s, step_s):
            raise ValueError("No eeg_filtered_samples found for session abc.")

        monkeypatch.setattr(elliptic, "run_elliptic_pipeline", boom)

        with pytest.raises(ValueError, match="No eeg_filtered_samples"):
            elliptic.compute_session_features(FakeConn(), "abc")


class TestFftAdapter:

    def test_deletes_before_writing_and_returns_row_count(self, monkeypatch):
        """
        Same idempotency guarantee as the elliptic adapter: DELETE the session's rows
        first (so a shorter recompute leaves no orphans), then run the pipeline.
        """
        order = []
        conn = FakeConn(results={"DELETE FROM fft_band_powers": FakeResult(rowcount=500)})

        def fake_pipeline(c, sid, window_size_s, step_s):
            order.append("pipeline")
            return {"n_rows": 640, "window_size_s": window_size_s, "step_s": step_s}

        monkeypatch.setattr(fft_bandpower, "run_fft_band_power_pipeline", fake_pipeline)

        n = fft_bandpower.compute_session_fft_band_powers(conn, "abc")

        assert conn.statements[0][0].startswith("DELETE FROM fft_band_powers")
        assert "window_size_s" not in conn.statements[0][0], "DELETE must clear all rows"
        assert order == ["pipeline"]
        assert n == 640

    def test_uses_a_2s_window_that_resolves_delta(self, monkeypatch):
        """2s / 0.5s is the default: 2s holds a full 0.5 Hz delta cycle, unlike 1s."""
        captured = {}

        def fake_pipeline(c, sid, window_size_s, step_s):
            captured.update(window_size_s=window_size_s, step_s=step_s)
            return {"n_rows": 1, "window_size_s": window_size_s, "step_s": step_s}

        monkeypatch.setattr(fft_bandpower, "run_fft_band_power_pipeline", fake_pipeline)
        fft_bandpower.compute_session_fft_band_powers(FakeConn(), "abc")

        assert captured["window_size_s"] == 2.0
        assert captured["step_s"] == 0.5


class TestSessionFeaturesOrchestrator:

    def test_runs_both_stages_and_sums_rows(self, monkeypatch):
        """The worker's entrypoint computes elliptic AND FFT, returning the total."""
        monkeypatch.setattr(session_features, "_compute_elliptic",
                            lambda c, sid: 4168)
        monkeypatch.setattr(session_features, "compute_session_fft_band_powers",
                            lambda c, sid: 640)

        assert session_features.compute_session_features(FakeConn(), "abc") == 4808

    def test_elliptic_failure_short_circuits_fft(self, monkeypatch):
        """
        Elliptic runs first and raises when a session has no filtered EEG. The FFT stage
        must not run — neither feature set is computable without EEG, and the worker
        fails the whole session.
        """
        def boom(c, sid):
            raise ValueError("No eeg_filtered_samples found for session abc.")

        fft_ran = []
        monkeypatch.setattr(session_features, "_compute_elliptic", boom)
        monkeypatch.setattr(session_features, "compute_session_fft_band_powers",
                            lambda c, sid: fft_ran.append(True))

        with pytest.raises(ValueError, match="No eeg_filtered_samples"):
            session_features.compute_session_features(FakeConn(), "abc")
        assert fft_ran == [], "FFT stage must not run after elliptic fails"


class TestWorkerWiring:

    def test_worker_resolves_the_adapter(self):
        """
        The default FEATURE_COMPUTE_FN must import. It points at the orchestrator that
        runs elliptic + FFT band powers together for a completed session.
        """
        assert feature_jobs.COMPUTE_FN_PATH == "app.features.session_features:compute_session_features"
        fn = feature_jobs.load_compute_fn()
        assert fn is session_features.compute_session_features

    def test_claim_is_conditional(self):
        """
        The claim must refuse a session another worker already holds. Several schedulers
        tick at once (uvicorn workers, the dev reloader), and without this they would
        both compute the same session.
        """
        conn = FakeConn()
        feature_jobs._claim(conn, "abc")
        sql = conn.statements[0][0]
        assert "features_status IS DISTINCT FROM 'running'" in sql
        assert "RETURNING" in sql

    def test_claim_reports_loss(self):
        """No row returned = someone else won it. The worker must skip, not proceed."""
        conn = FakeConn(results={"UPDATE sessions": FakeResult(rows=[])})
        assert feature_jobs._claim(conn, "abc") is False

    def test_pending_only_looks_at_completed_sessions(self):
        """
        'completed' is written by the BRIDGE after its final flush. Any earlier state and
        the EEG is still being written, so the features would be computed on a truncated
        tail of the recording.
        """
        conn = FakeConn()
        feature_jobs.pending_sessions(conn)
        sql = conn.statements[0][0]
        assert "sync_status = 'completed'" in sql
        assert "features_status IS NULL" in sql
