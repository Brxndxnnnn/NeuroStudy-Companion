-- O5.2: One administrator-managed image display interval for the entire site.
-- New sessions snapshot this value at pairing so later configuration changes do
-- not alter an in-progress or previously paired session.

CREATE TABLE IF NOT EXISTS public.site_settings (
    setting_key text PRIMARY KEY,
    image_display_interval_seconds smallint NOT NULL DEFAULT 10,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_site_settings_image_display_interval
        CHECK (image_display_interval_seconds BETWEEN 1 AND 60),
    CONSTRAINT chk_site_settings_image_display_interval_key
        CHECK (setting_key = 'global')
);

INSERT INTO public.site_settings (setting_key, image_display_interval_seconds)
VALUES ('global', 10)
ON CONFLICT (setting_key) DO NOTHING;

ALTER TABLE public.sessions
    ADD COLUMN IF NOT EXISTS image_display_interval_seconds smallint NOT NULL DEFAULT 10;

ALTER TABLE public.sessions
    DROP CONSTRAINT IF EXISTS chk_sessions_image_display_interval;

ALTER TABLE public.sessions
    ADD CONSTRAINT chk_sessions_image_display_interval
        CHECK (image_display_interval_seconds BETWEEN 1 AND 60);

-- Explicitly preserve the historical 10-second protocol timing for all existing sessions.
UPDATE public.sessions
SET image_display_interval_seconds = 10
WHERE image_display_interval_seconds IS NULL;

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

    v_claimed_at := clock_timestamp();

    UPDATE public.sessions
    SET
        client_id = p_client_id,
        conducted_by = p_conducted_by,
        clinic_id = p_clinic_id,
        stimulus_set_id = v_stimulus_set_id,
        image_display_interval_seconds = v_image_display_interval_seconds,
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

-- Records the authenticated administrator who last changed the global setting.
ALTER TABLE public.site_settings
    ADD COLUMN IF NOT EXISTS updated_by uuid
    REFERENCES public.users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_site_settings_updated_by
    ON public.site_settings (updated_by);

-- Dedicated RBAC permission for all global site-settings reads and updates.
INSERT INTO public.permissions (name, description)
VALUES ('site_settings:manage:all', 'Read and update global site settings')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM public.roles r
JOIN public.permissions p ON p.name = 'site_settings:manage:all'
WHERE r.name = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
