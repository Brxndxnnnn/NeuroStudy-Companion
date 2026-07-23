import { matchedData, validationResult } from 'express-validator'
import { BadRequestError } from '../utils/AppError.js'
const validateRequest = (req, res, next) => {
    const result = validationResult(req)

    if (!result.isEmpty()) {
        const details = result
            .array({ onlyFirstError: true })
            .map(error => `${error.path}: ${error.msg}`)
            .join(', ')

        throw new BadRequestError(
            `Request validation failed. ${details}`
        )
    }

    req.validated = matchedData(req, {
        onlyValidData: true
    })

    next()
}

export default validateRequest