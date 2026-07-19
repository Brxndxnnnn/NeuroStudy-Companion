-- 010: Seed the bridge's fixed placeholder rows server-side.
--
-- The bridge creates every session as 'unclaimed' against fixed placeholder
-- client/technician rows (GUIDs mirror DbUploader.cs). Historically the bridge
-- seeded these itself on every CreateSession, which required INSERT on clinics/
-- roles/clients/users — privileges the locked-down per-clinic DB users rightly
-- do NOT have. Seeding now happens here, once, server-side; the bridge still
-- attempts its own seeding for standalone-dev convenience but tolerates
-- permission-denied when running as a clinic user.
--
-- Idempotent; mirrors the exact rows CreateSession would insert.

INSERT INTO clinics (clinic_id, name)
VALUES ('33333333-3333-3333-3333-333333333333', '⟨Unclaimed⟩ — bridge placeholder clinic')
ON CONFLICT (clinic_id) DO NOTHING;

-- requires_clinic=false lets the placeholder user keep a NULL clinic_id
-- (the enforce_clinic_membership trigger only fires for clinic-requiring roles).
INSERT INTO roles (role_id, name, requires_clinic, description)
VALUES ('44444444-4444-4444-4444-444444444444', 'bridge_placeholder', false,
        'Non-login placeholder role for the bridge system user.')
ON CONFLICT (role_id) DO NOTHING;

INSERT INTO clients (client_id, clinic_id, name, notes)
VALUES ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
        '⟨Unclaimed⟩ — pending pairing',
        'Placeholder client for bridge-created sessions awaiting frontend claim.')
ON CONFLICT (client_id) DO NOTHING;

INSERT INTO users (user_id, email, password_hash, role_id, clinic_id, display_name)
VALUES ('22222222-2222-2222-2222-222222222222', 'bridge-system@neurostudy.local', '!',
        '44444444-4444-4444-4444-444444444444', NULL, 'Neuuro Bridge (system)')
ON CONFLICT (user_id) DO NOTHING;
