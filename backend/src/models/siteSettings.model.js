import pool from '../config/db.js'
import query from '../utils/query.js'

const getImageDisplayInterval = async (client = pool) => {
    const { rows } = await query(client, `
        SELECT image_display_interval_seconds, updated_at, updated_by
        FROM public.site_settings
        WHERE setting_key = 'global'
    `)
    return rows[0] ?? null
}

const updateImageDisplayInterval = async (image_display_interval_seconds, updated_by, client = pool) => {
    const { rows } = await query(client, `
        UPDATE public.site_settings
        SET image_display_interval_seconds = $1,
            updated_at = clock_timestamp(),
            updated_by = $2::uuid
        WHERE setting_key = 'global'
        RETURNING image_display_interval_seconds, updated_at, updated_by
    `, [image_display_interval_seconds, updated_by])
    return rows[0] ?? null
}

export default { getImageDisplayInterval, updateImageDisplayInterval }
