import userModel from '../models/user.model.js'
import catchAsync from '../utils/catchAsync.js'
import authService from '../services/auth.service.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── POST /api/users ──────────────────────────────────────────────────────────
const createUser = catchAsync(async (req, res, next) => {
    const { email, password, display_name, clinic_id, role_id } = req.body

    // Some random regex check here for email and password strength
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        throw new BadRequestError('Valid email is required')
    }
    if (!password || password.length < 8) {
        throw new BadRequestError('Password must be at least 8 characters long')
    }
    if (!role_id)
        throw new BadRequestError('role_id is required')

    const password_hash = await authService.hashPassword(password)
    const user = await userModel.create({
        email, password_hash, display_name,
        clinic_id, role_id, assigned_by: req.user.sub
    }, req.dbClient)

    return res.status(201).json(user)
})

// ── GET /api/users ───────────────────────────────────────────────────────────
const listUsers = catchAsync(async (req, res) => {
    const users = await userModel.findAll(req.dbClient)
    return res.json(users)
})

// ── GET /api/users/:id ───────────────────────────────────────────────────────
const getUser = catchAsync(async (req, res) => {
    const { id } = req.params
    if (!id)
        throw new BadRequestError('Missing required field: id is required')
    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')
    return res.json(user)
})

// ── PATCH /api/users/:id ─────────────────────────────────────────────────────
const updateUser = catchAsync(async (req, res, next) => {
    const { id } = req.params
    if (!id)
        throw new BadRequestError('Missing required field: id is required')
    const { display_name, clinic_id } = req.body
    if (!display_name && !clinic_id)
        throw new BadRequestError('At least one of display_name or clinic_id is required')
    const user = await userModel.update(
        id,
        { display_name, clinic_id },
        req.dbClient
    )
    if (!user) throw new NotFoundError('User not found')
    return res.json(user)
})

// ── DELETE /api/users/:id ────────────────────────────────────────────────────
const deactivateUser = catchAsync(async (req, res) => {
    const { id } = req.params
    if (id === req.user.user_id)
        throw new BadRequestError('Cannot deactivate your own account')
    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')

    const result = await userModel.removeRole(id)
    return res.json({ message: 'User deactivated', user_id: id })
})

// ── POST /api/users/:id/role ─────────────────────────────────────────────────
const assignRole = catchAsync(async (req, res) => {
    const { id } = req.params
    if (!id) throw new BadRequestError('Missing required field: id is required')

    const { role_name } = req.body
    if (!role_name) throw new BadRequestError('role_name is required')

    const role = await userModel.findRoleByName(role_name, req.dbClient)
    if (!role) throw new NotFoundError(`Role '${role_name}' not found`)

    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')

    const result = await userModel.updateRole(id, role.role_id, req.user.user_id, req.dbClient)
    return res.json({ message: 'Role assigned', ...result, role_name })
})

export default { createUser, listUsers, getUser, updateUser, deactivateUser, assignRole }