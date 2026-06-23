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
ALTER TABLE images ADD COLUMN created_at timestamptz DEFAULT NOW();
ALTER TABLE images ADD COLUMN url TEXT NOT NULL, ADD COLUMN display_order INT NOT NULL;

-- Step 1: Drop NOT NULL on image_id first
ALTER TABLE events ALTER COLUMN image_id DROP NOT NULL;

-- Step 2: Create questions table
CREATE TABLE questions (
    question_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    question_no    INT         NOT NULL UNIQUE,
    prompt         TEXT        NOT NULL,
    correct_answer TEXT,                    -- NULL for open-ended/observation tasks
    difficulty     TEXT,                    -- 'basic', 'intermediate', 'advanced'
    metadata       JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 3: Add question_id FK and mutual exclusivity constraint to events
ALTER TABLE events
    ADD COLUMN question_id UUID REFERENCES questions(question_id) ON DELETE SET NULL,
    ADD CONSTRAINT chk_events_stimulus CHECK (
        (image_id IS NOT NULL AND question_id IS NULL) OR
        (image_id IS NULL AND question_id IS NOT NULL)
    );

-- 1. Update eeg_readings
ALTER TABLE eeg_readings RENAME COLUMN current_image_id TO current_event_id;
ALTER TABLE eeg_readings DROP CONSTRAINT IF EXISTS eeg_readings_current_image_id_fkey;
ALTER TABLE eeg_readings 
    ADD CONSTRAINT eeg_readings_current_event_id_fkey 
    FOREIGN KEY (current_event_id) REFERENCES events(event_id) ON DELETE SET NULL;

-- 2. Update band_powers
ALTER TABLE band_powers RENAME COLUMN current_image_id TO current_event_id;
ALTER TABLE band_powers DROP CONSTRAINT IF EXISTS band_powers_current_image_id_fkey;
ALTER TABLE band_powers 
    ADD CONSTRAINT band_powers_current_event_id_fkey 
    FOREIGN KEY (current_event_id) REFERENCES events(event_id) ON DELETE SET NULL;