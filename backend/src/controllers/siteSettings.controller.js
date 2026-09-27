import siteSettingsModel from '../models/siteSettings.model.js'
import catchAsync from '../utils/catchAsync.js'
import { BadRequestError, NotFoundError } from '../utils/AppError.js'

const getImageDisplayInterval = catchAsync(async (req, res) => {
    const settings = await siteSettingsModel.getImageDisplayInterval(req.dbClient)
    if (!settings)
        throw new NotFoundError('Global site settings are not configured.')
    return res.json(settings)
})

const updateImageDisplayInterval = catchAsync(async (req, res) => {
    const { image_display_interval_seconds } = req.body
    if (!Number.isInteger(image_display_interval_seconds) || image_display_interval_seconds < 1 || image_display_interval_seconds > 60)
        throw new BadRequestError('image_display_interval_seconds must be an integer between 1 and 60.')

    const settings = await siteSettingsModel.updateImageDisplayInterval(
        image_display_interval_seconds,
        req.user.sub,
        req.dbClient
    )
    if (!settings)
        throw new NotFoundError('Global site settings are not configured.')
    return res.json(settings)
})

export default { getImageDisplayInterval, updateImageDisplayInterval }
