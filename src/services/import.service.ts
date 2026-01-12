import { supabaseAdmin } from '../config/supabase.js';
import { recipeService } from './recipe.service.js';
import { logger } from '../utils/logger.js';
import type { LegacyCreateRecipe } from '../schemas/envelope.js';

const MAX_RETRIES = 3;

export class ImportService {
  /**
   * Process a pending import job
   */
  async processJob(jobId: string): Promise<void> {
    // Mark job as processing
    const { data: job, error: fetchError } = await supabaseAdmin
      .from('import_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      logger.error({ jobId, error: fetchError }, 'Failed to fetch import job');
      return;
    }

    // Update status to processing
    await supabaseAdmin
      .from('import_jobs')
      .update({ status: 'processing' })
      .eq('id', jobId);

    try {
      let recipeData: LegacyCreateRecipe;

      if (job.type === 'url' && job.input_url) {
        recipeData = await this.extractFromUrl(job.input_url);
      } else if (job.type === 'image' && job.input_image_path) {
        recipeData = await this.extractFromImage(job.input_image_path);
      } else {
        throw new Error('Invalid job type or missing input');
      }

      // Create the recipe using the service
      const recipe = await recipeService.createRecipe(recipeData, job.user_id);

      // Mark job as completed
      await supabaseAdmin
        .from('import_jobs')
        .update({
          status: 'completed',
          result_recipe_id: recipe.id,
        })
        .eq('id', jobId);

      logger.info({ jobId, recipeId: recipe.id }, 'Import job completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const retries = (job.retries ?? 0) + 1;

      if (retries < MAX_RETRIES) {
        // Retry later
        await supabaseAdmin
          .from('import_jobs')
          .update({
            status: 'pending',
            retries,
            error_message: errorMessage,
          })
          .eq('id', jobId);

        logger.warn({ jobId, retries, error: errorMessage }, 'Import job failed, will retry');
      } else {
        // Mark as failed
        await supabaseAdmin
          .from('import_jobs')
          .update({
            status: 'failed',
            retries,
            error_message: errorMessage,
          })
          .eq('id', jobId);

        logger.error({ jobId, error: errorMessage }, 'Import job failed permanently');
      }
    }
  }

  /**
   * Extract recipe data from a URL
   * TODO: Implement actual scraping logic
   */
  async extractFromUrl(url: string): Promise<LegacyCreateRecipe> {
    // TODO: Implement URL scraping
    // 1. Fetch the webpage
    // 2. Look for schema.org/Recipe JSON-LD
    // 3. Fall back to AI extraction if no structured data found

    logger.info({ url }, 'Extracting recipe from URL');

    // Placeholder implementation
    throw new Error('URL extraction not yet implemented');
  }

  /**
   * Extract recipe data from an image
   * TODO: Implement actual OCR/AI logic
   */
  async extractFromImage(imagePath: string): Promise<LegacyCreateRecipe> {
    // TODO: Implement image extraction
    // 1. Get signed URL for the image from Supabase Storage
    // 2. Send to OpenAI Vision API
    // 3. Parse the response into recipe data

    logger.info({ imagePath }, 'Extracting recipe from image');

    // Placeholder implementation
    throw new Error('Image extraction not yet implemented');
  }
}

export const importService = new ImportService();
