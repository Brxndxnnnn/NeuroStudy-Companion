import { Router } from 'express'
import clientController from '../controllers/client.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

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

export default router