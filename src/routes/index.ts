import { Router } from 'express';
import healthRouter from './health.js';
import authRouter from './auth.js';
import recipesRouter from './recipes.js';
import importRouter from './import.js';
import dailyRouter from './daily.js';
import feedRouter from './feed.js';
import shareRouter from './share.js';

export const routes = Router();

// Health check (no auth required)
routes.use(healthRouter);

// Auth routes (no auth required - this IS the auth)
routes.use('/auth', authRouter);

// Feed routes (public browsing, auth optional except for save)
routes.use('/feed', feedRouter);

// Share routes (public viewing, auth required for creating/revoking)
routes.use('/share', shareRouter);

// Protected routes
routes.use('/recipes', recipesRouter);
routes.use('/import', importRouter);
routes.use('/daily', dailyRouter);
