-- Client history from the intake questionnaire ("Client EEG & Tap Questionnaire"),
-- required before a client can be paired to a session.
--
-- Stored as dated, versioned histories rather than columns on clients: the form
-- records an intake date and "last 4 weeks" complaints, and clients are re-measured
-- after a course of treatment, so overwriting clients would lose what applied to
-- earlier sessions. Same lifecycle as clinic_stimulus_sets: per client at most one
-- 'draft' (editable, may be incomplete) and one 'active' (published, used for
-- pairing); publishing a new version marks the previous active one 'superseded'.
-- Published histories and their answers are never edited.
--
-- Workflow for the backend, in one transaction: insert the history as 'draft', insert
-- its complaint and symptom rows, then UPDATE status to 'active'. Publishing checks
-- that every section and every complaint/symptom row is present, so a history
-- cannot be inserted as 'active' directly.
--
-- claim_session snapshots the client's active history onto the session and refuses
-- to pair a client without one. So that existing clients can still be paired, every
-- client without a history receives a published default history (see the backfill
-- section). Clients registered after this migration have no history until one is
-- published, so client registration must create and publish one.
--
-- Custom SQLSTATEs (map in backend/src/middleware/errorHandler.js):
--   P2006 client has no published history (claim_session)         -> 409
--   P2201 client or history not found (or not visible to clinic)  -> 404
--   P2202 published history cannot be changed or deleted          -> 409
--   P2203 history incomplete, or not created as a draft           -> 400

