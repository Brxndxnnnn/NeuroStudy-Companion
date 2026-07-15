import { BadRequestError } from './AppError.js'
const ALLOWED_IMAGE_LIMITS = new Set([10, 25, 50])

const checkAllowedImageLimit = (limit) => {
    if (!ALLOWED_IMAGE_LIMITS.has(limit))
        throw new BadRequestError('limit must be one of: 10, 25, or 50.')
}

const parsePositiveInteger = (value, fieldName) => {
    const normalizedValue = String(value)
    /*
     * Number.parseInt('10abc', 10) returns 10, which is too permissive.
     * This check ensures the entire value is a positive integer.
     */
    if (!/^[1-9]\d*$/.test(normalizedValue))
        throw new BadRequestError(`${fieldName} must be a positive integer.`)

    const parsedValue = Number(normalizedValue)

    if (!Number.isSafeInteger(parsedValue))
        throw new BadRequestError(`${fieldName} is outside the supported range.`)

    return parsedValue
}

const normalizeOptionalQueryString = (value, fieldName) => {
    if (value === undefined || value === null)
        return null
    /*
     * Reject arrays such as:
     * ?category=Nature&category=People
     */
    if (typeof value !== 'string')
        throw new BadRequestError(`${fieldName} must be a single text value.`)

    const normalizedValue = value.trim()
    return normalizedValue || null
}

const isAdminUser = req => req.user?.is_admin === true || req.user?.role === 'admin'

const getClinicScope = (req, source = 'query') => {
    const isAdmin = isAdminUser(req)
    const suppliedClinicId = source === 'body'
        ? req.body.clinic_id
        : req.query.clinic_id

    if (isAdmin && !suppliedClinicId)
        throw new BadRequestError('clinic_id is required for administrators.')

    return {
        isAdmin,
        clinicId: isAdmin ? suppliedClinicId : req.user.clinic_id
    }
}

export {
    checkAllowedImageLimit,
    parsePositiveInteger,
    normalizeOptionalQueryString,
    isAdminUser,
    getClinicScope
}