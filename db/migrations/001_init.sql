-- 001_init.sql
-- RBAC Tables: roles, permissions, role_permissions, clinics, users, user_roles, revoked_tokens

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Roles ────────────────────────────────────────────────────────────────────
CREATE TABLE roles (
    role_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL UNIQUE,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
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

-- ─── Clinics ──────────────────────────────────────────────────────────────────
CREATE TABLE clinics (
    clinic_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    address    text,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
    user_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    clinic_id     uuid        NOT NULL REFERENCES clinics(clinic_id)   ON DELETE RESTRICT,
    display_name  text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── User Roles (junction) ────────────────────────────────────────────────────
-- user_id is sole PK — enforces one role per user at DB level.
-- When many-to-many becomes necessary, promote to PRIMARY KEY (user_id, role_id).
CREATE TABLE user_roles (
    user_id     uuid        PRIMARY KEY REFERENCES users(user_id)      ON DELETE CASCADE,
    role_id     uuid        NOT NULL    REFERENCES roles(role_id)      ON DELETE RESTRICT,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    assigned_by uuid        REFERENCES users(user_id)                  ON DELETE SET NULL
);

-- ─── Revoked Tokens ───────────────────────────────────────────────────────────
CREATE TABLE revoked_tokens (
    jti        uuid        PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users(user_id)          ON DELETE CASCADE,
    revoked_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

-- Index for cleanup job: DELETE FROM revoked_tokens WHERE expires_at < now()
CREATE INDEX idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);

-- ─── Seed: Roles ──────────────────────────────────────────────────────────────
INSERT INTO roles (name, description) VALUES
    ('admin',       'Full access across all clinics and users'),
    ('technician',  'Session and client access scoped to own clinic');

-- ─── Seed: Permissions ────────────────────────────────────────────────────────
INSERT INTO permissions (name, description) VALUES
    -- Sessions
    ('sessions:read:own_clinic',    'Read sessions within own clinic'),
    ('sessions:read:all',           'Read sessions across all clinics'),
    ('sessions:write:own_clinic',   'Create and end sessions within own clinic'),
    ('sessions:write:all',          'Create and end sessions across all clinics'),

    -- Clients
    ('clients:read:own_clinic',     'Read clients within own clinic'),
    ('clients:read:all',            'Read all clients'),
    ('clients:write:own_clinic',    'Create and update clients within own clinic'),
    ('clients:write:all',           'Create and update any client'),

    -- Users
    ('users:read:all',              'Read all user accounts'),
    ('users:write:all',             'Create, update and delete user accounts'),

    -- Insights
    ('insights:read:own_clinic',    'Read insights for own clinic sessions'),
    ('insights:read:all',           'Read all insights'),

    -- Clinics
    ('clinics:read:own',            'Read own clinic record'),
    ('clinics:read:all',            'Read all clinic records'),
    ('clinics:write:all',           'Create and update clinic records');

-- ─── Seed: Role → Permission assignments ──────────────────────────────────────
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.name = 'admin'
  AND p.name IN (
    'sessions:read:all',
    'sessions:write:all',
    'clients:read:all',
    'clients:write:all',
    'users:read:all',
    'users:write:all',
    'insights:read:all',
    'clinics:read:all',
    'clinics:write:all'
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r, permissions p
WHERE r.name = 'technician'
  AND p.name IN (
    'sessions:read:own_clinic',
    'sessions:write:own_clinic',
    'clients:read:own_clinic',
    'clients:write:own_clinic',
    'insights:read:own_clinic',
    'clinics:read:own'
);


-- ─── Clients ──────────────────────────────────────────────────────────────────
CREATE TABLE clients (
    client_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text        NOT NULL,
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now()
);


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
    client_id    uuid        NOT NULL REFERENCES clients(client_id)    ON DELETE RESTRICT,
    conducted_by uuid        NOT NULL REFERENCES users(user_id)        ON DELETE RESTRICT,
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


-- ─── Events ───────────────────────────────────────────────────────────────────
CREATE TABLE events (
    event_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid        NOT NULL REFERENCES sessions(session_id)   ON DELETE CASCADE,
    image_id   uuid        NOT NULL REFERENCES images(image_id)       ON DELETE RESTRICT,
    shown_at   timestamptz NOT NULL,
    hidden_at  timestamptz
);


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