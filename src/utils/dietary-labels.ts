export const CANONICAL_DIETARY_LABELS = [
  'vegan',
  'vegetarian',
  'gluten_free',
  'dairy_free',
  'nut_free',
  'shellfish_free',
  'keto_friendly',
  'high_protein',
] as const;

export type CanonicalDietaryLabel = typeof CANONICAL_DIETARY_LABELS[number];

const NEGATED_PATTERNS = [
  'non veg',
  'non-veg',
  'nonveg',
  'non vegetarian',
  'non-vegetarian',
  'nonvegetarian',
  'not vegetarian',
  'non vegan',
  'non-vegan',
  'nonvegan',
  'not vegan',
];

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
    .replace(/^https?:\/\/(www\.)?schema\.org\//i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\bdiet\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const containsNegation = (value: string): boolean =>
  NEGATED_PATTERNS.some((pattern) => value.includes(pattern));

export function normalizeDietaryLabel(value: string): CanonicalDietaryLabel | null {
  const normalized = normalizeCandidate(value);
  if (!normalized) return null;
  if (containsNegation(normalized)) return null;

  if (normalized.includes('vegan')) return 'vegan';
  if (normalized.includes('vegetarian')) return 'vegetarian';

  if (normalized.includes('gluten') && normalized.includes('free')) return 'gluten_free';
  if (normalized.includes('glutenfree')) return 'gluten_free';

  if (normalized.includes('dairy') && normalized.includes('free')) return 'dairy_free';
  if (normalized.includes('dairyfree')) return 'dairy_free';
  if (normalized.includes('lactose') && normalized.includes('free')) return 'dairy_free';
  if (normalized.includes('nondairy') || normalized.includes('non dairy')) return 'dairy_free';

  if (normalized.includes('nut') && normalized.includes('free')) return 'nut_free';
  if (normalized.includes('nutfree')) return 'nut_free';
  if (normalized.includes('tree nut free') || normalized.includes('peanut free')) return 'nut_free';

  if (normalized.includes('shellfish') && normalized.includes('free')) return 'shellfish_free';
  if (normalized.includes('shellfishfree')) return 'shellfish_free';
  if (normalized.includes('no shellfish')) return 'shellfish_free';

  if (normalized.includes('keto') || normalized.includes('ketogenic')) return 'keto_friendly';

  if (normalized.includes('high protein')) return 'high_protein';
  if (normalized.includes('highprotein')) return 'high_protein';
  if (normalized.includes('protein rich')) return 'high_protein';

  return null;
}

export function normalizeDietaryLabels(value: unknown): CanonicalDietaryLabel[] {
  const labels = new Set<CanonicalDietaryLabel>();
  for (const item of splitToStrings(value)) {
    const normalized = normalizeDietaryLabel(item);
    if (normalized) {
      labels.add(normalized);
    }
  }
  return CANONICAL_DIETARY_LABELS.filter((label) => labels.has(label));
}
