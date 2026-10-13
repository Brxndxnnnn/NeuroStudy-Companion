import { Router } from 'express'
import clientController from '../controllers/client.controller.js'
import clientHistoriesRouter from './clientHistories.routes.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

router.use('/:client_id/histories', clientHistoriesRouter)

/**
 * @openapi
 * /api/clients:
 *   get:
 *     summary: Retrieve a list of all clients
 *     description: |
 *       This endpoint allows you to retrieve a list of all clients stored in the database.
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of clients
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   client_id:
 *                     type: string
 *                     format: uuid
 *                   name:
 *                     type: string
 */
router.get(
    '/',
    requirePermission(PERMS.CLIENTS_READ_OWN_CLINIC),
    clientController.listClients
)

/**
 * @openapi
 * /api/clients/{client_id}:
 *   get:
 *     summary: Retrieve a specific client by its ID
 *     description: |
 *       This endpoint allows you to retrieve a specific client by providing its unique identifier (client_id).
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: client_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The unique identifier of the client to retrieve.
 *     responses:
 *       200:
 *         description: The requested client
 */
router.get(
    '/:client_id',
    requirePermission(PERMS.CLIENTS_READ_OWN_CLINIC),
    clientController.getClientById
)

/**
 * @openapi
 * /api/clients:
 *   post:
 *     summary: Create a new client
 *     description: |
 *       This endpoint allows you to create a new client by providing the necessary information in the request body.
 *       The client will be associated with the clinic of the authenticated user.
 * 
 *       For **technician users**, the `clinic_id` will be automatically set to the clinic of the authenticated user.
 *       For **admin users**, the `clinic_id` can be specified in the request body to create a client for a different clinic.
 *
 *       The complete client `history` is required: the client and its first published
 *       history (version 1) are created in one transaction, because a client cannot be
 *       paired to a session without a published history.
 *     tags: [Clients]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, dob, gender, race, history]
 *             properties:
 *               history:
 *                 $ref: '#/components/schemas/ClientHistoryInput'
 *               name:
 *                 { type: string, example: "John Doe" }
 *               dob:
 *                 { type: string, format: date }
 *               gender:
 *                 { type: string, example: "Male" }
 *               race:
 *                 { type: string, example: "Chinese" }
 *               notes:
 *                 { type: string, example: "Patient has a history of migraines." }
 *               clinic_id:
 *                 { type: string, format: uuid, example: "a0000000-0000-0000-0000-000000000001" }
 *     responses:
 *       201:
 *         description: The created client, with its published history under `history`
 *       400:
 *         description: Missing required fields, or an incomplete or invalid history
 *       401:
 *         description: Not authenticated
 */
router.post(
    '/',
    requirePermission(PERMS.CLIENTS_WRITE_OWN_CLINIC),
    clientController.createClient
)

export default router