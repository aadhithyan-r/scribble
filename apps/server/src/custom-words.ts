export const CUSTOM_WORDS_LIMIT = 100;
export const MIN_CUSTOM_PACK_WORDS = 3;

export type CustomWordsMode = "off" | "mix" | "only";
export const CUSTOM_WORDS_MODES: readonly CustomWordsMode[] = ["off", "mix", "only"];

const ALLOWED_WORD = /^[a-zA-Z0-9\s-]+$/;

/**
 * Hosts paste one free-form block, so commas and newlines are interchangeable.
 * Invalid entries are dropped rather than rejecting the whole pack.
 */
export function sanitizeCustomWords(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input.filter((entry): entry is string => typeof entry === "string").join("\n")
    : typeof input === "string"
      ? input
      : "";

  const words: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,\r\n]+/)) {
    const word = part.trim().replace(/\s+/g, " ");
    if (word.length < 2 || word.length > 28) continue;
    if (!ALLOWED_WORD.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length >= CUSTOM_WORDS_LIMIT) break;
  }

  return words;
}
