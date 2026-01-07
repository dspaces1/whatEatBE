import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Log the error
  logger.error({
    err,
    method: req.method,
    url: req.url,
    userId: (req as { userId?: string }).userId,
  }, 'Request error');

  // Handle known application errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  // Handle validation errors from Zod
  if (err.name === 'ZodError') {
    res.status(400).json({
      error: 'Validation error',
      details: err,
    });
    return;
  }

  // Default to 500 internal server error
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
};





