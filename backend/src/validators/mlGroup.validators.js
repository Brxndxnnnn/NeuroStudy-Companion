import { BadRequestError } from '../utils/AppError.js'

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_GROUP_NAME = 80
export const MAX_GROUP_MEMBERS = 200

export const isUuid = (v) => typeof v === 'string' && UUID_SHAPE.test(v)

/**
 * Validates a group create/update body. On create both fields are required; on update
 * either may be omitted. Returns { name, client_ids } with the name trimmed and the
 * client ids de-duplicated, or throws a BadRequestError listing every problem.
 */
export function validateGroupBody(body, { partial = false } = {}) {
    const problems = []
    const out = {}
    const { name, client_ids } = body ?? {}

    if (name !== undefined || !partial) {
        if (typeof name !== 'string' || !name.trim())
            problems.push('name is required')
        else if (name.trim().length > MAX_GROUP_NAME)
            problems.push(`name must be at most ${MAX_GROUP_NAME} characters`)
        else
            out.name = name.trim()
    }

    if (client_ids !== undefined || !partial) {
        if (!Array.isArray(client_ids) || client_ids.length === 0)
            problems.push('client_ids must be a non-empty array of client UUIDs')
        else if (!client_ids.every(isUuid))
            problems.push('client_ids must all be UUIDs')
        else if (client_ids.length > MAX_GROUP_MEMBERS)
            problems.push(`a group can have at most ${MAX_GROUP_MEMBERS} members`)
        else
            out.client_ids = [...new Set(client_ids.map(id => id.toLowerCase()))]
    }

    if (partial && out.name === undefined && out.client_ids === undefined && !problems.length)
        problems.push('nothing to update: send name and/or client_ids')

    if (problems.length) throw new BadRequestError(problems.join('; '))
    return out
}
