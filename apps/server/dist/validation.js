/**
 * Shared input sanitisation for names, avatars, chat and custom word lists.
 * Kept dependency-free so the game model, profile store and socket layer can
 * all enforce the same rules.
 */
export class ValidationError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ValidationError";
        this.code = code;
    }
}
// Legacy ids stay accepted so accounts created before the composable pack keep
// working. New clients send `cN_eN_mN`, which fits the existing varchar(16)
// columns without a migration.
export const AVATARS = [
    "cat",
    "ghost",
    "robot",
    "alien",
    "frog",
    "bolt",
    "bear",
    "star",
    "coffee",
    "shades",
    "fox",
    "panda",
    "lion",
];
export const DEFAULT_AVATAR = "fox";
const AVATAR_COLOR_COUNT = 12;
const AVATAR_EYES_COUNT = 11;
const AVATAR_MOUTH_COUNT = 10;
const COMPACT_AVATAR = /^c(\d{1,2})_e(\d{1,2})_m(\d{1,2})$/;
export const isLegacyAvatar = (value) => typeof value === "string" && AVATARS.includes(value.trim().toLowerCase());
export const isSerializedAvatar = (value) => {
    if (typeof value !== "string")
        return false;
    const match = COMPACT_AVATAR.exec(value.trim().toLowerCase());
    if (!match)
        return false;
    return (Number(match[1]) < AVATAR_COLOR_COUNT &&
        Number(match[2]) < AVATAR_EYES_COUNT &&
        Number(match[3]) < AVATAR_MOUTH_COUNT);
};
export const isAvatar = (value) => isLegacyAvatar(value) || isSerializedAvatar(value);
export const resolveAvatar = (value) => {
    if (typeof value !== "string")
        return DEFAULT_AVATAR;
    const raw = value.trim().toLowerCase();
    if (isSerializedAvatar(raw)) {
        const match = COMPACT_AVATAR.exec(raw);
        return `c${Number(match[1])}_e${Number(match[2])}_m${Number(match[3])}`;
    }
    if (AVATARS.includes(raw))
        return raw;
    return DEFAULT_AVATAR;
};
/**
 * Starter blocklist, intentionally small and non-exhaustive. It is applied to
 * display names, chat (masked) and custom words (rejected). A production build
 * should swap this for a maintained moderation service.
 */
const BLOCKED_WORDS = [
    "damn",
    "crap",
    "idiot",
    "stupid",
    "hate",
    "kill",
    "porn",
    "sex",
    "nazi",
    "fuck",
    "shit",
    "bitch",
    "asshole",
    "dick",
    "slut",
    "rape",
    "bastard",
    "whore",
];
const tokens = (value) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
export const containsProfanity = (value) => {
    const words = tokens(value);
    return words.some((word) => BLOCKED_WORDS.includes(word));
};
/** Masks blocked tokens in chat instead of dropping the whole message. */
export const maskProfanity = (value) => value.replace(/[A-Za-z0-9']+/g, (word) => {
    if (!containsProfanity(word))
        return word;
    return word[0] + "*".repeat(Math.max(1, word.length - 1));
});
export function sanitizeName(raw) {
    return (raw
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 18) || "Player");
}
export function validateName(raw) {
    const name = sanitizeName(raw);
    if (containsProfanity(name)) {
        throw new ValidationError("INVALID_NAME", "Please choose a friendlier name");
    }
    return name;
}
const MAX_CATEGORIES = 8;
const MAX_WORDS_PER_CATEGORY = 40;
const MAX_TOTAL_WORDS = 120;
const WORD_PATTERN = /^[A-Za-z][A-Za-z '\-]*$/;
const CATEGORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 &'\-]*$/;
const collapse = (value) => value.replace(/\s+/g, " ").trim();
/**
 * Validates a host-authored word list. Rejects markup, digits/URLs, profanity,
 * duplicates and oversized lists rather than silently trimming.
 */
export function validateCategories(input) {
    if (!Array.isArray(input)) {
        throw new ValidationError("INVALID_WORDS", "Word lists must be an array");
    }
    if (input.length > MAX_CATEGORIES) {
        throw new ValidationError("INVALID_WORDS", `Use at most ${MAX_CATEGORIES} categories`);
    }
    const seen = new Set();
    let total = 0;
    const categories = [];
    for (const rawCategory of input) {
        if (!rawCategory || typeof rawCategory !== "object") {
            throw new ValidationError("INVALID_WORDS", "Each category needs a name and words");
        }
        const { name, words } = rawCategory;
        if (typeof name !== "string") {
            throw new ValidationError("INVALID_WORDS", "Each category needs a name");
        }
        const cleanName = collapse(name);
        if (cleanName.length < 1 || cleanName.length > 24 || !CATEGORY_PATTERN.test(cleanName)) {
            throw new ValidationError("INVALID_WORDS", "Category names must be 1–24 letters or numbers");
        }
        if (containsProfanity(cleanName)) {
            throw new ValidationError("INVALID_WORDS", "Category names must be friendly");
        }
        if (!Array.isArray(words)) {
            throw new ValidationError("INVALID_WORDS", "Category words must be an array");
        }
        if (words.length > MAX_WORDS_PER_CATEGORY) {
            throw new ValidationError("INVALID_WORDS", `Use at most ${MAX_WORDS_PER_CATEGORY} words per category`);
        }
        const cleanWords = [];
        for (const rawWord of words) {
            if (typeof rawWord !== "string") {
                throw new ValidationError("INVALID_WORDS", "Words must be text");
            }
            const word = collapse(rawWord);
            if (word.length < 2 || word.length > 24 || !WORD_PATTERN.test(word)) {
                throw new ValidationError("INVALID_WORDS", `"${word.slice(0, 24)}" must be 2–24 letters (spaces, hyphens and apostrophes allowed)`);
            }
            if (containsProfanity(word)) {
                throw new ValidationError("INVALID_WORDS", "Custom words must be friendly");
            }
            const key = word.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            total += 1;
            if (total > MAX_TOTAL_WORDS) {
                throw new ValidationError("INVALID_WORDS", `Use at most ${MAX_TOTAL_WORDS} words`);
            }
            cleanWords.push(word);
        }
        categories.push({ name: cleanName, words: cleanWords });
    }
    return categories;
}
export const customWordCount = (categories) => categories.reduce((sum, category) => sum + category.words.length, 0);
