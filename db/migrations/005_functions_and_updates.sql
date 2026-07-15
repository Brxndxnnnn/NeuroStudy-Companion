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

-- 26/06/2026 For storing SDK filtered data + tracking heart rate and Sp02 as requested by Brandon
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

-- 14/07/2026 For storing elliptic band stats as requested Zheng Da
CREATE TABLE elliptic_band_stats (
    session_id      uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time_start      timestamptz NOT NULL,
    time_end        timestamptz NOT NULL,
    window_size_s   real        NOT NULL,
    step_s          real        NOT NULL,
    channel         text        NOT NULL,
    delta_mean      real        NOT NULL,
    delta_std       real        NOT NULL,
    delta_peak      real        NOT NULL,
    theta_mean      real        NOT NULL,
    theta_std       real        NOT NULL,
    theta_peak      real        NOT NULL,
    alpha_mean      real        NOT NULL,
    alpha_std       real        NOT NULL,
    alpha_peak      real        NOT NULL,
    beta_mean       real        NOT NULL,
    beta_std        real        NOT NULL,
    beta_peak       real        NOT NULL,
    gamma_mean      real        NOT NULL,
    gamma_std       real        NOT NULL,
    gamma_peak      real        NOT NULL,
    PRIMARY KEY (session_id, time_start, channel, window_size_s),
    CONSTRAINT chk_channel CHECK (channel IN ('fp1','fp2','t3','t4'))
);
ALTER TABLE elliptic_band_stats ADD COLUMN window_number integer NOT NULL DEFAULT 0;

SELECT create_hypertable('elliptic_band_stats', by_range('time_start'));
SELECT set_chunk_time_interval('elliptic_band_stats', INTERVAL '1 day');
-- 14/07/2026 For updating images table to store valence and arousal mean and standard deviation
ALTER TABLE images RENAME COLUMN valence_score TO valence_mean;
ALTER TABLE images RENAME COLUMN arousal_score TO arousal_mean;
ALTER TABLE images
    ALTER COLUMN valence_mean TYPE double precision USING valence_mean::double precision,
    ALTER COLUMN arousal_mean TYPE double precision USING arousal_mean::double precision;
ALTER TABLE images
    ADD COLUMN valence_sd double precision,
    ADD COLUMN arousal_sd double precision;
ALTER TABLE images
    ADD CONSTRAINT chk_images_valence_sd_non_negative CHECK (valence_sd IS NULL OR valence_sd >= 0),
    ADD CONSTRAINT chk_images_arousal_sd_non_negative CHECK (arousal_sd IS NULL OR arousal_sd >= 0);
