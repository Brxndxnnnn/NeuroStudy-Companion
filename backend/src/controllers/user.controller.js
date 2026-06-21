import userModel from '../models/user.model.js'
import catchAsync from '../utils/catchAsync.js'
import authService from '../services/auth.service.js'

// ── POST /api/users ──────────────────────────────────────────────────────────
const createUser = catchAsync(async (req, res, next) => {
    const { email, password, display_name, clinic_id, role_id } = req.body

    // Some random regex check here for email and password strength
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'Valid email is required' })
    }
    if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' })
    }
    if (!role_id) {
        return res.status(400).json({ error: 'role_id is required' })
    }

    const password_hash = await authService.hashPassword(password)
    const user = await userModel.create({
        email, password_hash, display_name,
        clinic_id, role_id, assigned_by: req.user.sub
    }, req.dbClient)
        .catch(err => {
            if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' })
            if (err.code === '23503') {
                if (err.constraint === 'users_clinic_id_fkey') {
                    return res.status(400).json({ error: 'clinic_id does not exist' })
                } else if (err.constraint === 'users_role_id_fkey') {
                    return res.status(400).json({ error: 'role_id does not exist' })
                }
            }
            throw err
        })

    // Short-circuit if a response was already sent inside the .catch above
    if (res.headersSent) return

    return res.status(201).json(user)
})

// ── GET /api/users ───────────────────────────────────────────────────────────
const listUsers = catchAsync(async (req, res) => {
    const users = await userModel.findAll(req.dbClient)
    return res.json(users)
})

// ── GET /api/users/:id ───────────────────────────────────────────────────────
const getUser = catchAsync(async (req, res) => {
    const user = await userModel.findById(req.params.id, req.dbClient)
    if (!user) return res.status(404).json({ error: 'User not found' })
    return res.json(user)
})

// ── PATCH /api/users/:id ─────────────────────────────────────────────────────
const updateUser = catchAsync(async (req, res, next) => {
    const { display_name, clinic_id } = req.body

    const user = await userModel.update(req.params.id, { display_name, clinic_id }, req.dbClient)
        .catch(err => {
            if (err.code === '23503') {
                if (err.constraint === 'users_clinic_id_fkey') {
                    return res.status(400).json({ error: 'clinic_id does not exist' })
                }
            }
            throw err
        })

    if (res.headersSent) return

    if (user === null) return res.status(400).json({ error: 'Nothing to update' })
    if (!user) return res.status(404).json({ error: 'User not found' })

    return res.json(user)
})

// ── DELETE /api/users/:id ────────────────────────────────────────────────────
const deactivateUser = catchAsync(async (req, res) => {
    const { id } = req.params

    if (id === req.user.user_id) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' })
    }

    const user = await userModel.findById(id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    await userModel.removeRole(id)

    return res.json({ message: 'User deactivated', user_id: id })
})

// ── POST /api/users/:id/role ─────────────────────────────────────────────────
const assignRole = catchAsync(async (req, res) => {
    const { id } = req.params
    const { role_name } = req.body

    if (!role_name) return res.status(400).json({ error: 'role_name is required' })

    const role = await userModel.findRoleByName(role_name)
    if (!role) return res.status(404).json({ error: `Role '${role_name}' not found` })

    const user = await userModel.findById(id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const result = await userModel.updateRole(id, role.role_id, req.user.user_id, req.dbClient)

    return res.json({ message: 'Role assigned', ...result, role_name })
})

export default { createUser, listUsers, getUser, updateUser, deactivateUser, assignRole }