BEGIN;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS public.client_histories (
    history_id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                     uuid        NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
    -- Copied from the client by trigger; never trust the caller's value.
    clinic_id                     uuid        NOT NULL REFERENCES public.clinics(clinic_id) ON DELETE CASCADE,
    -- NULL while draft; assigned 1, 2, 3... per client when published.
    version                       integer,
    status                        text        NOT NULL DEFAULT 'draft',

    -- "Date Intake & Measurement"
    intake_date                   date,
    -- Medical history: "Medical history, rehab stays, operations, etc."
    medical_history               text,
    -- Medical history: "Deficits/Observations in the conversation", split by the
    -- sub-headings the clinic uses.
    cognitive_behavioural_profile text,
    language_communication        text,
    social_observations           text,
    treatment_goals               text,
    -- Education & Work
    school_education              text,
    occupation                    text,
    hobbies                       text,

    created_by                    uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
    created_at                    timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at                    timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_by                  uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
    published_at                  timestamptz,

    CONSTRAINT chk_client_histories_status
        CHECK (status IN ('draft', 'active', 'superseded')),
    CONSTRAINT chk_client_histories_version
        CHECK ((status = 'draft') = (version IS NULL) AND (version IS NULL OR version > 0)),
    CONSTRAINT chk_client_histories_published_at
        CHECK ((status = 'draft') = (published_at IS NULL)),
    -- Every section is compulsory once published. NULLIF(btrim()) rejects NULL,
    -- empty and whitespace-only text alike.
    CONSTRAINT chk_client_histories_complete CHECK (
        status = 'draft' OR (
            intake_date IS NOT NULL AND
            NULLIF(btrim(medical_history), '')               IS NOT NULL AND
            NULLIF(btrim(cognitive_behavioural_profile), '') IS NOT NULL AND
            NULLIF(btrim(language_communication), '')        IS NOT NULL AND
            NULLIF(btrim(social_observations), '')           IS NOT NULL AND
            NULLIF(btrim(treatment_goals), '')               IS NOT NULL AND
            NULLIF(btrim(school_education), '')              IS NOT NULL AND
            NULLIF(btrim(occupation), '')                    IS NOT NULL AND
            NULLIF(btrim(hobbies), '')                       IS NOT NULL
        )
    ),
    CONSTRAINT uq_client_histories_version UNIQUE (client_id, version),
    -- Targets for the composite FKs below (child clinic_id, session client_id).
    CONSTRAINT uq_client_histories_id_clinic UNIQUE (history_id, clinic_id),
    CONSTRAINT uq_client_histories_id_client UNIQUE (history_id, client_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_histories_one_active
    ON public.client_histories (client_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_client_histories_one_draft
    ON public.client_histories (client_id) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_client_histories_clinic_id
    ON public.client_histories (clinic_id);

-- "In the last 4 weeks, how much did you feel affected by the following complaints?"
-- One row per complaint; a published history must have all six.
CREATE TABLE IF NOT EXISTS public.client_history_complaints (
    history_id uuid NOT NULL,
    clinic_id  uuid NOT NULL,
    complaint  text NOT NULL,
    severity   text NOT NULL,
    comment    text,
    PRIMARY KEY (history_id, complaint),
    CONSTRAINT chk_client_history_complaints_complaint CHECK (complaint IN (
        'headache', 'medication', 'sleep_quality', 'concentration', 'motor_activity', 'pain'
    )),
    CONSTRAINT chk_client_history_complaints_severity CHECK (severity IN (
        'not_affected', 'little_affected', 'strongly_affected'
    )),
    CONSTRAINT fk_client_history_complaints_history
        FOREIGN KEY (history_id, clinic_id)
        REFERENCES public.client_histories(history_id, clinic_id)
        ON DELETE CASCADE
);

-- "Part B2 - Symptoms": 1-10 expression per symptom; a published history must have all three.
CREATE TABLE IF NOT EXISTS public.client_history_symptoms (
    history_id uuid     NOT NULL,
    clinic_id  uuid     NOT NULL,
    symptom    text     NOT NULL,
    rating     smallint NOT NULL,
    notes      text,
    PRIMARY KEY (history_id, symptom),
    CONSTRAINT chk_client_history_symptoms_symptom CHECK (symptom IN (
        'concentration', 'motivation', 'social_skills'
    )),
    CONSTRAINT chk_client_history_symptoms_rating CHECK (rating BETWEEN 1 AND 10),
    CONSTRAINT fk_client_history_symptoms_history
        FOREIGN KEY (history_id, clinic_id)
        REFERENCES public.client_histories(history_id, clinic_id)
        ON DELETE CASCADE
);

-- ============================================================
-- History lifecycle.
--
-- pg_trigger_depth() > 1 identifies writes made from inside another trigger: the
-- supersede UPDATE issued below, and ON DELETE CASCADE from clients/clinics. Those
-- are the only paths allowed to touch published rows.
-- ============================================================
CREATE OR REPLACE FUNCTION public.client_histories_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_clinic_id uuid;
    v_complaint_count integer;
    v_symptom_count integer;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' AND pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'Published client history cannot be deleted'
                USING ERRCODE = 'P2202';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'Client history must be created as a draft, then published'
                USING ERRCODE = 'P2203';
        END IF;

        -- Runs as the caller, so RLS hides other clinics' clients.
        SELECT c.clinic_id
        INTO v_clinic_id
        FROM public.clients c
        WHERE c.client_id = NEW.client_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Client not found'
                USING ERRCODE = 'P2201';
        END IF;

        NEW.clinic_id := v_clinic_id;
        NEW.version := NULL;
        NEW.published_by := NULL;
        NEW.published_at := NULL;
        NEW.created_at := clock_timestamp();
        NEW.updated_at := NEW.created_at;
        RETURN NEW;
    END IF;

    -- UPDATE
    -- Internal supersede from a newer publish.
    IF pg_trigger_depth() > 1
       AND OLD.status = 'active'
       AND NEW.status = 'superseded' THEN
        RETURN NEW;
    END IF;

    IF OLD.status <> 'draft' THEN
        RAISE EXCEPTION 'Published client history cannot be modified; save a new version'
            USING ERRCODE = 'P2202';
    END IF;

    IF NEW.history_id IS DISTINCT FROM OLD.history_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Client history identity columns cannot be changed'
            USING ERRCODE = 'P2202';
    END IF;

    NEW.updated_at := clock_timestamp();

    IF NEW.status = 'draft' THEN
        RETURN NEW;
    END IF;

    IF NEW.status <> 'active' THEN
        RAISE EXCEPTION 'Client history can only be saved as draft or published as active'
            USING ERRCODE = 'P2202';
    END IF;

    -- Publishing (draft -> active). Serialize publishes per client so version numbers
    -- and the single active row stay consistent.
    PERFORM pg_advisory_xact_lock(hashtextextended('client_histories:' || NEW.client_id::text, 0));

    SELECT COUNT(*)::integer
    INTO v_complaint_count
    FROM public.client_history_complaints chc
    WHERE chc.history_id = NEW.history_id;

    SELECT COUNT(*)::integer
    INTO v_symptom_count
    FROM public.client_history_symptoms chs
    WHERE chs.history_id = NEW.history_id;

    -- The CHECK constraints limit each table to its fixed vocabulary and the primary
    -- keys prevent duplicates, so a full count means every item was answered.
    IF v_complaint_count <> 6 OR v_symptom_count <> 3 THEN
        RAISE EXCEPTION
            'Client history is incomplete: % of 6 complaints and % of 3 symptoms answered',
            v_complaint_count, v_symptom_count
            USING ERRCODE = 'P2203';
    END IF;

    UPDATE public.client_histories
    SET status = 'superseded'
    WHERE client_id = NEW.client_id
      AND status = 'active'
      AND history_id <> NEW.history_id;

    SELECT COALESCE(MAX(ch.version), 0) + 1
    INTO NEW.version
    FROM public.client_histories ch
    WHERE ch.client_id = NEW.client_id;

    NEW.published_at := NEW.updated_at;
    NEW.published_by := COALESCE(NEW.published_by, NEW.created_by);

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_client_histories_lifecycle ON public.client_histories;

CREATE TRIGGER trg_client_histories_lifecycle
BEFORE INSERT OR UPDATE OR DELETE
ON public.client_histories
FOR EACH ROW
EXECUTE FUNCTION public.client_histories_lifecycle();

-- ============================================================
-- Answer rows (complaints, symptoms) may only change while their history is a draft.
-- FOR SHARE on the parent blocks a concurrent publish until this write commits (and
-- vice versa), so answers cannot slip in after the completeness check.
-- ============================================================
CREATE OR REPLACE FUNCTION public.client_history_answers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_history_id uuid;
    v_clinic_id uuid;
    v_status text;
BEGIN
    -- Cascade from deleting the history (draft discard, client deletion).
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.history_id IS DISTINCT FROM OLD.history_id THEN
        RAISE EXCEPTION 'Client history answers cannot be moved to another history'
            USING ERRCODE = 'P2202';
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_history_id := OLD.history_id;
    ELSE
        v_history_id := NEW.history_id;
    END IF;

    SELECT ch.clinic_id, ch.status
    INTO v_clinic_id, v_status
    FROM public.client_histories ch
    WHERE ch.history_id = v_history_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Client history not found'
            USING ERRCODE = 'P2201';
    END IF;

    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'Answers of a published client history cannot be changed; save a new version'
            USING ERRCODE = 'P2202';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    NEW.clinic_id := v_clinic_id;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_client_history_complaints_guard ON public.client_history_complaints;

CREATE TRIGGER trg_client_history_complaints_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.client_history_complaints
FOR EACH ROW
EXECUTE FUNCTION public.client_history_answers_guard();

DROP TRIGGER IF EXISTS trg_client_history_symptoms_guard ON public.client_history_symptoms;

CREATE TRIGGER trg_client_history_symptoms_guard
BEFORE INSERT OR UPDATE OR DELETE
ON public.client_history_symptoms
FOR EACH ROW
EXECUTE FUNCTION public.client_history_answers_guard();

-- ============================================================
-- Backfill a default history for every existing client.
--
-- Agreed with Eugene (13 Oct 2026): the web app and bridge are not yet in official
-- use, so existing clients are test/pre-launch records. Each client without any
-- history gets a published version 1 so claim_session's new requirement does not
-- block pairing. The values are placeholders, not clinical answers: every text
-- field and comment carries v_marker so backfilled histories can be found with
--   WHERE medical_history = '<v_marker>'
-- and replaced by publishing a real version 2.
--
-- Goes through the normal lifecycle (draft -> answers -> active) so the triggers
-- apply the same checks as the backend. app.is_admin is set for this transaction
-- only, so the triggers' RLS-scoped lookups see every clinic's clients even when
-- this file is not run by a superuser. Re-running is a no-op: clients that already
-- have any history are skipped.
-- ============================================================
DO $$
DECLARE
    v_marker constant text := 'Not recorded: default client history backfilled when client histories were introduced';
BEGIN
    PERFORM set_config('app.is_admin', 'true', true);

    INSERT INTO public.client_histories (
        client_id,
        clinic_id,
        status,
        intake_date,
        medical_history,
        cognitive_behavioural_profile,
        language_communication,
        social_observations,
        treatment_goals,
        school_education,
        occupation,
        hobbies
    )
    SELECT
        c.client_id,
        c.clinic_id,
        'draft',
        CURRENT_DATE,
        v_marker, v_marker, v_marker, v_marker,
        v_marker, v_marker, v_marker, v_marker
    FROM public.clients c
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.client_histories ch
        WHERE ch.client_id = c.client_id
    );

    INSERT INTO public.client_history_complaints (history_id, clinic_id, complaint, severity, comment)
    SELECT ch.history_id, ch.clinic_id, v.complaint, 'not_affected', v_marker
    FROM public.client_histories ch
    CROSS JOIN (VALUES
        ('headache'), ('medication'), ('sleep_quality'),
        ('concentration'), ('motor_activity'), ('pain')
    ) AS v(complaint)
    WHERE ch.status = 'draft'
      AND ch.medical_history = v_marker
    ON CONFLICT (history_id, complaint) DO NOTHING;

    INSERT INTO public.client_history_symptoms (history_id, clinic_id, symptom, rating, notes)
    SELECT ch.history_id, ch.clinic_id, v.symptom, 1, v_marker
    FROM public.client_histories ch
    CROSS JOIN (VALUES
        ('concentration'), ('motivation'), ('social_skills')
    ) AS v(symptom)
    WHERE ch.status = 'draft'
      AND ch.medical_history = v_marker
    ON CONFLICT (history_id, symptom) DO NOTHING;

    UPDATE public.client_histories
    SET status = 'active'
    WHERE status = 'draft'
      AND medical_history = v_marker;
END
$$;

-- ============================================================
-- Session snapshot of the history used at pairing.
--
-- Nullable: sessions paired before this migration have no history. The composite FK
-- guarantees the snapshotted history belongs to the session's client.
-- ============================================================
ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS client_history_id uuid;

ALTER TABLE public.sessions
    DROP CONSTRAINT IF EXISTS fk_sessions_client_history;

ALTER TABLE public.sessions
    ADD CONSTRAINT fk_sessions_client_history
        FOREIGN KEY (client_history_id, client_id)
        REFERENCES public.client_histories(history_id, client_id)
        ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_client_history_id
    ON public.sessions (client_history_id)
    WHERE client_history_id IS NOT NULL;

-- Same as migration 017's version, plus the history requirement and snapshot.
-- The history lookup is also scoped to p_clinic_id, so a client from another clinic
-- can no longer be paired (SECURITY DEFINER bypasses RLS here).
CREATE OR REPLACE FUNCTION public.claim_session(
    p_pairing_code text,
    p_client_id uuid,
    p_conducted_by uuid,
    p_clinic_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_session jsonb;
    v_stimulus_set_id uuid;
    v_image_count integer;
    v_image_display_interval_seconds smallint;
    v_client_history_id uuid;
    v_claimed_at timestamptz;
BEGIN
    IF p_clinic_id IS NULL THEN
        RAISE EXCEPTION 'Clinic ID is required'
            USING ERRCODE = 'P2004';
    END IF;

    SELECT css.stimulus_set_id
    INTO v_stimulus_set_id
    FROM public.clinic_stimulus_sets css
    WHERE css.clinic_id = p_clinic_id
      AND css.status = 'active'
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'No active stimulus set is configured for this clinic'
            USING ERRCODE = 'P2001';
    END IF;

    SELECT image_display_interval_seconds
    INTO v_image_display_interval_seconds
    FROM public.site_settings
    WHERE setting_key = 'global'
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Global site settings are not configured'
            USING ERRCODE = 'P2005';
    END IF;

    SELECT COUNT(*)::integer
    INTO v_image_count
    FROM public.clinic_stimulus_set_images cssi
    WHERE cssi.stimulus_set_id = v_stimulus_set_id;

    IF v_image_count <> 24 THEN
        RAISE EXCEPTION
            'Active stimulus set must contain exactly 24 images; found %',
            v_image_count
            USING ERRCODE = 'P2003';
    END IF;

    -- FOR SHARE holds off a concurrent publish from superseding this history until
    -- the claim commits.
    SELECT ch.history_id
    INTO v_client_history_id
    FROM public.client_histories ch
    WHERE ch.client_id = p_client_id
      AND ch.clinic_id = p_clinic_id
      AND ch.status = 'active'
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Client history must be completed before a session can start'
            USING ERRCODE = 'P2006';
    END IF;

    v_claimed_at := clock_timestamp();

    UPDATE public.sessions
    SET
        client_id = p_client_id,
        conducted_by = p_conducted_by,
        clinic_id = p_clinic_id,
        stimulus_set_id = v_stimulus_set_id,
        image_display_interval_seconds = v_image_display_interval_seconds,
        client_history_id = v_client_history_id,
        sync_status = 'claimed',
        paired_at = v_claimed_at
    WHERE pairing_code = UPPER(TRIM(p_pairing_code))
      AND sync_status = 'unclaimed'
      AND (clinic_id IS NULL OR clinic_id = p_clinic_id)
    RETURNING jsonb_build_object(
        'session_id', session_id,
        'client_id', client_id,
        'clinic_id', clinic_id,
        'stimulus_set_id', stimulus_set_id,
        'image_display_interval_seconds', image_display_interval_seconds,
        'client_history_id', client_history_id,
        'paired_at', paired_at,
        'conducted_by', conducted_by,
        'device_id', device_id,
        'sync_status', sync_status,
        'start_time', start_time
    )
    INTO v_session;

    IF v_session IS NULL THEN
        RAISE EXCEPTION
            'Invalid pairing code or session already claimed'
            USING ERRCODE = 'P2002';
    END IF;

    RETURN v_session;
END;
$function$;

-- ============================================================
-- Tenant isolation, matching clinic_stimulus_sets.
-- ============================================================
ALTER TABLE public.client_histories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_histories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_history_complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_history_complaints FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_history_symptoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_history_symptoms FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_histories_tenant_policy ON public.client_histories;

CREATE POLICY client_histories_tenant_policy ON public.client_histories
FOR ALL
USING (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

DROP POLICY IF EXISTS client_history_complaints_tenant_policy ON public.client_history_complaints;

CREATE POLICY client_history_complaints_tenant_policy ON public.client_history_complaints
FOR ALL
USING (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

DROP POLICY IF EXISTS client_history_symptoms_tenant_policy ON public.client_history_symptoms;

CREATE POLICY client_history_symptoms_tenant_policy ON public.client_history_symptoms
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
-- to client medical history. The bridge never needs these tables. app_user is
-- granted explicitly because default privileges only apply when this file is run by
-- the role that set them.
-- ============================================================
REVOKE ALL ON TABLE
    public.client_histories,
    public.client_history_complaints,
    public.client_history_symptoms
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE 'REVOKE ALL ON TABLE
               public.client_histories,
               public.client_history_complaints,
               public.client_history_symptoms
             FROM bridge_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
               public.client_histories,
               public.client_history_complaints,
               public.client_history_symptoms
             TO app_user';
  END IF;
END
$$;

-- ============================================================
-- RBAC permissions, mirroring clients:* (admin = all clinics, technician = own).
-- ============================================================
INSERT INTO public.permissions (name, description)
VALUES
    ('client_histories:read:own_clinic',  'Read client histories within own clinic'),
    ('client_histories:read:all',         'Read client histories across all clinics'),
    ('client_histories:write:own_clinic', 'Create and publish client histories within own clinic'),
    ('client_histories:write:all',        'Create and publish client histories across all clinics')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p
  ON p.name IN ('client_histories:read:all', 'client_histories:write:all')
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p
  ON p.name IN ('client_histories:read:own_clinic', 'client_histories:write:own_clinic')
WHERE r.name = 'technician'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
