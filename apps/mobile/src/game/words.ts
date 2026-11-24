/** Client-side metadata for the server-owned curated word dictionary. */
export const WORD_CATEGORIES = [
  { id: "animals", label: "ANIMALS", count: 45 },
  { id: "food", label: "FOOD & DRINKS", count: 45 },
  { id: "objects", label: "OBJECTS & TECH", count: 45 },
  { id: "places", label: "PLACES & NATURE", count: 45 },
  { id: "actions", label: "ACTIONS & SPORTS", count: 45 },
] as const;

export type WordCategoryId = (typeof WORD_CATEGORIES)[number]["id"];
export type WordMode = "random" | "category";

export const TOTAL_CURATED_WORDS = WORD_CATEGORIES.reduce(
  (total, category) => total + category.count,
  0,
);

export const wordCategoryLabel = (id: string | null | undefined) =>
  WORD_CATEGORIES.find((category) => category.id === id)?.label ?? "CATEGORY";

/** Mirrors the server sanitizer so the lobby counter matches what will be sent. */
export function parseCustomWords(input: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(/[,\r\n]+/)) {
    const word = part.trim().replace(/\s+/g, " ");
    if (word.length < 2 || word.length > 28) continue;
    if (!/^[a-zA-Z0-9\s-]+$/.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length >= 100) break;
  }
  return words;
}
