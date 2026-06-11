#!/bin/bash
set -e

# We use psql's -v flag to pass the env var safely as a psql variable.
# This prevents SQL injection if your password contains weird characters.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v bridge_pass="$DB_BRIDGE_PASSWORD" -v app_pass="$APP_DB_PASSWORD" <<-EOSQL
    -- Create the role using the passed variable
    CREATE ROLE bridge_writer WITH LOGIN PASSWORD :'bridge_pass';
    ALTER ROLE bridge_writer BYPASSRLS;
    
    -- Grant permissions
    GRANT USAGE ON SCHEMA public TO bridge_writer;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO bridge_writer;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bridge_writer;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO bridge_writer;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO bridge_writer;
    
    -- Optional: Print a success message to the docker logs
    SELECT 'Successfully created bridge_writer role with BYPASSRLS!' AS status;

    -- Application user for Node.js backend (subject to RLS)
    CREATE ROLE app_user WITH LOGIN PASSWORD :'app_pass';
    -- Do NOT grant SUPERUSER or BYPASSRLS

    -- Grant schema access
    GRANT USAGE ON SCHEMA public TO app_user;

    -- Grant SELECT/INSERT/UPDATE on all tables (but RLS will filter)
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

    -- Grant sequence access for UUID generation
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
EOSQL