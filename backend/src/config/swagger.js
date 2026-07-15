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
            { name: 'Auth', description: 'Authentication and session management' },
            { name: 'Users', description: 'User management' },
            { name: 'Clinics', description: 'Clinic management' },
            { name: 'Sessions', description: 'EEG session lifecycle' },
            { name: 'EEG', description: 'EEG data ingestion' },
        ],
        servers: [
            { url: `/`, description: 'Current server' }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Enter your Access Token (not Refresh Token)'
                },
            },
            schemas: {
                StimulusSetSummary: {
                    type: 'object',
                    properties: {
                        stimulus_set_id: {
                            type: 'string',
                            format: 'uuid',
                            example: '8af54db6-7020-48af-b9a3-26f416485d58'
                        },
                        clinic_id: {
                            type: 'string',
                            format: 'uuid',
                            example: 'b5d80c02-46eb-4442-a555-f7cd93f1a4d4'
                        },
                        name: {
                            type: 'string',
                            example: 'Default test image set'
                        },
                        version: {
                            type: 'integer',
                            example: 2
                        },
                        status: {
                            type: 'string',
                            enum: ['draft', 'active', 'archived'],
                            example: 'active'
                        },
                        created_by: {
                            type: 'string',
                            format: 'uuid',
                            nullable: true
                        },
                        created_at: {
                            type: 'string',
                            format: 'date-time'
                        },
                        activated_at: {
                            type: 'string',
                            format: 'date-time',
                            nullable: true
                        },
                        image_count: {
                            type: 'integer',
                            example: 24
                        }
                    }
                },

                StimulusSetImage: {
                    type: 'object',
                    properties: {
                        image_id: {
                            type: 'string',
                            format: 'uuid'
                        },
                        sequence_no: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 24,
                            example: 1
                        },
                        filename: {
                            type: 'string',
                            example: 'I1.jpg'
                        },
                        category: {
                            type: 'string',
                            nullable: true,
                            example: 'Nature'
                        },
                        url: {
                            type: 'string',
                            example: '/images/I1.jpg'
                        },
                        valence_mean: {
                            type: 'number',
                            format: 'double',
                            nullable: true,
                            example: 5.42
                        },
                        valence_sd: {
                            type: 'number',
                            format: 'double',
                            nullable: true,
                            example: 1.63
                        },
                        arousal_mean: {
                            type: 'number',
                            format: 'double',
                            nullable: true,
                            example: 4.78
                        },
                        arousal_sd: {
                            type: 'number',
                            format: 'double',
                            nullable: true,
                            example: 1.91
                        }
                    }
                },

                StimulusSetDetail: {
                    allOf: [
                        { $ref: '#/components/schemas/StimulusSetSummary' },
                        {
                            type: 'object',
                            properties: {
                                images: {
                                    type: 'array',
                                    items: {
                                        $ref: '#/components/schemas/StimulusSetImage'
                                    }
                                }
                            }
                        }
                    ]
                },

                UpdateStimulusSetImage: {
                    type: 'object',
                    required: ['image_id'],
                    properties: {
                        image_id: {
                            type: 'string',
                            format: 'uuid'
                        }
                    }
                },

                UpdateStimulusSetRequest: {
                    type: 'object',
                    required: ['images'],
                    properties: {
                        clinic_id: {
                            type: 'string',
                            format: 'uuid',
                            description: 'Required when the authenticated user is an administrator. Ignored for clinic technicians.'
                        },
                        name: {
                            type: 'string',
                            minLength: 1,
                            example: 'Updated clinic stimulus set'
                        },
                        status: {
                            type: 'string',
                            enum: ['draft', 'active'],
                            default: 'draft',
                            example: 'active'
                        },
                        images: {
                            type: 'array',
                            minItems: 24,
                            maxItems: 24,
                            uniqueItems: true,
                            description: 'Exactly 24 unique images. Array order determines sequence_no from 1 to 24.',
                            items: {
                                oneOf: [
                                    {
                                        type: 'string',
                                        format: 'uuid',
                                        example: 'f10fbe19-667e-473c-a718-e08a40e08b3f'
                                    },
                                    {
                                        $ref: '#/components/schemas/UpdateStimulusSetImage'
                                    }
                                ]
                            }
                        }
                    },
                    example: {
                        clinic_id: 'b5d80c02-46eb-4442-a555-f7cd93f1a4d4',
                        name: 'Updated clinic stimulus set',
                        status: 'active',
                        images: [
                            { image_id: 'f10fbe19-667e-473c-a718-e08a40e08b3f' },
                            { image_id: '102dfbf5-3449-480c-aa32-b14421ccdf50' },
                            { image_id: 'cd6d7951-3c64-4425-8aa7-49a18e8ff31e' }
                        ]
                    }
                },

                ErrorResponse: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['fail', 'error'],
                            example: 'fail'
                        },
                        error: {
                            type: 'string',
                            example: 'Stimulus set not found.'
                        },
                        constraint: {
                            type: 'string',
                            nullable: true
                        }
                    }
                }
            }
        },
        security: [{ bearerAuth: [] }],
    },
    apis: ['./src/routes/*.js'],
}

const swaggerSpec = swaggerJsdoc(options)

export default swaggerSpec