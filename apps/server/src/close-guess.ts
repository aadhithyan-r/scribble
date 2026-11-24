/** Lowercase, trim and collapse internal whitespace before comparing guesses. */
export const normalizeGuessText = (value: string) =>
  value.toLowerCase().trim().replace(/\s+/g, " ");

/** Standard edit distance over normalized lowercased, single-spaced strings. */
export function levenshteinDistance(a: string, b: string): number {
  const left = [...normalizeGuessText(a)];
  const right = [...normalizeGuessText(b)];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        substitution,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[right.length]!;
}

/**
 * A typo is only "close" when it cannot be mistaken for an unrelated word:
 * short words allow one edit, long words allow two, and a guess that matches
 * the secret once spaces are removed (`icecream` vs `ice cream`) always counts.
 */
export function isCloseGuess(guess: string, secret: string): boolean {
  const normalizedGuess = normalizeGuessText(guess);
  const normalizedSecret = normalizeGuessText(secret);
  const guessLetters = normalizedGuess.length;
  const secretLetters = normalizedSecret.length;

  // Very short words have no useful typo neighbourhood.
  if (guessLetters < 4 || secretLetters < 4) return false;
  if (normalizedGuess === normalizedSecret) return false;
  if (normalizedGuess.replace(/\s/g, "") === normalizedSecret.replace(/\s/g, "")) return true;

  const distance = levenshteinDistance(normalizedGuess, normalizedSecret);
  return secretLetters >= 7 ? distance <= 2 : distance === 1;
}
