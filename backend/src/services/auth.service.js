import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import pg from 'pg'
import pool from '../config/db.js'

const ACCESS_SECRET = process.env.JWT_SECRET
const ACCESS_EXPIRY = process.env.JWT_EXPIRES_IN || '15m'
const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SALT_ROUNDS = 12
const hashPassword = plaintext => bcrypt.hash(plaintext, SALT_ROUNDS)

const comparePassword = (plaintext, hash) => bcrypt.compare(plaintext, hash)

// In-memory revoked token set (O(1) lookup)
const revokedTokens = new Set();

// Setup dedicated listener for Postgres NOTIFY events
const setupRevocationListener = async () => {
  const listener = new pg.Client({
    user: process.env.APP_DB_USER,
    password: process.env.APP_DB_PASSWORD,
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
  });
  await listener.connect();
  await listener.query('LISTEN token_revocations');
  
  listener.on('notification', (msg) => {
    if (msg.channel === 'token_revocations') {
      revokedTokens.add(msg.payload);
    }
  });
};
setupRevocationListener().catch(console.error);

export const signAccessToken = (payload) => jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });
export const verifyAccessToken = (token) => jwt.verify(token, ACCESS_SECRET);
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const isRevoked = (jti) => revokedTokens.has(jti);

export const createRefreshSession = async (userId, refreshToken, ip, userAgent) => {
  const hash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_MS);
  await pool.query(
    `INSERT INTO active_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token_hash = EXCLUDED.refresh_token_hash,
       ip_address = EXCLUDED.ip_address,
       user_agent = EXCLUDED.user_agent,
       expires_at = EXCLUDED.expires_at,
       last_used_at = NOW()`,
    [userId, hash, ip, userAgent, expiresAt]
  );
};

export const findRefreshSession = async (refreshToken) => {
  const hash = hashToken(refreshToken);
  const res = await pool.query(
    'SELECT * FROM active_sessions WHERE refresh_token_hash = $1 AND expires_at > NOW()',
    [hash]
  );
  return res.rows[0];
};

export const deleteRefreshSession = async (refreshToken) => {
  const hash = hashToken(refreshToken);
  await pool.query('DELETE FROM active_sessions WHERE refresh_token_hash = $1', [hash]);
};

export const revokeAccessToken = async (jti, userId, expiresAt) => {
  await pool.query(
    'INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [jti, userId, expiresAt]
  );
  revokedTokens.add(jti); // Instant local invalidation
};

export default { 
    signAccessToken, verifyAccessToken, createRefreshSession, findRefreshSession, deleteRefreshSession, 
    comparePassword, hashPassword, revokeAccessToken, isRevoked, hashToken 
};