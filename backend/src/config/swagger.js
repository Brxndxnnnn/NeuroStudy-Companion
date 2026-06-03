import swaggerJsdoc from 'swagger-jsdoc'
const localPort = process.env.NODE_PORT || 3000

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'NeuroStudy Companion API',
            version: '1.0.0',
            description: 'EEG Focus Meter — Session Tracking and Insights',
        },
        tags: [
            { name: 'Auth',     description: 'Authentication and session management' },
            { name: 'Users',    description: 'User management' },
            { name: 'Clinics',  description: 'Clinic management' },
            { name: 'Sessions', description: 'EEG session lifecycle' },
            { name: 'EEG',      description: 'EEG data ingestion' },
        ],
        servers: [
            { url: `http://localhost:${localPort}`, description: 'Current server' }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    apis: ['./src/routes/*.js'],
}

const swaggerSpec = swaggerJsdoc(options)

export default swaggerSpec