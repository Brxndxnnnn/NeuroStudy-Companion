CREATE TABLE clinic_database_roles(
  database_role name PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(clinic_id)
);
INSERT INTO clinic_database_roles(database_role,clinic_id)
VALUES
  ('clinic_001', 'a0000000-0000-0000-0000-000000000001'),
  ('clinic_002', 'a0000000-0000-0000-0000-000000000002');

-- 19/07/2026: Added function to create a session for a clinic user. 
-- The function will check if the database role is mapped to a clinic and insert the session with the corresponding clinic_id. 
-- If the database role is not mapped to a clinic, an exception will be raised.
CREATE OR REPLACE FUNCTION create_clinic_session(
  p_session_id uuid,
  p_client_id uuid,
  p_conducted_by uuid,
  p_device_id text,
  p_pairing_code text,
  p_sample_rate integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_clinic_id uuid;
  v_row_count integer;
BEGIN
  SELECT clinic_id
  INTO v_clinic_id
  FROM clinic_database_roles
  WHERE database_role=session_user;

  IF v_clinic_id IS NULL THEN
    RAISE EXCEPTION
      'No clinic mapped to database role %',
      session_user;
  END IF;

  INSERT INTO sessions(
    session_id,
    clinic_id,
    client_id,
    conducted_by,
    device_id,
    pairing_code,
    sample_rate,
    sync_status
  )
  VALUES(
    p_session_id,
    v_clinic_id,
    p_client_id,
    p_conducted_by,
    p_device_id,
    p_pairing_code,
    p_sample_rate,
    'unclaimed'
  )
  ON CONFLICT(session_id) DO NOTHING;

  GET DIAGNOSTICS v_row_count=ROW_COUNT;

  RETURN v_row_count=1;
END;
$$;


CREATE TABLE clinic_activation_codes(
  activation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_code_hash text NOT NULL UNIQUE,
  clinic_id uuid NOT NULL REFERENCES clinics(clinic_id),
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1,
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

ALTER TABLE public.clinic_activation_codes
ADD COLUMN database_role name NOT NULL
REFERENCES public.clinic_database_roles(database_role);

CREATE SCHEMA IF NOT EXISTS security_admin;

REVOKE ALL ON SCHEMA security_admin FROM PUBLIC;

CREATE ROLE clinic_provisioner
NOLOGIN
CREATEROLE
NOSUPERUSER
NOCREATEDB
NOREPLICATION
NOBYPASSRLS;

GRANT bridge_writer TO clinic_provisioner WITH ADMIN OPTION;

-- 19/07/2026: Added function to create a clinic database role and activation code.
CREATE OR REPLACE FUNCTION security_admin.create_clinic_database_access(
  p_clinic_id uuid,
  p_database_role name,
  p_activation_code_hash text,
  p_expires_at timestamptz
)
RETURNS TABLE(
  activation_id uuid,
  clinic_id uuid,
  database_role name,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,security_admin,pg_temp
AS $$
DECLARE
  v_activation_id uuid;
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM public.clinics c
    WHERE c.clinic_id=p_clinic_id
  ) THEN
    RAISE EXCEPTION 'Clinic not found';
  END IF;

  IF p_database_role::text !~ '^[a-z][a-z0-9_]{2,62}$' THEN
    RAISE EXCEPTION 'Invalid database role name';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname=p_database_role
  ) THEN
    RAISE EXCEPTION 'Database role already exists';
  END IF;

  EXECUTE format(
    'CREATE ROLE %I
       NOLOGIN
       NOSUPERUSER
       NOCREATEDB
       NOCREATEROLE
       NOREPLICATION
       NOBYPASSRLS
       INHERIT
       CONNECTION LIMIT 5',
    p_database_role
  );

  EXECUTE format(
    'GRANT bridge_writer TO %I',
    p_database_role
  );

  INSERT INTO public.clinic_database_roles(
    database_role,
    clinic_id
  )
  VALUES(
    p_database_role,
    p_clinic_id
  );

  INSERT INTO public.clinic_activation_codes(
    activation_code_hash,
    clinic_id,
    database_role,
    expires_at,
    max_uses
  )
  VALUES(
    p_activation_code_hash,
    p_clinic_id,
    p_database_role,
    p_expires_at,
    1
  )
  RETURNING clinic_activation_codes.activation_id
  INTO v_activation_id;

  RETURN QUERY
  SELECT
    v_activation_id,
    p_clinic_id,
    p_database_role,
    p_expires_at;
END;
$$;

-- 19/07/2026: Added function to redeem a clinic activation code.
CREATE OR REPLACE FUNCTION security_admin.redeem_clinic_activation(
  p_activation_code_hash text,
  p_database_password text
)
RETURNS TABLE(
  activation_id uuid,
  clinic_id uuid,
  clinic_name text,
  database_role name
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,security_admin,pg_temp
AS $$
DECLARE
  v_activation public.clinic_activation_codes%ROWTYPE;
  v_clinic_name text;
BEGIN
  SELECT cac.*
  INTO v_activation
  FROM public.clinic_activation_codes cac
  WHERE cac.activation_code_hash=p_activation_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='ZA001',
      MESSAGE='Unknown activation code';
  END IF;

  IF v_activation.use_count>=v_activation.max_uses THEN
    RAISE EXCEPTION USING
      ERRCODE='ZA002',
      MESSAGE='Activation code has already been used';
  END IF;

  IF v_activation.expires_at<=now() THEN
    RAISE EXCEPTION USING
      ERRCODE='ZA003',
      MESSAGE='Activation code has expired';
  END IF;

  IF v_activation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='ZA004',
      MESSAGE='Activation code has been revoked';
  END IF;

  SELECT c.name
  INTO v_clinic_name
  FROM public.clinics c
  WHERE c.clinic_id=v_activation.clinic_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE='ZA005',
      MESSAGE='Clinic associated with activation code was not found';
  END IF;

  EXECUTE format(
    'ALTER ROLE %I
       LOGIN
       PASSWORD %L
       CONNECTION LIMIT 5',
    v_activation.database_role,
    p_database_password
  );

  UPDATE public.clinic_activation_codes
  SET
    use_count=use_count+1,
    last_used_at=now()
  WHERE clinic_activation_codes.activation_id=v_activation.activation_id;

  RETURN QUERY
  SELECT
    v_activation.activation_id,
    v_activation.clinic_id,
    v_clinic_name,
    v_activation.database_role;
END;
$$;

-- 19/07/2026: Grant the clinic_provisioner role ownership of the functions.
ALTER FUNCTION security_admin.create_clinic_database_access(
  uuid,
  name,
  text,
  timestamptz
) OWNER TO clinic_provisioner;

ALTER FUNCTION security_admin.redeem_clinic_activation(
  text,
  text
) OWNER TO clinic_provisioner;

REVOKE ALL
ON FUNCTION security_admin.create_clinic_database_access(
  uuid,
  name,
  text,
  timestamptz
)
FROM PUBLIC;

REVOKE ALL
ON FUNCTION security_admin.redeem_clinic_activation(
  text,
  text
)
FROM PUBLIC;

-- 19/07/2026: Grant the app_user role permission to execute the functions.
GRANT USAGE ON SCHEMA security_admin TO app_user;

GRANT EXECUTE
ON FUNCTION security_admin.create_clinic_database_access(
  uuid,
  name,
  text,
  timestamptz
)
TO app_user;

GRANT EXECUTE
ON FUNCTION security_admin.redeem_clinic_activation(
  text,
  text
)
TO app_user;

-- Actually grant the bridge_writer role to the clinic roles. 
-- The bridge_writer role is a restricted role that can only insert into certain tables and update certain columns. 
-- The clinic roles can only connect to the database and create sessions using the create_clinic_session function. 
-- They cannot read or write any other data in the database.
BEGIN;
-- ============================================================
-- 1. Harden bridge_writer itself
-- ============================================================
ALTER ROLE bridge_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS INHERIT;
-- Important: bridge_writer must not own protected tables.
-- Table owners normally bypass RLS unless FORCE ROW LEVEL SECURITY is used.
-- Check ownership separately after this script.
-- ============================================================
-- 2. Remove its current broad permissions
-- ============================================================
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
FROM bridge_writer;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
FROM bridge_writer;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public
FROM bridge_writer;
-- Allow the role to resolve objects in the public schema.
GRANT USAGE ON SCHEMA public TO bridge_writer;
-- ============================================================
-- 3. Streaming tables
-- COPY FROM STDIN uses INSERT privileges.
-- These grants permit inserting into every column of each table.
-- ============================================================
GRANT INSERT ON TABLE
  public.eeg_raw_samples,
  public.eeg_filtered_samples,
  public.eeg_readings,
  public.band_powers
TO bridge_writer;
-- ============================================================
-- 4. Sessions
-- Full-row INSERT, full-row SELECT, but UPDATE only two columns.
-- ============================================================
GRANT INSERT,SELECT
ON TABLE public.sessions
TO bridge_writer;
GRANT UPDATE(
  bridge_recording_at,
  sync_status
)
ON TABLE public.sessions
TO bridge_writer;
-- ============================================================
-- 5. Read-only progress tables
-- ============================================================
GRANT SELECT ON TABLE
  public.events,
  public.session_questionnaire_responses
TO bridge_writer;
-- ============================================================
-- 6. Create clinic login roles
-- Replace the passwords before running.
-- ============================================================
CREATE ROLE clinic_001 LOGIN PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD_1' NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 5;
CREATE ROLE clinic_002 LOGIN PASSWORD 'REPLACE_WITH_LONG_RANDOM_PASSWORD_2' NOSUPERUSER NOCREATEDB NOCREATEROLE
NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 5;
GRANT bridge_writer TO clinic_001;
GRANT bridge_writer TO clinic_002;
COMMIT;

GRANT USAGE ON SCHEMA public TO clinic_provisioner;

GRANT SELECT ON TABLE public.clinics
TO clinic_provisioner;

GRANT INSERT ON TABLE public.clinic_database_roles
TO clinic_provisioner;

GRANT SELECT,INSERT,UPDATE ON TABLE public.clinic_activation_codes
TO clinic_provisioner;