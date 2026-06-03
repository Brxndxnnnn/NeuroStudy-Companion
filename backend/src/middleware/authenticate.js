import authService from '../services/auth.service.js'

const authenticate = async (req, res, next) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer '))
        return res.status(401).json({ error: 'Missing or malformed token.' })

    const token = header.slice(7)

    try {
        const payload = authService.verifyToken(token)

        const revoked = await authService.isRevoked(payload.jti)
        if (revoked)
            return res.status(401).json({ error: 'Token has been revoked.' })

        req.user = payload  // { jti, sub, email, role, role_id, iat, exp }
        next()
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token.' })
    }
}

export default authenticate