ALTER TABLE images ALTER COLUMN display_order DROP NOT NULL;
-- 14/07/2026 For creating clinic_stimulus_sets and clinic_stimulus_set_images tables
CREATE TABLE clinic_stimulus_sets(
    stimulus_set_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id uuid NOT NULL REFERENCES clinics(clinic_id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT 'Default image set',
    version integer NOT NULL,
    status text NOT NULL DEFAULT 'draft',
    created_by uuid REFERENCES users(user_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    activated_at timestamptz,
    CONSTRAINT chk_clinic_stimulus_sets_status CHECK (status IN ('draft', 'active', 'archived')),
    CONSTRAINT chk_clinic_stimulus_sets_version CHECK (version > 0),
    CONSTRAINT uq_clinic_stimulus_sets_version UNIQUE (clinic_id, version),
    CONSTRAINT uq_clinic_stimulus_sets_id_clinic UNIQUE (stimulus_set_id, clinic_id)
);
CREATE UNIQUE INDEX uq_clinic_one_active_stimulus_set ON clinic_stimulus_sets (clinic_id) WHERE status = 'active';
CREATE TABLE clinic_stimulus_set_images (
    stimulus_set_id uuid NOT NULL,
    clinic_id uuid NOT NULL,
    image_id uuid NOT NULL REFERENCES images(image_id) ON DELETE RESTRICT,
    sequence_no smallint NOT NULL,
    added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (stimulus_set_id, image_id),
    CONSTRAINT uq_stimulus_set_sequence UNIQUE (stimulus_set_id, sequence_no),
    CONSTRAINT chk_stimulus_sequence_range CHECK (sequence_no BETWEEN 1 AND 24),
    CONSTRAINT fk_stimulus_set_clinic
        FOREIGN KEY (stimulus_set_id, clinic_id)
        REFERENCES clinic_stimulus_sets(
            stimulus_set_id,
            clinic_id
        )
        ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION public.validate_stimulus_set_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    selected_count integer;
    distinct_sequence_count integer;
BEGIN
    IF NEW.status = 'active'
       AND OLD.status IS DISTINCT FROM 'active'
    THEN
        SELECT
            COUNT(*),
            COUNT(DISTINCT sequence_no)
        INTO
            selected_count,
            distinct_sequence_count
        FROM public.clinic_stimulus_set_images
        WHERE stimulus_set_id = NEW.stimulus_set_id;

        IF selected_count <> 24 THEN
            RAISE EXCEPTION
                'Stimulus set must contain exactly 24 images; found %',
                selected_count;
        END IF;

        IF distinct_sequence_count <> 24 THEN
            RAISE EXCEPTION
                'Stimulus set must contain sequence numbers 1 through 24';
        END IF;

        NEW.activated_at = clock_timestamp();
    END IF;

    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_validate_stimulus_set_activation
BEFORE UPDATE OF status
ON public.clinic_stimulus_sets
FOR EACH ROW
EXECUTE FUNCTION public.validate_stimulus_set_activation();

ALTER TABLE public.clinic_stimulus_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_stimulus_sets FORCE ROW LEVEL SECURITY;

CREATE POLICY clinic_stimulus_sets_tenant_policy ON public.clinic_stimulus_sets
FOR ALL
USING (
    COALESCE(
        NULLIF(
            current_setting('app.is_admin', true),
            ''
        )::boolean,
        false
    )
    OR clinic_id = NULLIF(
        current_setting('app.current_clinic_id', true),
        ''
    )::uuid
)
WITH CHECK (
    COALESCE(
        NULLIF(
            current_setting('app.is_admin', true),
            ''
        )::boolean,
        false
    )
    OR clinic_id = NULLIF(
        current_setting('app.current_clinic_id', true),
        ''
    )::uuid
);

ALTER TABLE public.clinic_stimulus_set_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_stimulus_set_images FORCE ROW LEVEL SECURITY;

CREATE POLICY clinic_stimulus_set_images_tenant_policy
ON public.clinic_stimulus_set_images
FOR ALL
USING (
    COALESCE(
        NULLIF(
            current_setting('app.is_admin', true),
            ''
        )::boolean,
        false
    )
    OR clinic_id = NULLIF(
        current_setting('app.current_clinic_id', true),
        ''
    )::uuid
)
WITH CHECK (
    COALESCE(
        NULLIF(
            current_setting('app.is_admin', true),
            ''
        )::boolean,
        false
    )
    OR clinic_id = NULLIF(
        current_setting('app.current_clinic_id', true),
        ''
    )::uuid
);

ALTER TABLE public.sessions ADD COLUMN stimulus_set_id uuid
REFERENCES public.clinic_stimulus_sets(stimulus_set_id) ON DELETE RESTRICT;

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
    v_claimed_at timestamptz;
BEGIN
    IF p_clinic_id IS NULL THEN
        RAISE EXCEPTION 'Clinic ID is required'
            USING ERRCODE = 'P2004';
    END IF;

    /*
     * Find the clinic's active stimulus set.
     *
     * The partial unique index guarantees that there can be
     * at most one active stimulus set per clinic.
     */
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

    /*
     * Defensive validation before assigning the set.
     */
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

    /*
     * Claim the session and permanently pin it to the currently
     * active stimulus-set version.
     */
    UPDATE public.sessions
    SET
        client_id = p_client_id,
        conducted_by = p_conducted_by,
        clinic_id = p_clinic_id,
        stimulus_set_id = v_stimulus_set_id,
        sync_status = 'claimed',
        paired_at = v_claimed_at

    WHERE pairing_code = UPPER(TRIM(p_pairing_code))
      AND sync_status = 'unclaimed'
      AND clinic_id IS NULL

    RETURNING jsonb_build_object(
        'session_id', session_id,
        'client_id', client_id,
        'clinic_id', clinic_id,
        'stimulus_set_id', stimulus_set_id,
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

-- 15/07/2026 For creating stimulus sets with existing images and assigning them to existing clinics
BEGIN;

-- Needed when FORCE ROW LEVEL SECURITY is enabled and the policies
-- allow administrative access through app.is_admin.
SELECT set_config('app.is_admin', 'true', true);

-- Prevent another process from activating or creating stimulus sets
-- while this seed migration is running.
LOCK TABLE public.clinic_stimulus_sets
IN SHARE ROW EXCLUSIVE MODE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Freeze the same 24 test images for use across every clinic.
-- This assumes the previous 24 images have NULL valence/arousal means.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE seed_stimulus_images
ON COMMIT DROP
AS
SELECT
    selected.image_id,
    ROW_NUMBER() OVER (
        ORDER BY
            selected.created_at ASC NULLS FIRST,
            selected.display_order ASC,
            selected.image_id ASC
    )::smallint AS sequence_no
FROM (
    SELECT
        i.image_id,
        i.created_at,
        i.display_order
    FROM public.images i
    WHERE i.valence_mean IS NULL
      AND i.arousal_mean IS NULL
    ORDER BY
        i.created_at ASC NULLS FIRST,
        i.display_order ASC,
        i.image_id ASC
    LIMIT 24
) AS selected;


DO $seed$
DECLARE
    v_clinic record;
    v_stimulus_set_id uuid;
    v_next_version integer;
    v_seed_image_count integer;
    v_inserted_image_count integer;
BEGIN
    SELECT COUNT(*)::integer
    INTO v_seed_image_count
    FROM pg_temp.seed_stimulus_images;

    IF v_seed_image_count <> 24 THEN
        RAISE EXCEPTION
            'Expected 24 test images with NULL valence/arousal means, but found %',
            v_seed_image_count;
    END IF;

    /*
     * Skip clinics that already have an active stimulus set.
     * This makes the script safe to run again without replacing
     * an existing clinic configuration.
     */
    FOR v_clinic IN
        SELECT c.clinic_id
        FROM public.clinics c
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.clinic_stimulus_sets css
            WHERE css.clinic_id = c.clinic_id
              AND css.status = 'active'
        )
        ORDER BY c.clinic_id
    LOOP
        SELECT COALESCE(MAX(css.version), 0) + 1
        INTO v_next_version
        FROM public.clinic_stimulus_sets css
        WHERE css.clinic_id = v_clinic.clinic_id;

        -- Create as draft so its child images can still be inserted.
        INSERT INTO public.clinic_stimulus_sets (
            clinic_id,
            name,
            version,
            status
        )
        VALUES (
            v_clinic.clinic_id,
            'Default test image set',
            v_next_version,
            'draft'
        )
        RETURNING stimulus_set_id
        INTO v_stimulus_set_id;

        INSERT INTO public.clinic_stimulus_set_images (
            stimulus_set_id,
            clinic_id,
            image_id,
            sequence_no
        )
        SELECT
            v_stimulus_set_id,
            v_clinic.clinic_id,
            seed.image_id,
            seed.sequence_no
        FROM pg_temp.seed_stimulus_images seed
        ORDER BY seed.sequence_no;

        GET DIAGNOSTICS v_inserted_image_count = ROW_COUNT;

        IF v_inserted_image_count <> 24 THEN
            RAISE EXCEPTION
                'Expected to insert 24 images for clinic %, but inserted %',
                v_clinic.clinic_id,
                v_inserted_image_count;
        END IF;

        /*
         * Activating after inserting the images allows your activation
         * trigger to verify that the set contains exactly 24 images.
         */
        UPDATE public.clinic_stimulus_sets
        SET
            status = 'active',
            activated_at = COALESCE(
                activated_at,
                clock_timestamp()
            )
        WHERE stimulus_set_id = v_stimulus_set_id;

        RAISE NOTICE
            'Created stimulus set % version % for clinic %',
            v_stimulus_set_id,
            v_next_version,
            v_clinic.clinic_id;
    END LOOP;
END;
$seed$;

COMMIT;