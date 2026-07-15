import imageModel from '../models/image.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'
import { checkAllowedImageLimit, parsePositiveInteger, normalizeOptionalQueryString } from '../utils/helper.js'

// ── GET /api/images ─────────────────────────────────────────────────────────────
// const getAllImages = catchAsync(async (req, res) => {
//     const images = await imageModel.findAll(req.dbClient)
//     return res.json(images)
// })

// ── GET /api/images/:image_id ───────────────────────────────────────────────────
const getImageById = catchAsync(async (req, res) => {
    const { image_id } = req.params
    if (!image_id)
        throw new BadRequestError('Missing required field: image_id is required')
    const images = await imageModel.findById(image_id, req.dbClient)
    if (!images || images.length === 0)
        throw new NotFoundError('Image not found')
    return res.json(images[0])
})

// ── GET /api/images ──────────────────────────────────────────────────────────
const getAllImages = catchAsync(async (req, res) => {
    const page = parsePositiveInteger(req.query.page ?? '1', 'page')

    const limit = parsePositiveInteger(req.query.limit ?? '25', 'limit')

    checkAllowedImageLimit(limit)

    const search = normalizeOptionalQueryString(req.query.search, 'search')
    const category = normalizeOptionalQueryString(req.query.category, 'category')

    if (search && search.length > 255)
        throw new BadRequestError('search must not exceed 255 characters.')
    if (category && category.length > 100)
        throw new BadRequestError('category must not exceed 100 characters.')

    const { images, total } = await imageModel.getAll({ search, category, page, limit }, req.dbClient)

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit)
    /*
     * req.originalUrl contains the exact mounted route, such as:
     * /api/images?page=2&limit=25
     *
     * Remove the current query string and rebuild it safely.
     */
    const requestPath = req.originalUrl.split('?')[0]

    const baseUrl = `${req.protocol}://${req.get('host')}${requestPath}`

    const buildPageUrl = (targetPage) => {
        const params = new URLSearchParams()

        params.set('page', String(targetPage))
        params.set('limit', String(limit))

        if (search)
            params.set('search', search)

        if (category)
            params.set('category', category)

        return `${baseUrl}?${params.toString()}`
    }

    const prev = page > 1 ? buildPageUrl(page - 1) : null

    const next = page < totalPages ? buildPageUrl(page + 1) : null

    return res.json({
        status: 'success',
        results: images.length,
        data: images,
        pagination: {
            page,
            limit,
            total,
            total_pages: totalPages,
            prev,
            next
        }
    })
})

export default { getAllImages, getImageById }