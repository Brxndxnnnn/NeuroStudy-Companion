import { Router } from 'express'
import imageController from '../controllers/image.controller.js'

const router = Router()

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
 *     responses:
 *       200:
 *         description: A list of images
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   image_id:
 *                     type: string
 *                     format: uuid
 *                   filename:
 *                     type: string
 *                   url:
 *                     type: string
 *                   category:
 *                     type: string
 *                   created_at:
 *                     type: string
 *                     format: date-time
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