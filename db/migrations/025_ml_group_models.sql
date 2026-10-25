-- 025: Phase 1 models are trained per GROUP of clients instead of per client
-- (21 Oct 2026 supervisor meeting).
--
-- A technician puts clients into a named group and trains one random-forest model on each
-- member's latest labelled session, with the client's BFI-2 domain scores as extra inputs.
-- A client may belong to several groups; the Insights tab shows whichever group model is
-- picked for a session.
--
-- 1. ml_groups / ml_group_members: clinic-owned, row-level secured like every other clinic
--    table, managed by the backend (app_user). A member must belong to the group's clinic.
-- 2. ml_models: owned by a group (group_id) instead of a client. Per-client models are
--    removed, as the global model was in 021: their predictions go with them (ON DELETE
--    CASCADE) and the automatic-pass status they set on sessions is cleared so the worker
--    re-predicts those sessions once a group model covers them.
-- 3. Training records how many clients a model pooled and its cross-validated score
--    without the BFI inputs, so every model can show whether BFI helped.
-- 4. RBAC: insights:write:* lets a technician manage groups and train their models.
--
-- Safe to re-run.

BEGIN;

SELECT set_config('app.is_admin', 'true', true);

-- ============================================================
-- 1. Groups and members
-- ============================================================
CREATE TABLE IF NOT EXISTS public.ml_groups (
    group_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id   uuid        NOT NULL REFERENCES public.clinics(clinic_id) ON DELETE CASCADE,
    name        text        NOT NULL CHECK (btrim(name) <> ''),
    created_by  uuid        REFERENCES public.users(user_id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Names are unique within a clinic, ignoring case and surrounding spaces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ml_groups_clinic_name
    ON public.ml_groups (clinic_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.ml_group_members (
    group_id   uuid        NOT NULL REFERENCES public.ml_groups(group_id) ON DELETE CASCADE,
    client_id  uuid        NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
    -- Copied from the group by the trigger below, so the tenant policy can use it directly.
    clinic_id  uuid        NOT NULL REFERENCES public.clinics(clinic_id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_group_members_client ON public.ml_group_members (client_id);

-- clinic_id always comes from the group, and the client must belong to that same clinic.
-- SECURITY DEFINER so the check sees the client row even under a caller's RLS scope; the
-- caller can only reach this trigger by inserting into a group it can already see.
CREATE OR REPLACE FUNCTION public.ml_group_members_set_clinic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
    v_group_clinic  uuid;
    v_client_clinic uuid;
BEGIN
    SELECT clinic_id INTO v_group_clinic FROM public.ml_groups WHERE group_id = NEW.group_id;
    SELECT clinic_id INTO v_client_clinic FROM public.clients WHERE client_id = NEW.client_id;
    IF v_group_clinic IS NULL OR v_client_clinic IS NULL OR v_group_clinic <> v_client_clinic THEN
        RAISE EXCEPTION 'Client % does not belong to the group''s clinic', NEW.client_id
            USING ERRCODE = 'P2501';
    END IF;
    NEW.clinic_id := v_group_clinic;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_ml_group_members_set_clinic ON public.ml_group_members;
CREATE TRIGGER trg_ml_group_members_set_clinic
BEFORE INSERT OR UPDATE ON public.ml_group_members
FOR EACH ROW EXECUTE FUNCTION public.ml_group_members_set_clinic();

ALTER TABLE public.ml_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ml_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ml_group_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ml_groups_tenant_policy ON public.ml_groups;
CREATE POLICY ml_groups_tenant_policy ON public.ml_groups
FOR ALL
USING (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

DROP POLICY IF EXISTS ml_group_members_tenant_policy ON public.ml_group_members;
CREATE POLICY ml_group_members_tenant_policy ON public.ml_group_members
FOR ALL
USING (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

-- Explicit grants, as in 023: default privileges would otherwise hand bridge_writer access.
REVOKE ALL ON TABLE public.ml_groups, public.ml_group_members FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bridge_writer') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.ml_groups, public.ml_group_members FROM bridge_writer';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ml_groups, public.ml_group_members TO app_user';
  END IF;
END
$$;

-- ============================================================
-- 2. Models belong to a group; per-client models are removed
-- ============================================================
ALTER TABLE public.ml_models
    ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.ml_groups(group_id) ON DELETE CASCADE;

UPDATE public.sessions
SET    predictions_status = NULL,
       predictions_error = NULL,
       predictions_model_version = NULL
WHERE  predictions_model_version IN (
           SELECT model_version FROM public.ml_models WHERE group_id IS NULL
       );

-- Cascades to session_predictions and ml_model_sessions.
DELETE FROM public.ml_models WHERE group_id IS NULL;

DROP INDEX IF EXISTS public.ml_models_one_current_per_client;
DROP INDEX IF EXISTS public.ml_models_client;
ALTER TABLE public.ml_models DROP COLUMN IF EXISTS client_id;

ALTER TABLE public.ml_models ALTER COLUMN group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ml_models_group ON public.ml_models (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS ml_models_one_current_per_group
    ON public.ml_models (group_id) WHERE is_current;

-- ============================================================
-- 3. What a group model was trained on, and the score without BFI
-- ============================================================
ALTER TABLE public.ml_models
    ADD COLUMN IF NOT EXISTS n_clients               integer,
    ADD COLUMN IF NOT EXISTS uses_bfi                boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cv_r2_valence_no_bfi    double precision,
    ADD COLUMN IF NOT EXISTS cv_r2_arousal_no_bfi    double precision,
    ADD COLUMN IF NOT EXISTS cv_mae_valence_no_bfi   double precision,
    ADD COLUMN IF NOT EXISTS cv_mae_arousal_no_bfi   double precision;

-- Which session each member contributed already lives in ml_model_sessions; the client
-- is recorded with it so the member list survives later group edits.
ALTER TABLE public.ml_model_sessions
    ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES public.clients(client_id) ON DELETE CASCADE;

-- ============================================================
-- 4. RBAC
-- ============================================================
INSERT INTO public.permissions (name, description)
VALUES
    ('insights:write:own_clinic', 'Manage ML groups and train their models within own clinic'),
    ('insights:write:all',        'Manage ML groups and train their models across all clinics')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p ON p.name = 'insights:write:all'
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p ON p.name = 'insights:write:own_clinic'
WHERE r.name = 'technician'
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
