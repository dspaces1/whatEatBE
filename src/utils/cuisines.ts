export const CANONICAL_CUISINES = [
  'american',
  'mexican',
  'italian',
  'chinese',
  'japanese',
  'korean',
  'thai',
  'vietnamese',
  'indian',
  'mediterranean',
  'middle_eastern',
  'french',
  'caribbean',
  'soul_food',
] as const;

export type CanonicalCuisine = typeof CANONICAL_CUISINES[number];

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
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
};

const isExcludedAmerican = (value: string): boolean =>
  value.includes('latin american') || value.includes('south american');

const CUISINE_PATTERNS: Array<[RegExp, CanonicalCuisine]> = [
  [/soul\s*food/, 'soul_food'],
  [/middle\s*eastern|middle\s*east|levant/, 'middle_eastern'],
  [/mediterranean/, 'mediterranean'],
  [/mexican|tex\s*mex/, 'mexican'],
  [/italian/, 'italian'],
  [/chinese/, 'chinese'],
  [/japanese/, 'japanese'],
  [/korean/, 'korean'],
  [/thai/, 'thai'],
  [/vietnamese|vietnam/, 'vietnamese'],
  [/indian/, 'indian'],
  [/french/, 'french'],
  [/caribbean|jamaican|cuban|puerto\s*rican|haitian|trinidad|dominican|barbadian/, 'caribbean'],
  [/\bamerican\b|united\s*states|\busa\b|\bu\s*s\b/, 'american'],
];

export function normalizeCuisine(value: unknown): CanonicalCuisine | null {
  const candidates = splitToStrings(value);
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized || isExcludedAmerican(normalized)) {
      continue;
    }
    for (const [pattern, cuisine] of CUISINE_PATTERNS) {
      if (pattern.test(normalized)) {
        return cuisine;
      }
    }
  }
  return null;
}
