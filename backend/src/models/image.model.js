import pool from '../config/db.js'
import query from '../utils/query.js'

const findAll = async (client = pool) => {
    const { rows } = await query(client, 
        `SELECT image_id, display_order, filename, url, category, valence_mean, valence_sd, arousal_mean, arousal_sd from images ORDER BY display_order NULLS LAST, image_id DESC`
    )
    return rows
}

const findById = async (image_id, client = pool) => {
    const { rows } = await query(client, 
        `SELECT image_id, display_order, filename, url, category, valence_mean, valence_sd, arousal_mean, arousal_sd from images WHERE image_id = $1`, [image_id]
    )
    return rows
}

const getAll = async ({ search = null, category = null, page = 1, limit = 25}, client = pool) => {
    const offset = (page - 1) * limit
    /*
     * Keep the WHERE clause identical between the count query
     * and the data query so pagination metadata stays accurate.
     */
    const filterSql = `
        WHERE (
            $1::text IS NULL
            OR i.filename ILIKE '%' || $1::text || '%'
        )
        AND (
            $2::text IS NULL
            OR LOWER(i.category) = LOWER($2::text)
        )
    `

    const countResult = await query(
        client,
        `
        SELECT COUNT(*)::integer AS total
        FROM public.images i
        ${filterSql}
        `,
        [search, category]
    )

    const total = countResult.rows[0]?.total ?? 0

    const imagesResult = await query(
        client,
        `
        SELECT
            i.image_id,
            i.filename,
            i.category,
            i.url,
            i.valence_mean,
            i.valence_sd,
            i.arousal_mean,
            i.arousal_sd,
            i.display_order,
            i.created_at
        FROM public.images i
        ${filterSql}
        ORDER BY
            i.filename ASC,
            i.image_id ASC
        LIMIT $3::integer
        OFFSET $4::integer
        `,
        [
            search,
            category,
            limit,
            offset
        ]
    )

    return {
        images: imagesResult.rows,
        total
    }
}

export default { findAll, findById, getAll }