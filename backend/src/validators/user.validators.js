import { body, param } from 'express-validator'

const UUID_SHAPE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const uuidParam=field => param(field)
  .matches(UUID_SHAPE)
  .withMessage(`${field} must be a valid UUID-formatted identifier`)

const uuidBody=field => body(field)
  .matches(UUID_SHAPE)
  .withMessage(`${field} must be a valid UUID-formatted identifier`)

export const userIdValidation = [
    uuidParam('id')
]

export const createUserValidation = [
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
        .isLength({ min: 12, max: 128 })
        .withMessage('password must be between 12 and 128 characters'),

    body('display_name')
        .optional()
        .isString()
        .withMessage('display_name must be a string')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('display_name must be between 1 and 100 characters'),

    body('clinic_id')
        .optional({ nullable: true })
        .matches(UUID_SHAPE)
        .withMessage('clinic_id must be a valid UUID'),

    body('role_id')
        .matches(UUID_SHAPE)
        .withMessage('role_id must be a valid UUID')
]

export const updateUserValidation = [
    uuidParam('id'),

    body('display_name')
        .optional()
        .isString()
        .withMessage('display_name must be a string')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('display_name must be between 1 and 100 characters'),

    body('clinic_id')
        .optional({ nullable: true })
        .matches(UUID_SHAPE)
        .withMessage('clinic_id must be a valid UUID'),

    body()
        .custom(value => {
            if (value.display_name === undefined && value.clinic_id === undefined)
                throw new Error('At least one of display_name or clinic_id is required')

            return true
        })
]

export const assignRoleValidation = [
    uuidParam('id'),

    body('role_name')
        .isString()
        .withMessage('role_name must be a string')
        .trim()
        .isLength({ min: 1, max: 64 })
        .withMessage('role_name must be between 1 and 64 characters')
]