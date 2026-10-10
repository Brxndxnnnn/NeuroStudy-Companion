-- ============================================================
-- Bridge read access to the event lookup tables (images, questions).
--
-- DbUploader.TryReadNewEvents polls the session's events and LEFT JOINs images and
-- questions to label each marker with the stimulus filename or question number.
-- Migration 010 revoked every table privilege from bridge_writer and only granted
-- SELECT back on sessions, events and session_questionnaire_responses, so activated
-- clinic roles (which inherit from bridge_writer) fail that poll with "permission
-- denied for table images" (and, once that is fixed, the same for questions). A LEFT
-- JOIN still needs SELECT on the joined table. Dev boxes connect as the owner, so
-- this only surfaced in production.
--
-- Column-level grants: the query only references each table's join key plus
-- images.filename and questions.question_no. Neither table has a clinic_id or RLS,
-- so any grant exposes every row; limiting the columns keeps the OASIS scores, URLs,
-- prompts, correct answers and other metadata out of reach of the clinic logins. If
-- the bridge later reads more columns, add them here rather than granting the tables.
--
-- GRANT is idempotent, and the role check matches 014/015 so a fresh database
-- without bridge_writer still migrates.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE 'GRANT SELECT(image_id, filename) ON TABLE public.images TO bridge_writer';
    EXECUTE 'GRANT SELECT(question_id, question_no) ON TABLE public.questions TO bridge_writer';
  END IF;
END
$$;
