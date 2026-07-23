import userModel from '../models/user.model.js'
import catchAsync from '../utils/catchAsync.js'
import authService from '../services/auth.service.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── POST /api/users ──────────────────────────────────────────────────────────
const createUser = catchAsync(async (req, res, next) => {
    const { email, password, display_name, clinic_id, role_id } = req.validated

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

// ── GET /api/users/roles ─────────────────────────────────────────────────────
const listRoles = catchAsync(async (req, res) => {
    const roles = await userModel.findAllRoles(req.dbClient)
    return res.json(roles)
})

// ── GET /api/users/:id ───────────────────────────────────────────────────────
const getUser = catchAsync(async (req, res) => {
    const { id } = req.validated
    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')
    return res.json(user)
})

// ── PATCH /api/users/:id ─────────────────────────────────────────────────────
const updateUser = catchAsync(async (req, res, next) => {
    const { id, display_name, clinic_id} = req.validated
    
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
    const { id } = req.validated
    if (id === req.user.sub)
        throw new BadRequestError('Cannot deactivate your own account')
    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')

    const result = await userModel.removeRole(id)
    return res.json({ message: 'User deactivated', user_id: id })
})

// ── POST /api/users/:id/role ─────────────────────────────────────────────────
const assignRole = catchAsync(async (req, res) => {
    const { id, role_name } = req.validated

    const role = await userModel.findRoleByName(role_name, req.dbClient)
    if (!role) throw new NotFoundError(`Role '${role_name}' not found`)

    const user = await userModel.findById(id, req.dbClient)
    if (!user) throw new NotFoundError('User not found')

    const result = await userModel.updateRole(id, role.role_id, req.user.sub, req.dbClient)
    return res.json({ message: 'Role assigned', ...result, role_name })
})

export default { createUser, listUsers, listRoles, getUser, updateUser, deactivateUser, assignRole }