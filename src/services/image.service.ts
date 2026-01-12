import OpenAI from 'openai';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class ImageService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Generate a hero image for a recipe using DALL-E 3
   */
  async generateRecipeImage(
    title: string,
    description?: string,
    cuisine?: string
  ): Promise<{ url: string; storagePath: string | null } | null> {
    if (!this.openai) {
      logger.warn('OpenAI client not configured, skipping image generation');
      return null;
    }

    try {
      // Build a prompt that generates appetizing food photography
      const prompt = this.buildImagePrompt(title, description, cuisine);

      logger.info({ title, prompt }, 'Generating recipe image with DALL-E');

      const response = await this.openai.images.generate({
        model: env.DALLE_MODEL,
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        style: 'natural',
      });

      const imageUrl = response.data?.[0]?.url;
      if (!imageUrl) {
        logger.error('DALL-E returned no image URL');
        return null;
      }

      // Upload to Supabase Storage for persistence
      const storagePath = await this.uploadToStorage(imageUrl, title);

      return {
        url: storagePath ? this.getPublicUrl(storagePath) : imageUrl,
        storagePath,
      };
    } catch (error) {
      logger.error({ error, title }, 'Failed to generate recipe image');
      return null;
    }
  }

  /**
   * Build an optimized prompt for food photography
   */
  private buildImagePrompt(title: string, description?: string, cuisine?: string): string {
    const cuisineHint = cuisine ? `${cuisine} cuisine, ` : '';
    const descHint = description ? ` The dish is: ${description.slice(0, 100)}.` : '';

    return (
      `Professional food photography of "${title}". ` +
      `${cuisineHint}beautifully plated, overhead shot on a rustic wooden table. ` +
      `Soft natural lighting, shallow depth of field, appetizing presentation.${descHint} ` +
      `High resolution, editorial quality, no text or watermarks.`
    );
  }

  /**
   * Upload an image from URL to Supabase Storage
   */
  private async uploadToStorage(imageUrl: string, title: string): Promise<string | null> {
    try {
      // Fetch the image from DALL-E URL
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const fileName = this.generateFileName(title);
      const filePath = `generated/${fileName}`;

      const { error } = await supabaseAdmin.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .upload(filePath, buffer, {
          contentType: 'image/png',
          cacheControl: '31536000', // 1 year cache
        });

      if (error) {
        logger.error({ error, filePath }, 'Failed to upload image to storage');
        return null;
      }

      logger.info({ filePath }, 'Uploaded recipe image to storage');
      return filePath;
    } catch (error) {
      logger.error({ error }, 'Failed to upload image to storage');
      return null;
    }
  }

  /**
   * Get the public URL for a storage path
   */
  getPublicUrl(storagePath: string): string {
    const { data } = supabaseAdmin.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    return data.publicUrl;
  }

  /**
   * Generate a unique filename from the recipe title
   */
  private generateFileName(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);

    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);

    return `${slug}-${timestamp}-${random}.png`;
  }

  /**
   * Delete an image from storage
   */
  async deleteFromStorage(storagePath: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .remove([storagePath]);

      if (error) {
        logger.error({ error, storagePath }, 'Failed to delete image from storage');
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ error, storagePath }, 'Failed to delete image from storage');
      return false;
    }
  }
}

export const imageService = new ImageService();
