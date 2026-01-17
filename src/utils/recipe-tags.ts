export const CANONICAL_RECIPE_TAGS = [
  'breakfast',
  'meal',
  'dessert',
  'snack',
] as const;

export type CanonicalRecipeTag = typeof CANONICAL_RECIPE_TAGS[number];

const splitToStrings = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitToStrings(item));
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeCandidate = (value: string): string => {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[/_-]+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
};

const TAG_PATTERNS: Array<[RegExp, CanonicalRecipeTag]> = [
  [/breakfast|brunch|morning/, 'breakfast'],
  [/dessert|sweet|treat/, 'dessert'],
  [/snack|appetizer|starter/, 'snack'],
  [/lunch|dinner|supper|entree|main\s*course|main|meal/, 'meal'],
];

export function normalizeRecipeTags(value: unknown): CanonicalRecipeTag[] {
  const tags = new Set<CanonicalRecipeTag>();
  for (const item of splitToStrings(value)) {
    const normalized = normalizeCandidate(item);
    if (!normalized) {
      continue;
    }
    for (const [pattern, tag] of TAG_PATTERNS) {
      if (pattern.test(normalized)) {
        tags.add(tag);
        break;
      }
    }
  }
  return CANONICAL_RECIPE_TAGS.filter((tag) => tags.has(tag));
}
