import test from "node:test";
import assert from "node:assert/strict";
import {
  containsProfanity,
  customWordCount,
  maskProfanity,
  resolveAvatar,
  sanitizeName,
  validateCategories,
  validateName,
  ValidationError,
} from "./validation.js";

const expectValidation = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, code);
    return true;
  });
};

test("names are sanitised, capped and screened", () => {
  assert.equal(sanitizeName("  <b>Ada</b>  "), "bAda/b");
  assert.equal(sanitizeName(""), "Player");
  assert.equal(validateName("Ada Lovelace"), "Ada Lovelace");
  expectValidation(() => validateName("you idiot"), "INVALID_NAME");
  assert.equal(containsProfanity("classic literature"), false);
  assert.equal(maskProfanity("this is shit"), "this is s***");
});

test("avatars accept legacy ids and composable strings", () => {
  assert.equal(resolveAvatar("panda"), "panda");
  assert.equal(resolveAvatar("c3_e1_m4"), "c3_e1_m4");
  assert.equal(resolveAvatar("c11_e10_m9"), "c11_e10_m9");
  assert.equal(resolveAvatar("C03_E01_M04"), "c3_e1_m4");
  assert.equal(resolveAvatar("c99_e0_m0"), "fox");
  assert.equal(resolveAvatar("not-an-avatar"), "fox");
  assert.equal(resolveAvatar(undefined), "fox");
});

test("custom categories enforce shape, length and content rules", () => {
  const categories = validateCategories([
    { name: "Food", words: ["pizza", "sushi", "pizza", "ice cream"] },
    { name: "Places", words: ["Eiffel Tower", "beach-house"] },
  ]);
  assert.equal(categories.length, 2);
  assert.deepEqual(categories[0]!.words, ["pizza", "sushi", "ice cream"]);
  assert.equal(customWordCount(categories), 5);

  expectValidation(() => validateCategories("nope"), "INVALID_WORDS");
  expectValidation(() => validateCategories([{ name: "", words: [] }]), "INVALID_WORDS");
  expectValidation(() => validateCategories([{ name: "Bad", words: ["a"] }]), "INVALID_WORDS");
  expectValidation(() => validateCategories([{ name: "Bad", words: ["hello1"] }]), "INVALID_WORDS");
  expectValidation(() => validateCategories([{ name: "Bad", words: ["<script>"] }]), "INVALID_WORDS");
  expectValidation(() => validateCategories([{ name: "Bad", words: ["fuck"] }]), "INVALID_WORDS");
  expectValidation(
    () => validateCategories(Array.from({ length: 9 }, (_, i) => ({ name: `C${i}`, words: [] }))),
    "INVALID_WORDS",
  );
  expectValidation(
    () =>
      validateCategories([
        { name: "Too many", words: Array.from({ length: 41 }, (_, i) => `word${String.fromCharCode(97 + i)}`) },
      ]),
    "INVALID_WORDS",
  );
});
