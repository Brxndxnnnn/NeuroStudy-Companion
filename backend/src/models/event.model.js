import pool from '../config/db.js'
import query from '../utils/query.js'

// Client timestamps use a short, minimum-RTT calibration to this database clock.
// Keep a small acceptance window so a bad system clock cannot create implausible
// event windows, while avoiding request-arrival time for calibrated timestamps.
const MAX_CLIENT_CLOCK_SKEW_SECONDS = 5

const trustedEventTimeSql = parameter => `
    CASE
        WHEN ${parameter}::timestamptz IS NOT NULL
         AND ABS(
             EXTRACT(
                 EPOCH FROM (
                     clock_timestamp()-
                     ${parameter}::timestamptz
                 )
             )
         )<=${MAX_CLIENT_CLOCK_SKEW_SECONDS}
        THEN ${parameter}::timestamptz
        ELSE clock_timestamp()
    END
`
const create = async ({ session_id, image_id, question_id, phase = null, clinic_id, occurred_at = null }, client = pool) => {
    // Close any existing open events for the same session before creating a new one —
    // type-agnostic (image, question, or phase all close each other the same way, so a
    // countdown/baseline marker contiguously closes out the stimulus that preceded it).
    const { rows } = await query(client, `
        WITH event_time AS (
            SELECT
                ${trustedEventTimeSql('$6')} AS occurred_at
        ),
        closed_previous_event AS (
            UPDATE events AS existing
            SET hidden_at=event_time.occurred_at
            FROM event_time
            WHERE existing.session_id=$1::uuid
              AND existing.clinic_id=$5::uuid
              AND existing.hidden_at IS NULL
            RETURNING existing.event_id
        )
        INSERT INTO events(
            session_id,
            image_id,
            question_id,
            phase,
            clinic_id,
            shown_at
        )
        SELECT
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::text,
            $5::uuid,
            event_time.occurred_at
        FROM event_time
        RETURNING *
    `, [
        session_id,
        image_id,
        question_id,
        phase,
        clinic_id,
        occurred_at
    ])
    return rows[0]
}

const setHiddenAt = async (event_id, clinic_id, occurred_at, client = pool) => {
    const { rows } = await query(client, `
        WITH event_time AS (
            SELECT
                ${trustedEventTimeSql('$3')} AS occurred_at
        )
        UPDATE events AS event
        SET hidden_at=event_time.occurred_at
        FROM event_time
        WHERE event.event_id=$1::uuid
          AND event.clinic_id=$2::uuid
          AND event.hidden_at IS NULL
        RETURNING event.*
    `, [event_id, clinic_id, occurred_at])
    return rows[0]
}

const getServerTime = async (client = pool) => {
    const { rows } = await query(client, `SELECT clock_timestamp() AS server_time`)
    return rows[0].server_time
}

export default { create, setHiddenAt, getServerTime }
