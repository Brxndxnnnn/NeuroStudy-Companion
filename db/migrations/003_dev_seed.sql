-- 003_dev_seed.sql
-- Development seed data — NOT for production
-- Applies after 001_init.sql and 002_create_bridge_user.sh automatically via docker-entrypoint-initdb.d
--
-- Passwords (bcrypt, 12 rounds):
--   devpassword → $2b$12$DWn5dj2eV9UkcOu1We5/YOxx.nLG1mnreeLLWsuL2tkOxzuHmFAdi
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── Seed: Roles ──────────────────────────────────────────────────────────────
INSERT INTO roles (role_id, name, requires_clinic, description) VALUES
    ('d0000000-0000-0000-0000-000000000001', 'admin',       false, 'Full access across all clinics and users'),
    ('d0000000-0000-0000-0000-000000000002', 'technician',  true,  'Session and client access scoped to own clinic');

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

-- ─── Clinics ─────────────────────────────────────────────────────────────────
INSERT INTO clinics (clinic_id, name, address) VALUES
    ('a0000000-0000-0000-0000-000000000001', 'Sunrise Neurology Clinic', '10 Orchard Rd, Singapore'),
    ('a0000000-0000-0000-0000-000000000002', 'Brainwave Medical Centre',  '5 Novena Ave, Singapore');

-- ─── Users ───────────────────────────────────────────────────────────────────
-- Admin (no clinic — NULL is intentional, see ERD decision)
INSERT INTO users (user_id, email, password_hash, role_id, clinic_id, assigned_by, display_name) VALUES
    (
        'b0000000-0000-0000-0000-000000000001',
        'admin@neurostudy.com',
        '$2b$12$DWn5dj2eV9UkcOu1We5/YOxx.nLG1mnreeLLWsuL2tkOxzuHmFAdi',
        'd0000000-0000-0000-0000-000000000001',
        NULL,
        NULL,
        'Dev Admin'
    );

-- Technicians (scoped to a clinic)
INSERT INTO users (user_id, email, password_hash, role_id, clinic_id, assigned_by, display_name) VALUES
    (
        'b0000000-0000-0000-0000-000000000002',
        'tech1@neurostudy.com',
        '$2b$12$DWn5dj2eV9UkcOu1We5/YOxx.nLG1mnreeLLWsuL2tkOxzuHmFAdi',
        'd0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000001',
        'Tech Alice'
    ),
    (
        'b0000000-0000-0000-0000-000000000003',
        'tech2@neurostudy.com',
        '$2b$12$DWn5dj2eV9UkcOu1We5/YOxx.nLG1mnreeLLWsuL2tkOxzuHmFAdi',
        'd0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000002',
        'b0000000-0000-0000-0000-000000000001',
        'Tech Bob'
    );

-- ─── Clients ─────────────────────────────────────────────────────────────────
INSERT INTO clients (client_id, clinic_id, name, dob, gender, race, notes) VALUES
    ('c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001', 'Alice Tan', '1990-05-15', 'Female', 'Asian', 'Referred for attention deficit assessment'),
    ('c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002', 'Ben Lim', '1985-12-10', 'Male', 'Asian', 'Follow-up session, anxiety monitoring'),
    ('c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000002', 'Carol Ng', '1992-09-22', 'Female', 'Asian', 'Initial baseline session');