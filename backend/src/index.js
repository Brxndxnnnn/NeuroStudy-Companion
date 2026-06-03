import express from 'express'
import pg from 'pg'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const app = express()
app.use(express.json())

const pool = new pg.Pool({
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT,
    database: process.env.POSTGRES_DB,
});

app.get('/health', async (req, res) => {
    try {
        const result = await pool.query('SELECT now() AS db_time')
        res.json({ status: 'ok', db_time: result.rows[0].db_time, msg: 'Server and database are healthy' })
    } catch (err) {
        res.status(500).json({ status: 'db_error', error: err.message })
    }
})

// Test: get all roles
app.get('/test/roles', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM roles ORDER BY created_at')
        res.json(result.rows)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// Test: get all permissions
app.get('/test/permissions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM permissions ORDER BY name')
        res.json(result.rows)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

const PORT = process.env.NODE_PORT || 3000
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))