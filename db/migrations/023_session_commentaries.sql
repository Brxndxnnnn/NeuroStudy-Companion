-- Post-session commentary written by the technician after a session completes.
-- The PDF report (Section A) is blocked until a session has an active commentary.
--
-- Versioned like clinic_stimulus_sets: every published save is a new row and earlier
-- versions are kept for future history views. Per session there is at most one
-- 'draft' (work in progress, editable, fields may be empty) and at most one 'active'
-- (the published version the report uses). Publishing a new version marks the previous
-- active row 'superseded'. Published rows are never edited.
--
-- Report readiness is derived from "an active commentary exists" rather than a new
-- sessions.sync_status value: 'completed' is the terminal recording state that the
-- bridge, ML jobs, cleanup and admin filters all depend on.
--
-- Custom SQLSTATEs (map in backend/src/middleware/errorHandler.js):
--   P2101 session not found (or not visible to this clinic)   -> 404
--   P2102 session has not completed                           -> 409
--   P2103 published commentary cannot be changed or deleted   -> 409

BEGIN;

CREATE TABLE IF NOT EXISTS public.session_commentaries (
    commentary_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            uuid        NOT NULL REFERENCES public.sessions(session_id) ON DELETE CASCADE,
    -- Copied from the session by trigger; never trust the caller's value.
    clinic_id             uuid        NOT NULL REFERENCES public.clinics(clinic_id) ON DELETE CASCADE,
    -- NULL while draft; assigned 1, 2, 3... per session when published.
    version               integer,
    status                text        NOT NULL DEFAULT 'draft',

    -- Report sections, in report order. Nullable so drafts can be partial.
    anamnesis             text,
    eeg_premeasurement    text,
    eeg_eyes_closed       text,
    eeg_eyes_open         text,
    eeg_cognitive_task    text,
    eeg_conclusion        text,
    prognostic_estimation text,

    created_by            uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_by          uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
    published_at          timestamptz,

    CONSTRAINT chk_session_commentaries_status
        CHECK (status IN ('draft', 'active', 'superseded')),
    CONSTRAINT chk_session_commentaries_version
        CHECK ((status = 'draft') = (version IS NULL) AND (version IS NULL OR version > 0)),
    CONSTRAINT chk_session_commentaries_published_at
        CHECK ((status = 'draft') = (published_at IS NULL)),
    -- Every section is compulsory once published. NULLIF(btrim()) rejects NULL,
    -- empty and whitespace-only text alike.
    CONSTRAINT chk_session_commentaries_complete CHECK (
        status = 'draft' OR (
            NULLIF(btrim(anamnesis), '')             IS NOT NULL AND
            NULLIF(btrim(eeg_premeasurement), '')    IS NOT NULL AND
            NULLIF(btrim(eeg_eyes_closed), '')       IS NOT NULL AND
            NULLIF(btrim(eeg_eyes_open), '')         IS NOT NULL AND
            NULLIF(btrim(eeg_cognitive_task), '')    IS NOT NULL AND
            NULLIF(btrim(eeg_conclusion), '')        IS NOT NULL AND
            NULLIF(btrim(prognostic_estimation), '') IS NOT NULL
        )
    ),
    CONSTRAINT uq_session_commentaries_version UNIQUE (session_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_commentaries_one_active
    ON public.session_commentaries (session_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_commentaries_one_draft
    ON public.session_commentaries (session_id) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_session_commentaries_clinic_id
    ON public.session_commentaries (clinic_id);

-- ============================================================
-- Lifecycle enforcement.
--
-- pg_trigger_depth() > 1 identifies writes made from inside another trigger: the
-- supersede UPDATE issued by this function, and ON DELETE CASCADE from sessions
-- (O2.2 admin deletion). Those are the only paths allowed to touch published rows.
-- ============================================================
CREATE OR REPLACE FUNCTION public.session_commentaries_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_clinic_id uuid;
    v_sync_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' AND pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'Published session commentary cannot be deleted'
                USING ERRCODE = 'P2103';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Internal supersede from a newer publish.
        IF pg_trigger_depth() > 1
           AND OLD.status = 'active'
           AND NEW.status = 'superseded' THEN
            RETURN NEW;
        END IF;

        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'Published session commentary cannot be modified; save a new version'
                USING ERRCODE = 'P2103';
        END IF;

        IF NEW.commentary_id IS DISTINCT FROM OLD.commentary_id
           OR NEW.session_id IS DISTINCT FROM OLD.session_id
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'Session commentary identity columns cannot be changed'
                USING ERRCODE = 'P2103';
        END IF;
    END IF;

    IF NEW.status NOT IN ('draft', 'active') THEN
        RAISE EXCEPTION 'Session commentary can only be saved as draft or active'
            USING ERRCODE = 'P2103';
    END IF;

    -- Runs as the caller, so RLS hides other clinics' sessions: "not found" is
    -- deliberate and does not reveal that the session exists.
    SELECT s.clinic_id, s.sync_status
    INTO v_clinic_id, v_sync_status
    FROM public.sessions s
    WHERE s.session_id = NEW.session_id;

    IF NOT FOUND OR v_clinic_id IS NULL THEN
        RAISE EXCEPTION 'Session not found'
            USING ERRCODE = 'P2101';
    END IF;

    IF v_sync_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'Commentary can only be written after the session has completed'
            USING ERRCODE = 'P2102';
    END IF;

    NEW.clinic_id := v_clinic_id;
    NEW.updated_at := clock_timestamp();
    IF TG_OP = 'INSERT' THEN
        NEW.created_at := NEW.updated_at;
    END IF;

    IF NEW.status = 'draft' THEN
        NEW.version := NULL;
        NEW.published_by := NULL;
        NEW.published_at := NULL;
        RETURN NEW;
    END IF;

    -- Publishing (insert as active, or draft -> active). Serialize publishes per
    -- session so version numbers and the single active row stay consistent. An
    -- advisory lock avoids taking row locks on sessions, which the bridge updates.
    PERFORM pg_advisory_xact_lock(hashtextextended('session_commentaries:' || NEW.session_id::text, 0));

    UPDATE public.session_commentaries
    SET status = 'superseded'
    WHERE session_id = NEW.session_id
      AND status = 'active'
      AND commentary_id <> NEW.commentary_id;

    SELECT COALESCE(MAX(sc.version), 0) + 1
    INTO NEW.version
    FROM public.session_commentaries sc
    WHERE sc.session_id = NEW.session_id;

    NEW.published_at := NEW.updated_at;
    NEW.published_by := COALESCE(NEW.published_by, NEW.created_by);

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_session_commentaries_lifecycle ON public.session_commentaries;

CREATE TRIGGER trg_session_commentaries_lifecycle
BEFORE INSERT OR UPDATE OR DELETE
ON public.session_commentaries
FOR EACH ROW
EXECUTE FUNCTION public.session_commentaries_lifecycle();

-- ============================================================
-- Tenant isolation, matching clinic_stimulus_sets.
-- ============================================================
ALTER TABLE public.session_commentaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_commentaries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_commentaries_tenant_policy ON public.session_commentaries;

CREATE POLICY session_commentaries_tenant_policy ON public.session_commentaries
FOR ALL
USING (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

-- ============================================================
-- Privileges.
--
-- Explicit rather than relying on default privileges: 002 sets default ALL on new
-- tables for bridge_writer, so clinic bridge logins would otherwise get full access
-- to clinical commentary. The bridge never needs this table. app_user is granted
-- explicitly because default privileges only apply when this file is run by the
-- role that set them.
-- ============================================================
REVOKE ALL ON TABLE public.session_commentaries FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.session_commentaries FROM bridge_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.session_commentaries TO app_user';
  END IF;
END
$$;

-- ============================================================
-- RBAC permissions, mirroring sessions:* (admin = all clinics, technician = own).
-- ============================================================
INSERT INTO public.permissions (name, description)
VALUES
    ('session_commentaries:read:own_clinic',  'Read session commentaries within own clinic'),
    ('session_commentaries:read:all',         'Read session commentaries across all clinics'),
    ('session_commentaries:write:own_clinic', 'Create and publish session commentaries within own clinic'),
    ('session_commentaries:write:all',        'Create and publish session commentaries across all clinics')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p
  ON p.name IN ('session_commentaries:read:all', 'session_commentaries:write:all')
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p
  ON p.name IN ('session_commentaries:read:own_clinic', 'session_commentaries:write:own_clinic')
WHERE r.name = 'technician'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
