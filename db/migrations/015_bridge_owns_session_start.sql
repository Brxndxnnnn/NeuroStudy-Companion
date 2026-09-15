-- 015_bridge_owns_session_start.sql
--
-- Moves ownership of the recording-start transition from the website to the bridge
-- (client requirement #8, "Session Initiation Workflow Correction"): the technician
-- now presses "Start Session" in the WPF app, which writes sessions.sync_status =
-- 'recording' (and start_time) itself, instead of the website writing it and the
-- bridge reactively auto-starting off a poll. The website's "claimed" step and the
-- coordinated-END handshake (web writes 'completed' -> bridge drains and confirms)
-- are unchanged — this migration only extends what the bridge is allowed to write.
--
-- Migration 010 grants bridge_writer UPDATE on a column whitelist; migration 014
-- already had to re-list the whole set because GRANT UPDATE(cols) REPLACES the
-- column set for that privilege rather than adding to it. Same gotcha here: start_time
-- is new, everything else must be re-listed or bridge_writer silently loses UPDATE on
-- it (zero rows affected, no error, on every clinic machine already provisioned).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE '
      GRANT UPDATE(
        bridge_recording_at,
        sync_status,
        start_time,
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
