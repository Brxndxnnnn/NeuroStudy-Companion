import { Router } from 'express'
import clinicsController from '../controllers/clinics.controller.js'
import authenticate from '../middleware/authenticate.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

router.use(authenticate)

/**
 * @openapi
 * /api/clinics:
 *   post:
 *     summary: Create a new clinic
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:    { type: string }
 *               address: { type: string }
 *     responses:
 *       201:
 *         description: Clinic created
 */
router.post(
    '/',
    requirePermission(PERMS.CLINICS_WRITE_ALL),
    clinicsController.createClinic
)

/**
 * @openapi
 * /api/clinics:
 *   get:
 *     summary: List all clinics
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of clinics
 */
router.get(
    '/',
    requirePermission(PERMS.CLINICS_READ_ALL),
    clinicsController.listClinics
)

/**
 * @openapi
 * /api/clinics/{id}:
 *   get:
 *     summary: Get a single clinic
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Clinic object
 *       404:
 *         description: Not found
 */
router.get(
    '/:id',
    requirePermission(PERMS.CLINICS_READ_ALL),
    clinicsController.getClinic
)

/**
 * @openapi
 * /api/clinics/{id}:
 *   patch:
 *     summary: Update a clinic
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:    { type: string }
 *               address: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Updated clinic
 *       404:
 *         description: Not found
 */
router.patch(
    '/:id',
    requirePermission(PERMS.CLINICS_WRITE_ALL),
    clinicsController.updateClinic
)

export default router