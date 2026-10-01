-- O2.3: Retention timestamp for sessions that have not been paired yet.
-- Add the column without a default first so existing rows can be backfilled from
-- the best available historical timestamp before the NOT NULL constraint is set.
ALTER TABLE public.sessions
    ADD COLUMN created_at timestamptz;

-- All undated legacy rows deliberately receive the same migration timestamp,
-- giving them a full 30-day grace period before scheduled cleanup can delete
-- an unclaimed session. MIN ignores null timestamp candidates.
WITH migration_time AS MATERIALIZED (
    SELECT clock_timestamp() AS occurred_at
)
UPDATE public.sessions AS s
SET created_at = COALESCE(
    (
        SELECT MIN(candidate.occurred_at)
        FROM (
            VALUES
                (s.paired_at),
                (s.start_time),
                (s.end_time),
                (s.synced_at)
        ) AS candidate(occurred_at)
    ),
    migration_time.occurred_at
)
FROM migration_time
WHERE s.created_at IS NULL;

ALTER TABLE public.sessions
    ALTER COLUMN created_at SET DEFAULT clock_timestamp(),
    ALTER COLUMN created_at SET NOT NULL;

-- The scheduled deletion query only considers unclaimed sessions. A partial
-- index avoids scanning claimed, recording, and completed session records.
CREATE INDEX idx_sessions_unclaimed_created_at
    ON public.sessions (created_at)
    WHERE sync_status = 'unclaimed';
