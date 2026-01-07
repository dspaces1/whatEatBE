import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase.js';

const router = Router();

router.get('/health', async (_req, res) => {
  try {
    // Test database connection
    const { error } = await supabaseAdmin.from('recipes').select('id').limit(1);

    res.json({
      status: error ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      database: error ? 'disconnected' : 'connected',
    });
  } catch {
    res.json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      database: 'error',
    });
  }
});

export default router;





