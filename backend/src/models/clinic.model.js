import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client,
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         ORDER BY created_at DESC`
    )
    return rows
}

const findById = async (clinic_id, client = pool) => {
    const { rows } = await query(client,
        `SELECT clinic_id, name, address, created_at
         FROM clinics
         WHERE clinic_id = $1`,
        [clinic_id]
    )
    return rows[0] ?? null
}

const create = async ({ name, address = null }, client = pool) => {
    const { rows } = await query(client,
        `INSERT INTO clinics (name, address)
         VALUES ($1, $2)
         RETURNING clinic_id, name, address, created_at`,
        [name, address]
    )
    return rows[0]
}

const update = async (clinic_id, fields, client = pool) => {
    const cols = []
    const vals = []
    let idx = 1

    if (fields.name !== undefined) { cols.push(`name    = $${idx++}`); vals.push(fields.name) }
    if (fields.address !== undefined) { cols.push(`address = $${idx++}`); vals.push(fields.address) }

    if (!cols.length) return null  // nothing to update

    vals.push(clinic_id)
    const { rows } = await query(client,
        `UPDATE clinics
         SET ${cols.join(', ')}
         WHERE clinic_id = $${idx}
         RETURNING clinic_id, name, address, created_at`,
        vals
    )
    return rows[0] ?? undefined  // undefined = not found, null = nothing to update
}

const getClinicStimulusSets = async ({ isAdmin = false, clinicId = null } = {}, client = pool) => {
    const params = isAdmin ? [clinicId] : []
    const where = isAdmin ? 'WHERE css.clinic_id = $1::uuid' : ''

    const { rows } = await query(client, `
        SELECT
            css.stimulus_set_id,
            css.clinic_id,
            css.name,
            css.version,
            css.status,
            css.created_by,
            css.created_at,
            css.activated_at,
            COUNT(cssi.image_id)::integer AS image_count
        FROM public.clinic_stimulus_sets css
        LEFT JOIN public.clinic_stimulus_set_images cssi
            ON cssi.stimulus_set_id = css.stimulus_set_id
        ${where}
        GROUP BY
            css.stimulus_set_id,
            css.clinic_id,
            css.name,
            css.version,
            css.status,
            css.created_by,
            css.created_at,
            css.activated_at
        ORDER BY
            (css.status = 'active') DESC,
            css.version DESC,
            css.created_at DESC
    `, params)

    return rows
}

const getClinicStimulusSetById = async (stimulusSetId, { isAdmin = false, clinicId = null } = {}, client = pool) => {
    const params = [stimulusSetId]
    let clinicFilter = ''

    if (isAdmin) {
        params.push(clinicId)
        clinicFilter = 'AND css.clinic_id = $2::uuid'
    }

    const { rows } = await query(client, `
        SELECT
            css.stimulus_set_id,
            css.clinic_id,
            css.name,
            css.version,
            css.status,
            css.created_by,
            css.created_at,
            css.activated_at,
            COUNT(cssi.image_id)::integer AS image_count,
            COALESCE(
                jsonb_agg(
                    jsonb_build_object(
                        'image_id', i.image_id,
                        'sequence_no', cssi.sequence_no,
                        'filename', i.filename,
                        'category', i.category,
                        'url', i.url,
                        'valence_mean', i.valence_mean,
                        'valence_sd', i.valence_sd,
                        'arousal_mean', i.arousal_mean,
                        'arousal_sd', i.arousal_sd
                    )
                    ORDER BY cssi.sequence_no
                ) FILTER (WHERE cssi.image_id IS NOT NULL),
                '[]'::jsonb
            ) AS images
        FROM public.clinic_stimulus_sets css
        LEFT JOIN public.clinic_stimulus_set_images cssi
            ON cssi.stimulus_set_id = css.stimulus_set_id
        LEFT JOIN public.images i
            ON i.image_id = cssi.image_id
        WHERE css.stimulus_set_id = $1::uuid
          ${clinicFilter}
        GROUP BY
            css.stimulus_set_id,
            css.clinic_id,
            css.name,
            css.version,
            css.status,
            css.created_by,
            css.created_at,
            css.activated_at
    `, params)

    return rows[0] ?? null
}

const updateClinicStimulusSet = async (
    stimulusSetId,
    { name = null, status = 'draft', imageIds },
    { isAdmin = false, clinicId = null, userId = null } = {},
    client = pool
) => {
    await query(client, 'BEGIN')

    try {
        const params = [stimulusSetId]
        let clinicFilter = ''

        if (isAdmin) {
            params.push(clinicId)
            clinicFilter = 'AND css.clinic_id = $2::uuid'
        }

        let sourceResult = await query(client, `
            SELECT
                css.stimulus_set_id,
                css.clinic_id,
                css.name,
                css.version,
                css.status
            FROM public.clinic_stimulus_sets css
            WHERE css.stimulus_set_id = $1::uuid
              ${clinicFilter}
        `, params)

        if (!sourceResult.rows[0]) {
            await query(client, 'ROLLBACK')
            return null
        }

        let source = sourceResult.rows[0]

        /*
         * Serialise stimulus-set edits for the same clinic so two
         * requests cannot generate the same version number.
         */
        await query(client, `
            SELECT clinic_id
            FROM public.clinics
            WHERE clinic_id = $1::uuid
            FOR UPDATE
        `, [source.clinic_id])

        /*
         * Re-read and lock after obtaining the clinic-level lock.
         */
        sourceResult = await query(client, `
            SELECT
                css.stimulus_set_id,
                css.clinic_id,
                css.name,
                css.version,
                css.status
            FROM public.clinic_stimulus_sets css
            WHERE css.stimulus_set_id = $1::uuid
              ${clinicFilter}
            FOR UPDATE
        `, params)

        if (!sourceResult.rows[0]) {
            await query(client, 'ROLLBACK')
            return null
        }

        source = sourceResult.rows[0]

        const finalName = name?.trim() || source.name
        let targetStimulusSetId = source.stimulus_set_id
        let createdNewVersion = false

        /*
         * Active and archived sets remain immutable because historical
         * sessions may already reference them.
         */
        if (source.status !== 'draft') {
            const versionResult = await query(client, `
                SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                FROM public.clinic_stimulus_sets
                WHERE clinic_id = $1::uuid
            `, [source.clinic_id])

            const nextVersion = versionResult.rows[0].next_version

            const createdResult = await query(client, `
                INSERT INTO public.clinic_stimulus_sets(
                    clinic_id,
                    name,
                    version,
                    status,
                    created_by
                )
                VALUES($1::uuid, $2::text, $3::integer, 'draft', $4::uuid)
                RETURNING stimulus_set_id
            `, [source.clinic_id, finalName, nextVersion, userId])

            targetStimulusSetId = createdResult.rows[0].stimulus_set_id
            createdNewVersion = true
        } else {
            await query(client, `
                UPDATE public.clinic_stimulus_sets
                SET name = $2::text
                WHERE stimulus_set_id = $1::uuid
            `, [targetStimulusSetId, finalName])
        }

        await query(client, `
            DELETE FROM public.clinic_stimulus_set_images
            WHERE stimulus_set_id = $1::uuid
        `, [targetStimulusSetId])

        await query(client, `
            INSERT INTO public.clinic_stimulus_set_images(
                stimulus_set_id,
                clinic_id,
                image_id,
                sequence_no
            )
            SELECT
                $1::uuid,
                $2::uuid,
                selected.image_id,
                selected.sequence_no::smallint
            FROM unnest($3::uuid[]) WITH ORDINALITY
                AS selected(image_id, sequence_no)
        `, [targetStimulusSetId, source.clinic_id, imageIds])

        if (status === 'active') {
            /*
             * Archive first so the partial unique index never sees two
             * active sets for the clinic.
             */
            await query(client, `
                UPDATE public.clinic_stimulus_sets
                SET status = 'archived'
                WHERE clinic_id = $1::uuid
                  AND status = 'active'
                  AND stimulus_set_id <> $2::uuid
            `, [source.clinic_id, targetStimulusSetId])

            /*
             * Your activation trigger can validate the 24 inserted rows
             * and set activated_at.
             */
            await query(client, `
                UPDATE public.clinic_stimulus_sets
                SET name = $2::text,
                    status = 'active'
                WHERE stimulus_set_id = $1::uuid
            `, [targetStimulusSetId, finalName])
        } else {
            await query(client, `
                UPDATE public.clinic_stimulus_sets
                SET name = $2::text,
                    status = 'draft',
                    activated_at = NULL
                WHERE stimulus_set_id = $1::uuid
            `, [targetStimulusSetId, finalName])
        }

        const updated = await getClinicStimulusSetById(
            targetStimulusSetId,
            { isAdmin, clinicId: source.clinic_id },
            client
        )

        await query(client, 'COMMIT')

        return {
            stimulusSet: updated,
            createdNewVersion,
            sourceStimulusSetId: stimulusSetId
        }
    } catch (err) {
        await query(client, 'ROLLBACK')
        throw err
    }
}

const createDatabaseAccess = async ({ clinicId, databaseRole, activationCodeHash, expiresAt }, client = pool) => {
    const { rows } = await query(client, `
        SELECT
            activation_id,
            clinic_id,
            database_role,
            expires_at
        FROM security_admin.create_clinic_database_access(
            $1::uuid,
            $2::name,
            $3::text,
            $4::timestamptz
        )
    `, [
        clinicId,
        databaseRole,
        activationCodeHash,
        expiresAt
    ])

    return rows[0] ?? null
}

const redeemDatabaseAccess = async ({ activationCodeHash, databasePassword }, client = pool) => {
    const { rows } = await query(client, `
        SELECT
            activation_id,
            clinic_id,
            clinic_name,
            database_role
        FROM security_admin.redeem_clinic_activation(
            $1::text,
            $2::text
        )
    `, [
        activationCodeHash,
        databasePassword
    ])

    return rows[0] ?? null
}

export default { findAll, findById, create, update, getClinicStimulusSets, getClinicStimulusSetById, updateClinicStimulusSet, createDatabaseAccess, redeemDatabaseAccess }