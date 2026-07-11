import { BadRequestError, ConflictError } from '../utils/AppError.js';

// Helper to translate Postgres error codes into user-friendly AppErrors
const handlePostgresErrors = (err) => {
    // Postgres error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
    switch (err.code) {
        case '22P02': // invalid input syntax for type uuid
            return new BadRequestError('Invalid ID format provided.');
        
        case '22007': // invalid datetime format
        case '22008': // datetime field overflow
            return new BadRequestError('Invalid date format provided.');
            
        case '23505': // unique_violation (e.g., duplicate email)
            return new ConflictError(`Duplicate entry: ${err.detail || 'Resource already exists'}`);
            
        case '23503': // foreign_key_violation (e.g., invalid clinic_id)
            let msg = ''
            if (err.constraint.includes('_clinic_id_fkey'))
                msg = 'Invalid clinic_id: The specified clinic does not exist.'
            else if (err.constraint.includes('_session_id_fkey'))
                msg = 'Invalid session_id: related session does not exist.'
            else if (err.constraint.includes('_image_id_fkey'))
                msg = 'Invalid image_id: related image does not exist.'
            else if (err.constraint.includes('_question_id_fkey'))
                msg = 'Invalid question_id: related question does not exist.'
            else if (err.constraint.includes('_user_id_fkey') || err.constraint.includes('_conducted_by_fkey'))
                msg = 'Invalid user_id: The specified user does not exist.'
            else if (err.constraint.includes('_questionnaire_id_fkey'))
                msg = 'Invalid questionnaire_id: The specified questionnaire does not exist.'
            else if (err.constraint.includes('_current_event_id_fkey'))
                msg = 'Invalid event_id: The specified event does not exist.'
            else
                msg = `Foreign key violation: ${err.detail || 'Related resource does not exist'}`;
            return new BadRequestError(`Foreign key violation: ${err.detail || 'Related resource does not exist'}`);
            
        case '23502': // not_null_violation
            return new BadRequestError(`Missing required field: ${err.column || 'unknown'}`);
            
        case 'P0001': // raise_exception (Triggered by our PL/pgSQL functions like claim_session)
            return new BadRequestError(err.message);

        default:
            return null; // Let it fall through to the 500 handler
    }
};

const errorHandler = (err, req, res, next) => {
    let statusCode = err.statusCode || 500;
    let message = err.message || 'Internal Server Error';

    // 1. Handle known Postgres database errors
    const pgError = handlePostgresErrors(err);
    if (pgError) {
        statusCode = pgError.statusCode;
        message = pgError.message;
    }

    // 2. Send response to client
    // If it's an operational error (like a 400 or 404 we threw), send the message.
    // If it's a 500 programming error, hide the details to prevent leaking server info.
    if (err.isOperational || statusCode !== 500) {
        return res.status(statusCode).json({
            status: statusCode < 500 ? 'fail' : 'error',
            error: message,
            // Optional: send the raw constraint name if it helps the frontend
            constraint: err.constraint || undefined 
        });
    }

    // 3. Log programming/unknown errors (500s)
    console.error('💥 UNHANDLED 500 ERROR 💥', err);
    return res.status(500).json({
        status: 'error',
        message: 'Something went very wrong on our end. Please try again later.',
    });
};

export default errorHandler;