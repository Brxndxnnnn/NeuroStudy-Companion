import { randomUUID } from 'crypto'
import userModel from '../models/user.model.js'
import authService from '../services/auth.service.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../utils/AppError.js'
import pool from '../config/db.js'

const refreshCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
}

const refreshCookieMaxAge = 7 * 24 * 60 * 60 * 1000

const setRefreshCookie = (res, token) => {
    res.cookie('refreshToken', token, {
        ...refreshCookieOptions,
        maxAge: refreshCookieMaxAge
    })
}

const clearRefreshCookie = res => {
    res.clearCookie('refreshToken', refreshCookieOptions)
}

const login = catchAsync(async (req, res) => {
    const { email, password, override } = req.validated
    if (!email || !password)
        throw new BadRequestError('Email and password are required.')

    // Auth flows must bypass RLS to verify credentials across clinics
    const client = await pool.connect()
    try {
        await client.query("SELECT set_config('app.is_admin', 'true', false)")
        const user = await userModel.findByEmail(email, client)
        await client.query("RESET app.is_admin")

        if (!user) throw new UnauthorizedError('Invalid credentials. Please check your email and password.')

        const valid = await authService.comparePassword(password, user.password_hash)
        if (!valid) throw new UnauthorizedError('Invalid credentials. Please check your email and password.')

        const existingSession = await authService.detectActiveSession(user.user_id)
        if (existingSession && !override)
            throw new ConflictError('An active session already exists for this user. Are you sure you want to override it?')

        // Generate dual tokens
        const jti = randomUUID()
        const accessToken = authService.signAccessToken({
            jti,
            sub: user.user_id,
            email: user.email,
            role: user.role_name,
            role_id: user.role_id,
            clinic_id: user.clinic_id
        })

        const refreshToken = randomUUID()
        await authService.createRefreshSession(user.user_id, refreshToken, req.ip, req.headers['user-agent'])

        setRefreshCookie(res, refreshToken)
        res.set('Cache-Control', 'no-store') // Prevent caching of sensitive data

        res.json({
            accessToken,
            user: {
                user_id: user.user_id,
                email: user.email,
                display_name: user.display_name,
                role: user.role_name,
                clinic_id: user.clinic_id
            }
        })
    } finally {
        client.release()
    }
})

const refresh = catchAsync(async (req, res) => {
    const currentRefreshToken = req.cookies.refreshToken
    if (!currentRefreshToken) throw new UnauthorizedError('No refresh token provided.')

    const newRefreshToken = randomUUID()
    const rotatedSession = await authService.rotateRefreshSession(currentRefreshToken, newRefreshToken, req.ip, req.headers['user-agent'])

    if (!rotatedSession) {
        clearRefreshCookie(res)
        throw new UnauthorizedError('Invalid or expired session.')
    }

    // Bypass RLS to fetch user claims for new access token
    const client = await pool.connect()
    try {
        await client.query("SELECT set_config('app.is_admin', 'true', false)")
        const user = await userModel.findById(rotatedSession.user_id, client)
        await client.query("RESET app.is_admin")

        if (!user) {
            await authService.deleteRefreshSession(newRefreshToken)
            clearRefreshCookie(res)
            throw new UnauthorizedError('Invalid or expired session.')
        }

        // Generate a new access token with updated claims
        const newAccessToken = authService.signAccessToken({
            jti: randomUUID(),
            sub: user.user_id,
            email: user.email,
            role: user.role,
            role_id: user.role_id,
            clinic_id: user.clinic_id
        })

        setRefreshCookie(res, newRefreshToken)
        res.set('Cache-Control', 'no-store') // Prevent caching of sensitive data

        res.json({ accessToken: newAccessToken })
    } finally {
        client.release()
    }
})

const logout = catchAsync(async (req, res) => {
    const cookies = req.cookies
    if (!cookies.refreshToken) throw new BadRequestError('No refresh token provided.')
    const refreshToken = cookies.refreshToken
    if (refreshToken)
        await authService.deleteRefreshSession(refreshToken)

    clearRefreshCookie(res)

    if (req.user?.jti) {
        await authService.revokeAccessToken(req.user.jti, req.user.sub, new Date(req.user.exp * 1000))
    }

    res.json({ message: 'Logged out successfully.' })
})

const me = catchAsync(async (req, res) => {
    const user = await userModel.findById(req.user.sub, req.dbClient)
    if (!user) throw new NotFoundError('User not found.')
    res.json(user)
})

export default { login, refresh, logout, me }