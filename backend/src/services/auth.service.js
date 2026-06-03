import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import pool from '../config/db.js'

const SALT_ROUNDS = 12

const hashPassword = plaintext => bcrypt.hash(plaintext, SALT_ROUNDS)

const comparePassword = (plaintext, hash) => bcrypt.compare(plaintext, hash)

const signToken = (payload) =>
    jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
        issuer: 'neurostudy',
    })

const verifyToken = (token) => jwt.verify(token, process.env.JWT_SECRET)

const isRevoked = async (jti) => {
    const { rows } = await pool.query(
        'SELECT 1 FROM revoked_tokens WHERE jti = $1',
        [jti]
    )
    return rows.length > 0
}

const revokeToken = async (jti, user_id, expires_at) => {
    await pool.query(
        `INSERT INTO revoked_tokens (jti, user_id, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (jti) DO NOTHING`,
        [jti, user_id, expires_at]
    )
}

export default { hashPassword, comparePassword, signToken, verifyToken, isRevoked, revokeToken }