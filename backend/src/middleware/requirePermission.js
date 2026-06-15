import pool from '../config/db.js'

const requirePermission = (permissionName) => async (req, res, next) => {
    if (!req.user)
        return res.status(401).json({ error: 'Not authenticated.' })

    if (req.user.role === 'admin' || req.user.role === 'superadmin')
        return next()  // Admins bypass permission checks. TEMP FIX FOR NOW. Will implement more granular admin permissions later.

    const { rows } = await pool.query(
        `SELECT 1 FROM role_permissions rp
         JOIN permissions p ON rp.permission_id = p.permission_id
         WHERE rp.role_id = $1 AND p.name = $2`,
        [req.user.role_id, permissionName]
    )

    if (rows.length === 0)
        return res.status(403).json({ error: 'Insufficient permissions.' })

    next()
}

export default requirePermission