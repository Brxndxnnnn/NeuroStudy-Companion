import { randomUUID } from 'crypto'
import userModel from '../models/user.model.js'
import authService from '../services/auth.service.js'
import catchAsync from '../utils/catchAsync.js'

const login = catchAsync(async (req, res) => {
    const { email, password } = req.body

    if (!email || !password)
        return res.status(400).json({ error: 'Email and password are required.' })

    const user = await userModel.findByEmail(email)
    if (!user)
        return res.status(401).json({ error: 'Invalid credentials. Cannot find user.' })

    const valid = await authService.comparePassword(password, user.password_hash)
    if (!valid)
        return res.status(401).json({ error: 'Invalid credentials. Please check your email and password.' })

    const jti = randomUUID()
    const token = authService.signToken({
        jti,
        sub: user.user_id,
        email: user.email,
        role: user.role_name,
        role_id: user.role_id,
    })

    res.json({
        token,
        user: {
            user_id:      user.user_id,
            email:        user.email,
            display_name: user.display_name,
            role:         user.role_name,
        },
    })
})

const logout = catchAsync(async (req, res) => {
    const { jti, sub, exp } = req.user  // populated by authenticate middleware
    await authService.revokeToken(jti, sub, new Date(exp * 1000))
    res.json({ message: 'Logged out successfully.' })
})

const me = catchAsync(async (req, res) => {
    const user = await userModel.findById(req.user.sub)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    res.json(user)
})

export default { login, logout, me }