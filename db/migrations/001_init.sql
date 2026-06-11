-- 001_init.sql
-- RBAC Tables: roles, permissions, role_permissions, clinics, users, revoked_tokens

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Clinics ──────────────────────────────────────────────────────────────────
CREATE TABLE clinics (
    clinic_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    address    text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Roles ────────────────────────────────────────────────────────────────────
CREATE TABLE roles (
    role_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text        NOT NULL UNIQUE,
    requires_clinic boolean     NOT NULL DEFAULT true,
    description     text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ─── Permissions ──────────────────────────────────────────────────────────────
CREATE TABLE permissions (
    permission_id uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name          text        NOT NULL UNIQUE,  -- format: resource:action:scope
    description   text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── Role Permissions (junction) ──────────────────────────────────────────────
CREATE TABLE role_permissions (
    role_id       uuid        NOT NULL REFERENCES roles(role_id)       ON DELETE CASCADE,
    permission_id uuid        NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (role_id, permission_id)
);

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
    user_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    role_id       uuid        NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
    clinic_id     uuid        REFERENCES clinics(clinic_id)   ON DELETE RESTRICT,
    display_name  text,
    assigned_by   uuid        REFERENCES users(user_id)       ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Trigger to ensure that non-admin users must belong to a clinic
CREATE OR REPLACE FUNCTION enforce_clinic_membership()
RETURNS TRIGGER AS $$
DECLARE
    v_requires_clinic boolean;
BEGIN
    SELECT requires_clinic INTO v_requires_clinic FROM roles WHERE role_id = NEW.role_id;
    IF v_requires_clinic AND NEW.clinic_id IS NULL THEN
        RAISE EXCEPTION 'Users with this role must belong to a clinic';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_clinic_membership
BEFORE INSERT OR UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION enforce_clinic_membership();


-- ─── Active Sessions ──────────────────────────────────────────────────────────
-- This table now tracks the long-lived Refresh Token lifecycle.
-- We do NOT store Access Tokens here.
CREATE TABLE active_sessions (
    session_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid        UNIQUE NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    
    -- The actual refresh token (hashed) or its unique JTI
    refresh_token_hash  text        NOT NULL, 
    
    -- Metadata for security auditing
    ip_address          inet,
    user_agent          text,
    device_type         text,       -- e.g., 'web_browser', 'csharp_bridge'
    
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL, -- When the refresh token dies (e.g., +7 days)
    last_used_at        timestamptz NOT NULL DEFAULT now()
);

-- Index for fast lookup when the frontend sends the refresh token
CREATE INDEX idx_active_sessions_refresh_hash ON active_sessions (refresh_token_hash);
CREATE INDEX idx_active_sessions_user_id ON active_sessions (user_id);

-- ─── Revoked Tokens ───────────────────────────────────────────────────────────
CREATE TABLE revoked_tokens (
    jti        uuid        PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users(user_id)          ON DELETE CASCADE,
    revoked_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION notify_token_revoked()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('token_revocations', NEW.jti::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_token_revoked
AFTER INSERT ON revoked_tokens
FOR EACH ROW
EXECUTE FUNCTION notify_token_revoked();

-- Index for cleanup job: DELETE FROM revoked_tokens WHERE expires_at < now()
CREATE INDEX idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);

-- ─── Clients ──────────────────────────────────────────────────────────────────
CREATE TABLE clients (
    client_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id  uuid        NOT NULL REFERENCES clinics(clinic_id)   ON DELETE RESTRICT,
    name       text        NOT NULL,
    dob        date,
    gender     text,
    race       text,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_clients_clinic_id ON clients(clinic_id);

-- ─── Images ───────────────────────────────────────────────────────────────────
CREATE TABLE images (
    image_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filename      text NOT NULL,
    category      text,
    valence_score real,
    arousal_score real
);


-- ─── Sessions ─────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
    session_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id    uuid        REFERENCES clients(client_id)    ON DELETE RESTRICT,
    clinic_id    uuid        REFERENCES clinics(clinic_id)    ON DELETE SET NULL,
    conducted_by uuid        REFERENCES users(user_id)        ON DELETE RESTRICT,
    device_id    text,
    pairing_code text,
    paired_at    timestamptz,
    start_time   timestamptz,
    end_time     timestamptz,
    synced_at    timestamptz,
    notes        text,
    sync_status  text,
    sample_rate  int         NOT NULL DEFAULT 250
                             CONSTRAINT chk_sample_rate CHECK (sample_rate IN (125, 250))
);
CREATE INDEX idx_sessions_pairing_code ON sessions(pairing_code);
CREATE INDEX idx_sessions_clinic_id ON sessions(clinic_id);

-- ─── Events ───────────────────────────────────────────────────────────────────
CREATE TABLE events (
    event_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid        NOT NULL REFERENCES sessions(session_id)   ON DELETE CASCADE,
    image_id   uuid        NOT NULL REFERENCES images(image_id)       ON DELETE RESTRICT,
    shown_at   timestamptz NOT NULL,
    clinic_id  uuid        REFERENCES clinics(clinic_id)    ON DELETE SET NULL,
    hidden_at  timestamptz
);
CREATE INDEX idx_events_session_time ON events (session_id, shown_at);
CREATE INDEX idx_events_clinic_id ON events(clinic_id);

-- ─── EEG Readings (hypertable) ────────────────────────────────────────────────
CREATE TABLE eeg_readings (
    session_id        uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time              timestamptz NOT NULL,
    current_image_id  uuid        REFERENCES images(image_id)              ON DELETE SET NULL,
    -- Raw last-sample values per electrode
    fp1_raw_last      real,
    fp2_raw_last      real,
    t3_raw_last       real,
    t4_raw_last       real,
    -- Raw peak-to-peak values per electrode
    fp1_raw_pkpk      real,
    fp2_raw_pkpk      real,
    t3_raw_pkpk       real,
    t4_raw_pkpk       real,
    -- Filtered last-sample values per electrode
    fp1_filt_last     real,
    fp2_filt_last     real,
    t4_filt_last      real,
    t3_filt_last      real,
    -- Filtered peak-to-peak values per electrode
    fp1_filt_pkpk     real,
    fp2_filt_pkpk     real,
    t4_filt_pkpk      real,
    t3_filt_pkpk      real,
    PRIMARY KEY (session_id, time)
);

SELECT create_hypertable('eeg_readings', by_range('time'));
SELECT set_chunk_time_interval('eeg_readings', INTERVAL '1 day');


-- ─── Band Powers (hypertable) ─────────────────────────────────────────────────
CREATE TABLE band_powers (
    session_id       uuid        NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    time             timestamptz NOT NULL,
    current_image_id uuid        REFERENCES images(image_id)              ON DELETE SET NULL,
    -- Computed indicators
    attention        real,
    relaxation       real,
    mental_workload  real,
    signal_quality   integer,
    -- FP1 bands
    fp1_alpha        real,
    fp1_beta         real,
    fp1_delta        real,
    fp1_theta        real,
    fp1_gamma        real,
    -- FP2 bands
    fp2_alpha        real,
    fp2_beta         real,
    fp2_delta        real,
    fp2_theta        real,
    fp2_gamma        real,
    -- T4 bands
    t4_alpha         real,
    t4_beta          real,
    t4_delta         real,
    t4_theta         real,
    t4_gamma         real,
    -- T3 bands
    t3_alpha         real,
    t3_beta          real,
    t3_delta         real,
    t3_theta         real,
    t3_gamma         real,
    PRIMARY KEY (session_id, time)
);

SELECT create_hypertable('band_powers', by_range('time'));
SELECT set_chunk_time_interval('band_powers', INTERVAL '1 day');


-- ─── ML Insights ──────────────────────────────────────────────────────────────
CREATE TABLE ml_insights (
    insight_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     uuid        NOT NULL REFERENCES clients(client_id)   ON DELETE CASCADE,
    session_id    uuid        REFERENCES sessions(session_id)          ON DELETE SET NULL,  -- nullable: client-level insights
    clinic_id     uuid        REFERENCES clinics(clinic_id)            ON DELETE SET NULL,
    generated_at  timestamptz NOT NULL DEFAULT now(),
    insight_type  text        NOT NULL,
    payload       jsonb       NOT NULL,
    model_version text,
    trigger       text,
    status        text        NOT NULL DEFAULT 'pending'
);

-- Index for fetching insights by client, most recent first
CREATE INDEX idx_ml_insights_client_id ON ml_insights (client_id, generated_at DESC);
-- Index for fetching insights by session
CREATE INDEX idx_ml_insights_session_id ON ml_insights (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_ml_insights_clinic_id ON ml_insights(clinic_id);

-- 1. Enable RLS on the tables
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- 2. FORCE RLS for the table owner! 
-- (By default, the user who creates the table bypasses RLS. This forces the owner to obey it too).
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE ml_insights FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

-- 3. Create the Policies
-- We check two variables: 'app.is_admin' (for global superadmins) and 'app.current_clinic_id'

CREATE POLICY tenant_isolation_policy ON clients
USING (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

-- Repeat for sessions, ml_insights, and users...
-- (Note: 'USING' applies to SELECT/UPDATE/DELETE. 'WITH CHECK' applies to INSERT/UPDATE).
CREATE POLICY tenant_isolation_policy ON sessions
USING (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

CREATE POLICY tenant_isolation_policy ON ml_insights
USING (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);

CREATE POLICY tenant_isolation_policy ON users
USING (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);
CREATE POLICY tenant_isolation_policy ON events
USING (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
)
WITH CHECK (
    current_setting('app.is_admin', true)::boolean = true 
    OR clinic_id = NULLIF(current_setting('app.current_clinic_id', true), '')::uuid
);