import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { dbToEnvelope, type RecipeEnvelope } from '../schemas/envelope.js';
import type { RecipeShare, Recipe, RecipeIngredient, RecipeStep, RecipeMedia } from '../types/index.js';

export class ShareService {
  /**
   * Generate a URL-safe share token
   */
  private generateToken(length: number = 12): string {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
  }

  /**
   * Create a share link for a recipe
   */
  async createShareLink(
    recipeId: string,
    userId: string,
    expiresInDays?: number
  ): Promise<RecipeShare | null> {
    try {
      // Verify user owns the recipe
      const { data: recipe, error: recipeError } = await supabaseAdmin
        .from('recipes')
        .select('id, user_id')
        .eq('id', recipeId)
        .single();

      if (recipeError || !recipe) {
        logger.warn({ recipeId }, 'Recipe not found for sharing');
        return null;
      }

      if (recipe.user_id !== userId) {
        logger.warn({ recipeId, userId }, 'User does not own recipe');
        return null;
      }

      // Check if a share already exists
      const { data: existingShare } = await supabaseAdmin
        .from('recipe_shares')
        .select('*')
        .eq('recipe_id', recipeId)
        .eq('created_by', userId)
        .single();

      if (existingShare) {
        // Return existing share
        return existingShare as RecipeShare;
      }

      // Generate new share token
      const shareToken = this.generateToken();
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const { data: share, error: shareError } = await supabaseAdmin
        .from('recipe_shares')
        .insert({
          recipe_id: recipeId,
          share_token: shareToken,
          created_by: userId,
          expires_at: expiresAt,
        })
        .select()
        .single();

      if (shareError || !share) {
        logger.error({ shareError }, 'Failed to create share link');
        return null;
      }

      logger.info({ recipeId, shareToken }, 'Created share link');
      return share as RecipeShare;
    } catch (error) {
      logger.error({ error, recipeId }, 'Error creating share link');
      return null;
    }
  }

  /**
   * Get a shared recipe by token (public access)
   */
  async getSharedRecipe(token: string): Promise<RecipeEnvelope | null> {
    try {
      // Find share by token
      const { data: share, error: shareError } = await supabaseAdmin
        .from('recipe_shares')
        .select('*')
        .eq('share_token', token)
        .single();

      if (shareError || !share) {
        logger.warn({ token }, 'Share token not found');
        return null;
      }

      // Check expiration
      if (share.expires_at && new Date(share.expires_at) < new Date()) {
        logger.warn({ token }, 'Share token expired');
        return null;
      }

      // Get the recipe
      const { data: recipe, error: recipeError } = await supabaseAdmin
        .from('recipes')
        .select('*')
        .eq('id', share.recipe_id)
        .is('deleted_at', null)
        .single();

      if (recipeError || !recipe) {
        logger.warn({ recipeId: share.recipe_id }, 'Shared recipe not found');
        return null;
      }

      // Get ingredients, steps, media
      const [
        { data: ingredients },
        { data: steps },
        { data: media },
      ] = await Promise.all([
        supabaseAdmin
          .from('recipe_ingredients')
          .select('*')
          .eq('recipe_id', recipe.id)
          .order('position'),
        supabaseAdmin
          .from('recipe_steps')
          .select('*')
          .eq('recipe_id', recipe.id)
          .order('position'),
        supabaseAdmin
          .from('recipe_media')
          .select('*')
          .eq('recipe_id', recipe.id)
          .order('position'),
      ]);

      // Increment view count (fire and forget)
      supabaseAdmin
        .from('recipe_shares')
        .update({ view_count: (share.view_count || 0) + 1 })
        .eq('id', share.id)
        .then(() => {});

      // Convert to envelope format
      return dbToEnvelope(
        recipe as Recipe,
        (ingredients ?? []) as RecipeIngredient[],
        (steps ?? []) as RecipeStep[],
        (media ?? []) as RecipeMedia[]
      );
    } catch (error) {
      logger.error({ error, token }, 'Error getting shared recipe');
      return null;
    }
  }

  /**
   * Revoke a share link
   */
  async revokeShare(shareId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('recipe_shares')
        .delete()
        .eq('id', shareId)
        .eq('created_by', userId);

      if (error) {
        logger.error({ error, shareId }, 'Failed to revoke share');
        return false;
      }

      logger.info({ shareId }, 'Revoked share link');
      return true;
    } catch (error) {
      logger.error({ error, shareId }, 'Error revoking share');
      return false;
    }
  }

  /**
   * Get all shares for a recipe
   */
  async getSharesForRecipe(recipeId: string, userId: string): Promise<RecipeShare[]> {
    try {
      const { data: shares, error } = await supabaseAdmin
        .from('recipe_shares')
        .select('*')
        .eq('recipe_id', recipeId)
        .eq('created_by', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error({ error, recipeId }, 'Failed to get shares');
        return [];
      }

      return (shares ?? []) as RecipeShare[];
    } catch (error) {
      logger.error({ error, recipeId }, 'Error getting shares');
      return [];
    }
  }

  /**
   * Get share statistics
   */
  async getShareStats(shareId: string, userId: string): Promise<RecipeShare | null> {
    try {
      const { data: share, error } = await supabaseAdmin
        .from('recipe_shares')
        .select('*')
        .eq('id', shareId)
        .eq('created_by', userId)
        .single();

      if (error || !share) {
        return null;
      }

      return share as RecipeShare;
    } catch (error) {
      logger.error({ error, shareId }, 'Error getting share stats');
      return null;
    }
  }
}

export const shareService = new ShareService();
