import imageModel from '../models/image.model.js'
import catchAsync from '../utils/catchAsync.js'

// ── GET /api/images ─────────────────────────────────────────────────────────────
const getAllImages = catchAsync(async (req, res) => {
    const images = await imageModel.findAll(req.dbClient)
    return res.json(images)
})

// ── GET /api/images/:image_id ───────────────────────────────────────────────────
const getImageById = catchAsync(async (req, res) => {
    const { image_id } = req.params
    let images
    try {
        images = await imageModel.findById(image_id, req.dbClient)
    } catch (err) {
        if (err.code === '22P02') { // invalid input syntax for uuid
            return res.status(400).json({ error: 'Invalid image_id format' })
        }
        return res.status(500).json({ error: 'Internal server error' })
    }
    if (!images || images.length === 0)
        return res.status(404).json({ error: 'Image not found' })
    return res.json(images[0])
})

export default { getAllImages, getImageById }