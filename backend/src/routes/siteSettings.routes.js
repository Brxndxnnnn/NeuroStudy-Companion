import { Router } from 'express'
import siteSettingsController from '../controllers/siteSettings.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/site-settings/image-display-interval:
 *   get:
 *     summary: Get the global inter-image display interval (admin only)
 *     tags: [Site settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Global image display interval
 *   put:
 *     summary: Update the global inter-image display interval (admin only)
 *     tags: [Site settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [image_display_interval_seconds]
 *             properties:
 *               image_display_interval_seconds:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 60
 *     responses:
 *       200:
 *         description: Global image display interval updated
 *       400:
 *         description: Invalid interval
 *       403:
 *         description: Administrator access is required
 */
router.get('/', requirePermission(PERMS.SITE_SETTINGS_MANAGE_ALL), siteSettingsController.getImageDisplayInterval)
router.put('/', requirePermission(PERMS.SITE_SETTINGS_MANAGE_ALL), siteSettingsController.updateImageDisplayInterval)

export default router
