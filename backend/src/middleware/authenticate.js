import authService from '../services/auth.service.js'
import { UnauthorizedError } from '../utils/AppError.js'

const authenticate = async (req, res, next) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer '))
        throw new UnauthorizedError('Missing or malformed token.')

    const token = header.slice(7)

    try {
        const payload = authService.verifyAccessToken(token)
        if (!payload || !payload.jti || !payload.sub)
            throw new UnauthorizedError('Invalid token payload.')

        const revoked = await authService.isRevoked(payload.jti)
        if (revoked)
            throw new UnauthorizedError('Token has been revoked.')

        req.user = payload  // { jti, sub, email, role, role_id, iat, exp }
        next()
    } catch (err) {
        throw new UnauthorizedError('Invalid or expired token.')
    }
}

export default authenticate