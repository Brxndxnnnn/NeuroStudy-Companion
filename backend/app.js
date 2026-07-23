import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import path from 'path'
import cookieParser from 'cookie-parser'
import { fileURLToPath } from 'url'
import swaggerUi from 'swagger-ui-express'

import apiRouter from './src/routes/index.js'
import swaggerSpec from './src/config/swagger.js'
import errorHandler from './src/middleware/errorHandler.js'
import { apiLimiter } from './src/middleware/rateLimiters.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }))
app.use(express.json({ limit: '5mb' }))
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use('/public', express.static(path.join(__dirname, 'public')))
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
app.use('/api', apiLimiter, apiRouter)
app.use(errorHandler)

export default app
