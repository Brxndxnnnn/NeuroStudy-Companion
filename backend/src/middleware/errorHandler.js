import { BadRequestError, ConflictError, NotFoundError, AppError } from '../utils/AppError.js';

// Helper to translate Postgres error codes into user-friendly AppErrors
const handlePostgresErrors = (err) => {
    // Postgres error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
    const safeMessage = typeof err.message === 'string' && err.message.trim() ? err.message : 'Database operation failed';
    switch (err.code) {
        case 'ZA001':
            return new BadRequestError(safeMessage);
        case 'ZA002':
            return new ConflictError(safeMessage);
        case 'ZA003':
        case 'ZA004':
            return new AppError(safeMessage, 410);
        case 'ZA005':
            return new NotFoundError(safeMessage);

        case 'P2001':
        case 'P2002':
            return new NotFoundError(safeMessage);
        case 'P2003':
        case 'P2004':
            return new BadRequestError(safeMessage);
        case 'P2006': // claim_session: client has no published history
            return new ConflictError(safeMessage);

        // Session commentaries (db/migrations/023_session_commentaries.sql)
        case 'P2101': // session not found / not visible to this clinic
            return new NotFoundError(safeMessage);
        case 'P2102': // session has not completed
        case 'P2103': // published commentary cannot be changed or deleted
            return new ConflictError(safeMessage);

        // Questionnaire answers (db/migrations/024_bfi2_who5_questionnaires.sql)
        case 'P2301': // session not found / not visible to this clinic
            return new NotFoundError(safeMessage);
        case 'P2302': // answer not a whole number within the questionnaire's scale
            return new BadRequestError(safeMessage);

        // Client histories (db/migrations/022_client_histories.sql)
        case 'P2201': // client or history not found / not visible to this clinic
            return new NotFoundError(safeMessage);
        case 'P2202': // published history cannot be changed or deleted
            return new ConflictError(safeMessage);
        case 'P2203': // history incomplete, or not created as a draft
            return new BadRequestError(safeMessage);
        // ML groups (db/migrations/025_ml_group_models.sql)
        case 'P2501': // member is not a client of the group's clinic
            return new BadRequestError(safeMessage);
        case '22P02': // invalid input syntax for type uuid
            return new BadRequestError('Invalid ID format provided.');
        
        case '22007': // invalid datetime format
        case '22008': // datetime field overflow
            return new BadRequestError('Invalid date format provided.');
            
        case '23505': // unique_violation (e.g., duplicate email)
            return new ConflictError(`Duplicate entry: ${err.detail || 'Resource already exists'}`);
            
        case '23503': { // foreign_key_violation (e.g., invalid clinic_id)
            const constraint = err.constraint ?? '';
            let msg;
            if (constraint.includes('_clinic_id_fkey'))
                msg = 'Invalid clinic_id: The specified clinic does not exist.'
            else if (constraint.includes('_session_id_fkey'))
                msg = 'Invalid session_id: related session does not exist.'
            else if (constraint.includes('_image_id_fkey'))
                msg = 'Invalid image_id: related image does not exist.'
            else if (constraint.includes('_question_id_fkey'))
                msg = 'Invalid question_id: related question does not exist.'
            else if (constraint.includes('_user_id_fkey') || constraint.includes('_conducted_by_fkey'))
                msg = 'Invalid user_id: The specified user does not exist.'
            else if (constraint.includes('_questionnaire_id_fkey'))
                msg = 'Invalid questionnaire_id: The specified questionnaire does not exist.'
            else if (constraint.includes('_current_event_id_fkey'))
                msg = 'Invalid event_id: The specified event does not exist.'
            else
                msg = `Foreign key violation: A related resource does not exist`;
            return new BadRequestError(msg);
        }
            
        case '23502': // not_null_violation
            return new BadRequestError(`Missing required field: ${err.column || 'unknown'}`);
            
        case 'P0001': // raise_exception (Triggered by our PL/pgSQL functions like claim_session)
            return new BadRequestError(safeMessage);

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