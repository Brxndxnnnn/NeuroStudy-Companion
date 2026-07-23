import { ipKeyGenerator, rateLimit } from 'express-rate-limit'

const sendRateLimitResponse = (req, res) => {
    const retryAfter = res.getHeader('Retry-After')

    return res.status(429).json({
        status: 'fail',
        error: 'Too many requests. Please try again later.',
        retry_after_seconds: retryAfter ? Number(retryAfter) : undefined
    })
}

const createLimiter = options => rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: sendRateLimitResponse,
    ...options
})

export const apiLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 500,
    skip: req => req.path === '/health'
})

export const authenticatedApiLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    keyGenerator: req => req.user?.sub || ipKeyGenerator(req.ip)
})

export const loginLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true
})

export const refreshLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 60
})

export const activationLimiter = createLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10
})

export const adminReadLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 150,
    keyGenerator: req => req.user?.sub || ipKeyGenerator(req.ip)
})

export const adminWriteLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    keyGenerator: req => req.user?.sub || ipKeyGenerator(req.ip)
})