import { Router } from 'express'
import imageController from '../controllers/image.controller.js'

const router = Router()

/**
 * @openapi
 * /api/images/categories:
 *   get:
 *     summary: Retrieve a list of all image categories
 *     description: |
 *       This endpoint allows you to retrieve a list of all image categories stored in the database.
 *     tags: [Images]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of image categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                status:
 *                 type: string
 *                length:
 *                 type: integer
 *                results:
 *                 type: array
 *                 items:
 *                   type: string
 */
router.get(
    '/categories',
    imageController.getImageCategories
)

/**
 * @openapi
 * /api/images:
 *   get:
 *     summary: Retrieve a list of all images
 *     description: |
 *       This endpoint allows you to retrieve a list of all images stored in the database.
 *     tags: [Images]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: The page number to retrieve
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 25
 *         description: The number of images to retrieve per page
 *       - in: query
 *         name: search
 *         required: false
 *         schema:
 *           type: string
 *         description: A search term to filter images by filename
 *       - in: query
 *         name: category
 *         required: false
 *         schema:
 *           type: string
 *         description: A category to filter images by
 *     responses:
 *       200:
 *         description: A list of images
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       image_id:
 *                         type: string
 *                         format: uuid
 *                       filename:
 *                         type: string
 *                       category:
 *                         type: string
 *                       url:
 *                         type: string
 *                       valence_mean:
 *                         type: number
 *                       valence_sd:
 *                         type: number
 *                       arousal_mean:
 *                         type: number
 *                       arousal_sd:
 *                         type: number
 *                       display_order:
 *                         type: integer
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *                     prev:
 *                       type: string
 *                       nullable: true
 *                     next:
 *                       type: string
 *                       nullable: true
 */
router.get(
    '/',
    imageController.getAllImages
)

/**
 * @openapi
 * /api/images/{image_id}:
 *   get:
 *     summary: Retrieve a specific image by its ID
 *     description: |
 *       This endpoint allows you to retrieve a specific image by providing its unique identifier (image_id).
 *     tags: [Images]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: image_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The unique identifier of the image to retrieve.
 *     responses:
 *       200:
 *         description: The requested image
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 image_id:
 *                   type: string
 *                   format: uuid
 *                 filename:
 *                   type: string
 *                 url:
 *                   type: string
 *                 category:
 *                   type: string
 *                 valence_mean:
 *                   type: number
 *                 valence_sd:
 *                   type: number
 *                 arousal_mean:
 *                   type: number
 *                 arousal_sd:
 *                   type: number
 *                 display_order:
 *                   type: integer
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Image not found
 */
router.get(
    '/:image_id',
    imageController.getImageById
)

export default router