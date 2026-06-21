import { Router } from 'express'
import userController from '../controllers/user.controller.js'
import requirePermission from '../middleware/requirePermission.js'
import PERMS from '../constants/permissions.js'

const router = Router()

/**
 * @openapi
 * /api/users:
 *   post:
 *     summary: Create a new user (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:        { type: string, format: email }
 *               password:     { type: string, minLength: 8 }
 *               display_name: { type: string }
 *               clinic_id:    { type: string, format: uuid, example: "a0000000-0000-0000-0000-000000000001" }
 *               role_id:      { type: string, format: uuid, example: "d0000000-0000-0000-0000-000000000001" }
 *     responses:
 *       201:
 *         description: User created
 *       409:
 *         description: Email already in use
 */
router.post(
  '/',
  requirePermission(PERMS.USERS_WRITE_ALL),
  userController.createUser
)

/**
 * @openapi
 * /api/users:
 *   get:
 *     summary: List all users (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of users
 */
router.get(
  '/',
  requirePermission(PERMS.USERS_READ_ALL),
  userController.listUsers
)

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     summary: Get a single user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User object
 *       404:
 *         description: Not found
 */
router.get(
  '/:id',
  requirePermission(PERMS.USERS_READ_ALL),
  userController.getUser
)

/**
 * @openapi
 * /api/users/{id}:
 *   patch:
 *     summary: Update display_name or clinic_id
 *     tags: [Users]
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
 *               display_name: { type: string }
 *               clinic_id:    { type: string, format: uuid, nullable: true }
 *     responses:
 *       200:
 *         description: Updated user
 *       404:
 *         description: Not found
 */
router.patch(
  '/:id',
  requirePermission(PERMS.USERS_WRITE_ALL),
  userController.updateUser
)

/**
 * @openapi
 * /api/users/{id}:
 *   delete:
 *     summary: Deactivate a user (soft delete — removes their role)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User deactivated
 *       404:
 *         description: Not found
 */
router.delete(
  '/:id',
  requirePermission(PERMS.USERS_WRITE_ALL),
  userController.deactivateUser
)

/**
 * @openapi
 * /api/users/{id}/role:
 *   post:
 *     summary: Assign a role to a user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role_name]
 *             properties:
 *               role_name: { type: string, enum: [admin, technician] }
 *     responses:
 *       200:
 *         description: Role assigned
 *       404:
 *         description: User or role not found
 */
router.post(
  '/:id/role',
  requirePermission(PERMS.USERS_WRITE_ALL),
  userController.assignRole
)

export default router