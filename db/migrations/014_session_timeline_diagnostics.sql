-- 014_session_timeline_diagnostics.sql
--
-- Records, per session, how much EEG actually arrived and how much never did — and
-- which timeline reconstruction produced it.
--
-- WHY
-- ---
-- Until now the bridge computed a full dropout reconciliation at the end of every
-- session (resync counts, gap seconds, frames-in vs rows-sent, tail loss) and then
-- threw all of it away: it was shown once in the WPF end-of-session summary and never
-- persisted. Nothing in the database could answer "why did this session yield so few
-- epochs?", so a low yield was indistinguishable from a short recording.
--
-- The measurement that forced this (27 Jul 2026, all 18 completed sessions): mean 20%
-- of EEG never reached the database, no session was clean, and the worst lost 67%.
-- None of that was visible from any stored column.
--
-- TIMELINE_VERSION IS THE LOAD-BEARING ONE
-- ----------------------------------------
-- Before this change the bridge's drift guard tolerated 3 s of accumulated loss before
-- inserting a gap, so sub-3-second losses were absorbed and the sample timeline was
-- silently COMPRESSED — samples either side of a missing second written as if
-- contiguous. Event windows therefore ran up to 3 s out of alignment with the EEG, and
-- no downstream contiguity check could see it (compressed samples are still uniformly
-- 4 ms apart). Every gap recorded in production was >= 3.00 s and not one below it —
-- the floor was the constant, not the hardware.
--
--   timeline_version = 1  ->  compressed timeline; epoch labels may be up to 3 s out.
--   timeline_version = 2  ->  sub-second drift tolerance; gaps are real, labels align.
--
-- Existing rows are backfilled to 1 and NEW rows default to 1, so a session written by
-- an OLD bridge against a NEW database is correctly marked as compressed rather than
-- silently inheriting the honest value. Only a bridge that actually applies the tighter
-- tolerance writes 2. ml_service uses this to keep the two populations apart — mixing
-- them is worse than either alone.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS timeline_version      smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS eeg_seconds_delivered double precision,
  ADD COLUMN IF NOT EXISTS eeg_gap_seconds       double precision,
  ADD COLUMN IF NOT EXISTS eeg_gap_count         integer,
  ADD COLUMN IF NOT EXISTS raw_gap_seconds       double precision,
  ADD COLUMN IF NOT EXISTS raw_gap_count         integer,
  ADD COLUMN IF NOT EXISTS frames_dropped        bigint,
  ADD COLUMN IF NOT EXISTS bridge_version        text;

COMMENT ON COLUMN public.sessions.timeline_version IS
  '1 = pre-fix compressed EEG timeline (labels up to 3 s misaligned); 2 = sub-second drift tolerance, gaps are real.';
COMMENT ON COLUMN public.sessions.eeg_seconds_delivered IS
  'Seconds of FILTERED EEG actually written (rows / sample_rate). Compare against end_time - start_time for the loss rate.';
COMMENT ON COLUMN public.sessions.eeg_gap_seconds IS
  'Seconds of filtered EEG that never arrived over BLE. This is the stream ml_service trains on.';
COMMENT ON COLUMN public.sessions.frames_dropped IS
  'Frames discarded by bridge-side queue overflow. Distinct from gap seconds (upstream loss) — this one WOULD be a bridge bug.';

-- Everything recorded before this migration came from a 3 s-tolerance bridge.
UPDATE public.sessions SET timeline_version = 1 WHERE timeline_version IS DISTINCT FROM 1;

-- ============================================================
-- Bridge write access.
--
-- Migration 010 grants bridge_writer UPDATE on exactly two columns of sessions
-- (bridge_recording_at, sync_status). A column-level grant is a whitelist, so without
-- this the diagnostics UPDATE fails on every activated clinic machine — and it would
-- fail QUIETLY in the same way MarkRecordingStarted documents: zero rows affected, no
-- error. Dev boxes connect as the owner and would have looked fine, so this would only
-- have surfaced in production.
--
-- sync_status is re-listed because GRANT UPDATE(cols) REPLACES the column set for that
-- privilege rather than adding to it.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE '
      GRANT UPDATE(
        bridge_recording_at,
        sync_status,
        timeline_version,
        eeg_seconds_delivered,
        eeg_gap_seconds,
        eeg_gap_count,
        raw_gap_seconds,
        raw_gap_count,
        frames_dropped,
        bridge_version
      ) ON TABLE public.sessions TO bridge_writer';
  END IF;
END
$$;

-- Lets ml_service and the loss-audit query find affected sessions without a seq scan
-- over every hypertable-joined row.
CREATE INDEX IF NOT EXISTS idx_sessions_timeline_version
  ON public.sessions (timeline_version)
  WHERE sync_status = 'completed';
