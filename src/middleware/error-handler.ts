import { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';
import { config } from '../config';
import { logApiError } from '../services/error-logging';

export const errorHandler: ErrorHandler = (err, c) => {
  const requestId = c.get('requestId');

  logger.error({
    message: err.message,
    error: err,
    requestId,
    path: c.req.path,
    method: c.req.method,
  });

  if (err instanceof ZodError) {
    return c.json({
      error: 'Validation Error',
      details: err.errors,
      requestId,
    }, 400);
  }

  if (err.message === 'Unauthorized') {
    return c.json({
      error: 'Unauthorized',
      message: 'Authentication required',
      requestId,
    }, 401);
  }

  if (err.message === 'Forbidden') {
    return c.json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource',
      requestId,
    }, 403);
  }

  if (err.message === 'Not Found') {
    return c.json({
      error: 'Not Found',
      message: 'The requested resource was not found',
      requestId,
    }, 404);
  }

  // Log 500 errors to database in production
  if (config.env === 'production') {
    // Get user info if available from context
    const user = c.get('user') as { id?: string; organizationId?: string } | undefined;

    // Log asynchronously - don't await to avoid slowing down error response
    logApiError({
      requestId,
      errorMessage: err.message,
      errorStack: err.stack,
      path: c.req.path,
      method: c.req.method,
      userId: user?.id,
      organizationId: user?.organizationId,
      statusCode: 500,
    }).catch(() => {
      // Already logged in logApiError, ignore here
    });
  }

  return c.json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
    requestId,
  }, 500);
};