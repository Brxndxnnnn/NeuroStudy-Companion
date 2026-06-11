import pg from 'pg'

const { Pool } = pg
const pool = new Pool({
  user: process.env.APP_DB_USER,
  password: process.env.APP_DB_PASSWORD,
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
})
export default pool
