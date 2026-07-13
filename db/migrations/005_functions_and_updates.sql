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

INSERT INTO questions (question_no, prompt, correct_answer, difficulty) VALUES
(1, 'What is 7 + 5?',                                                          '12',        'basic'),
(2, 'What is 18 - 9?',                                                         '9',         'basic'),
(3, 'What is 6 × 4?',                                                          '24',        'basic'),
(4, 'What is 36 ÷ 6 + 7?',                                                     '13',        'intermediate'),
(5, 'Solve for x: 3x + 5 = 20',                                                '5',         'intermediate'),
(6, 'A rectangle has length 8 cm and width 5 cm. What is its area?',           '40 cm²',    'intermediate'),
(7, 'Solve for x: 2x² - 8x = 0',                                               'x = 0 or 4','advanced'),
(8, 'If y = 3x + 2, what is y when x = 5?',                                    '17',        'advanced'),
(9, 'A shop gives 15% discount on an item priced at 200. What is the final price?', '170',  'advanced');

CREATE TABLE questionnaires (
    questionnaire_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text        NOT NULL,
    description      text,
    version          text        NOT NULL DEFAULT '1.0',
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_questions (
    question_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    questionnaire_id uuid        NOT NULL REFERENCES questionnaires(questionnaire_id) ON DELETE CASCADE,
    question_no      integer     NOT NULL,
    statement        jsonb       NOT NULL, -- {"en": "...", "ms": "...", "zh": "..."}
    response_type    text        NOT NULL DEFAULT 'likert_5',
    domain           text,
    is_reverse_scored boolean    NOT NULL DEFAULT false,
    metadata         jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE(questionnaire_id, question_no)  -- enforces ordering uniqueness + replaces the index
);

CREATE TABLE session_questionnaire_responses (
    response_id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    questionnaire_id uuid        NOT NULL REFERENCES questionnaires(questionnaire_id) ON DELETE RESTRICT,
    question_id      uuid        NOT NULL REFERENCES questionnaire_questions(question_id) ON DELETE RESTRICT,
    response_value   jsonb       NOT NULL,
    clinic_id        uuid        REFERENCES clinics(clinic_id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE(session_id, question_id)
);

CREATE INDEX idx_session_questionnaire_responses_session ON session_questionnaire_responses(session_id);
CREATE INDEX idx_session_questionnaire_responses_clinic  ON session_questionnaire_responses(clinic_id);

ALTER TABLE session_questionnaire_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_questionnaire_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON session_questionnaire_responses
USING (
    current_setting('app.is_admin', true)::boolean = true
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

-- 26/06/2026 For storing SDK filtered data + tracking heart rate and Sp02 as requested by Mr Rashid
CREATE TABLE eeg_filtered_samples (
      session_id uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      time       timestamptz NOT NULL,
      fp1        real,        -- µV (SDK-filtered), NOT integer ADC counts
      fp2        real,
      t3         real,
      t4         real,
      PRIMARY KEY (session_id, time)
  );
SELECT create_hypertable('eeg_filtered_samples', by_range('time'));
SELECT set_chunk_time_interval('eeg_filtered_samples', INTERVAL '1 day');
GRANT SELECT, INSERT ON eeg_filtered_samples TO bridge_writer;
GRANT SELECT            ON eeg_filtered_samples TO app_user;

ALTER TABLE band_powers
      ADD COLUMN heart_rate integer,
      ADD COLUMN spo2       integer;

CREATE TABLE elliptic_band_stats (
    session_id      uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time_start      timestamptz NOT NULL,
    time_end        timestamptz NOT NULL,
    window_size_s   real        NOT NULL,
    step_s          real        NOT NULL,
    channel         text        NOT NULL,
    band            text        NOT NULL,
    mean            real        NOT NULL,
    std             real        NOT NULL,
    peak            real        NOT NULL,
    PRIMARY KEY (session_id, time_start, channel, band, window_size_s),
    CONSTRAINT chk_channel CHECK (channel IN ('fp1','fp2','t3','t4')),
    CONSTRAINT chk_band    CHECK (band IN ('delta','theta','alpha','beta','gamma'))
);

SELECT create_hypertable('elliptic_band_stats', by_range('time_start'));
SELECT set_chunk_time_interval('elliptic_band_stats', INTERVAL '1 day');