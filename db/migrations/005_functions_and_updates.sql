-- 1. Create or update the function safely
CREATE OR REPLACE FUNCTION claim_session(
    p_pairing_code text,
    p_client_id uuid,
    p_conducted_by uuid,
    p_clinic_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER -- Runs with the privileges of the owner (neurostudy_user), bypassing RLS
AS $$
DECLARE
    v_session jsonb;
BEGIN
    UPDATE sessions
    SET client_id    = p_client_id,
        conducted_by = p_conducted_by,
        clinic_id    = p_clinic_id,
        sync_status  = 'claimed',
        paired_at    = now(),
        start_time   = now()
    WHERE pairing_code = p_pairing_code
      AND sync_status  = 'unclaimed'
      AND clinic_id IS NULL 
    RETURNING jsonb_build_object(
        'session_id', session_id,
        'client_id', client_id,
        'clinic_id', clinic_id,
        'paired_at', paired_at,
        'conducted_by', conducted_by,
        'device_id', device_id,
        'start_time', start_time
    ) INTO v_session;

    IF v_session IS NULL THEN
        RAISE EXCEPTION 'Invalid pairing code or session already claimed';
    END IF;

    RETURN v_session;
END;
$$;

-- 2. Ensure your Node.js backend role has permission to call it
-- (Change 'app_user' to whatever your backend DB role is named)
GRANT EXECUTE ON FUNCTION claim_session(text, uuid, uuid, uuid) TO app_user;

ALTER TABLE sessions ADD COLUMN bridge_recording_at timestamptz;
ALTER TABLE sessions ADD CONSTRAINT sessions_sync_status_chk CHECK (sync_status IN ('unclaimed','claimed','recording','completed'));