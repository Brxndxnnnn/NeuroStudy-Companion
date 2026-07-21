import { Router } from 'express'
import clinicController from '../controllers/clinic.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/clinics/database-access:
 *   get:
 *     summary: List clinics with database access information
 *     description: |
 *       Returns every clinic together with its database roles and
 *       activation codes. Activation-code hashes are never returned.
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Clinic database access overview retrieved
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Administrator permission required
 */
router.get(
    '/database-access',
    requirePermission(PERMS.CLINICS_READ_ALL),
    clinicController.getClinicDatabaseAccessOverview
)

/**
 * @openapi
 * /api/clinics/activation-codes/{activation_id}/revoke:
 *   patch:
 *     summary: Revoke an unused activation code
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: activation_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Activation code revoked
 *       400:
 *         description: Invalid activation UUID
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Administrator permission required
 *       404:
 *         description: Activation code not found
 *       409:
 *         description: Activation code has already been used
 *       410:
 *         description: Activation code has expired
 */
router.patch(
    '/activation-codes/:activation_id/revoke',
    requirePermission(PERMS.CLINICS_WRITE_ALL),
    clinicController.revokeClinicDatabaseAccess
)

/**
 * @swagger
 * /api/clinics/stimulus-sets:
 *   get:
 *     summary: Retrieve stimulus sets for a clinic
 *     description: |
 *       Returns stimulus sets visible to the authenticated user.
 *
 *       Clinic technicians are restricted to their own clinic through
 *       PostgreSQL row-level security and should not provide clinic_id.
 *
 *       Administrators must provide clinic_id as a query parameter.
 *     tags:
 *       - Clinics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clinic_id
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Required for administrators. Not required for clinic technicians.
 *     responses:
 *       200:
 *         description: Stimulus sets retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 results:
 *                   type: integer
 *                   example: 2
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/StimulusSetSummary'
 *       400:
 *         description: Missing or invalid clinic_id for an administrator.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Authentication required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: User is not authorized to access the requested clinic.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
    '/stimulus-sets',
    clinicController.getClinicStimulusSets
)

/**
 * @swagger
 * /api/clinics/stimulus-sets/{stimulus_set_id}:
 *   get:
 *     summary: Retrieve one stimulus set with its images
 *     description: |
 *       Returns the selected stimulus set together with its ordered images.
 *
 *       The images array is ordered by sequence_no.
 *
 *       Clinic technicians are restricted through PostgreSQL row-level
 *       security. Administrators must provide clinic_id.
 *     tags:
 *       - Clinics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stimulus_set_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Stimulus set UUID.
 *       - in: query
 *         name: clinic_id
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Required for administrators. Not required for clinic technicians.
 *     responses:
 *       200:
 *         description: Stimulus set retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/StimulusSetDetail'
 *       400:
 *         description: Invalid UUID or missing clinic_id for an administrator.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Authentication required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: User is not authorized to access the requested stimulus set.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Stimulus set not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get(
    '/stimulus-sets/:stimulus_set_id',
    clinicController.getClinicStimulusSetById
)

/**
 * @swagger
 * /api/clinics/stimulus-sets/{stimulus_set_id}:
 *   put:
 *     summary: Replace a clinic stimulus set and its images
 *     description: |
 *       Replaces the stimulus set name, status and complete ordered image list.
 *
 *       Exactly 24 unique image IDs must be supplied. Their order in the
 *       request array becomes sequence_no 1 through 24.
 *
 *       Updating a draft modifies that draft directly. Updating an active or
 *       archived set creates a new version so sessions referencing an older
 *       version remain historically accurate.
 *
 *       Activating the resulting set archives the clinic's previously active
 *       set. Saving it as draft leaves the current active set unchanged.
 *
 *       Administrators must include clinic_id in the request body. Clinic
 *       technicians are scoped to their clinic through PostgreSQL row-level
 *       security.
 *     tags:
 *       - Clinics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: stimulus_set_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: UUID of the stimulus set being edited.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateStimulusSetRequest'
 *     responses:
 *       200:
 *         description: Stimulus set updated successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/StimulusSetDetail'
 *                 meta:
 *                   type: object
 *                   properties:
 *                     created_new_version:
 *                       type: boolean
 *                       example: true
 *                     source_stimulus_set_id:
 *                       type: string
 *                       format: uuid
 *             example:
 *               status: success
 *               data:
 *                 stimulus_set_id: 2a71c348-cfe8-4472-b18f-f62299021ad1
 *                 clinic_id: b5d80c02-46eb-4442-a555-f7cd93f1a4d4
 *                 name: Updated clinic stimulus set
 *                 version: 3
 *                 status: active
 *                 image_count: 24
 *                 images: []
 *               meta:
 *                 created_new_version: true
 *                 source_stimulus_set_id: 8af54db6-7020-48af-b9a3-26f416485d58
 *       400:
 *         description: |
 *           Invalid request, including an invalid UUID, duplicate images,
 *           an image count other than 24, invalid status or missing clinic_id
 *           for an administrator.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Authentication required.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: User is not authorized to update the stimulus set.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Stimulus set not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Update conflicts with an existing stimulus-set version or active set.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put(
    '/stimulus-sets/:stimulus_set_id',
    clinicController.updateClinicStimulusSet
)

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
    clinicController.createClinic
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
    clinicController.listClinics
)

/**
 * @openapi
 * /api/clinics/{id}/database-access:
 *   post:
 *     summary: Create database access for a clinic installation
 *     tags: [Clinics]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expires_in_hours:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 168
 *                 default: 24
 *     responses:
 *       201:
 *         description: Database role and activation code created
 *       404:
 *         description: Clinic not found
 */
router.post(
    '/:id/database-access',
    requirePermission(PERMS.CLINICS_WRITE_ALL),
    clinicController.createClinicDatabaseAccess
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
    clinicController.getClinic
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
    clinicController.updateClinic
)

export default router