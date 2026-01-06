import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { routes } from './routes/index.js';

export const createApp = () => {
  const app = express();

  // Request ID tracking
  app.use(requestId);

  // Security
  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));

  // Parsing
  app.use(express.json({ limit: '10mb' }));

  // Logging
  app.use(pinoHttp({
    logger,
    customProps: (req) => ({
      requestId: req.requestId,
    }),
  }));

  // Routes
  app.use('/api/v1', routes);

  // Error handling (must be last)
  app.use(errorHandler);

  return app;
};



