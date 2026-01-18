import type { RecipeOwnership } from '../types/index.js';

export type RecipePayload<T extends { id: string | null }> = T & {
  ownership: RecipeOwnership;
  editable_recipe_id: string | null;
};

type OwnershipOptions = {
  isUserOwned: boolean;
  editableRecipeId?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
};

export const buildRecipeOwnership = (
  isUserOwned: boolean,
  options?: { canEdit?: boolean; canDelete?: boolean }
): RecipeOwnership => ({
  is_user_owned: isUserOwned,
  can_edit: options?.canEdit ?? isUserOwned,
  can_delete: options?.canDelete ?? isUserOwned,
});

export const withRecipeOwnership = <T extends { id: string | null }>(
  recipe: T,
  options: OwnershipOptions
): RecipePayload<T> => {
  const editableRecipeId =
    options.editableRecipeId !== undefined
      ? options.editableRecipeId
      : options.isUserOwned
        ? recipe.id
        : null;

  const canEdit = options.canEdit ?? (options.isUserOwned || Boolean(editableRecipeId));
  const canDelete = options.canDelete ?? (options.isUserOwned || Boolean(editableRecipeId));

  return {
    ...recipe,
    ownership: buildRecipeOwnership(options.isUserOwned, { canEdit, canDelete }),
    editable_recipe_id: editableRecipeId,
  };
};
