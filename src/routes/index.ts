import { Router } from 'express';
import healthRouter from './health.js';
import authRouter from './auth.js';
import recipesRouter from './recipes.js';
import importRouter from './import.js';
import dailyRouter from './daily.js';

export const routes = Router();

// Health check (no auth required)
routes.use(healthRouter);

// Auth routes (no auth required - this IS the auth)
routes.use('/auth', authRouter);

// Protected routes
routes.use('/recipes', recipesRouter);
routes.use('/import', importRouter);
routes.use('/daily', dailyRouter);



