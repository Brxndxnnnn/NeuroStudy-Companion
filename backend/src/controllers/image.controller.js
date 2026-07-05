import imageModel from '../models/image.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

// ── GET /api/images ─────────────────────────────────────────────────────────────
const getAllImages = catchAsync(async (req, res) => {
    const images = await imageModel.findAll(req.dbClient)
    return res.json(images)
})

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

export default { getAllImages, getImageById }