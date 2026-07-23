import { body } from 'express-validator'

export const loginValidation = [
    body('email')
        .isString()
        .withMessage('email must be a string')
        .trim()
        .isLength({ min: 3, max: 254 })
        .withMessage('email must be between 3 and 254 characters')
        .isEmail()
        .withMessage('A valid email is required')
        .normalizeEmail({ all_lowercase: false }),

    body('password')
        .isString()
        .withMessage('password must be a string')
        .isLength({ min: 1, max: 256 })
        .withMessage('password is required and must not exceed 256 characters'),

    body('override')
        .optional()
        .isBoolean()
        .withMessage('override must be a boolean')
        .toBoolean()
]