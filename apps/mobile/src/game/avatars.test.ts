import test from "node:test";
import assert from "node:assert/strict";
import {
  AVATAR_COLOR_COUNT,
  AVATAR_EYES_COUNT,
  AVATAR_MOUTH_COUNT,
  DEFAULT_AVATAR,
  avatarColor,
  cycleAvatar,
  encodeAvatar,
  isAvatarValue,
  normalizeAvatar,
  parseAvatar,
  randomAvatar,
} from "./avatars.js";

const assertValid = (value: string) => {
  const config = parseAvatar(value);
  assert.ok(config.color >= 0 && config.color < AVATAR_COLOR_COUNT);
  assert.ok(config.eyes >= 0 && config.eyes < AVATAR_EYES_COUNT);
  assert.ok(config.mouth >= 0 && config.mouth < AVATAR_MOUTH_COUNT);
  assert.match(value, /^c\d{1,2}_e\d{1,2}_m\d{1,2}$/);
};

test("compact avatars round-trip and stay inside the palette", () => {
  for (let color = 0; color < AVATAR_COLOR_COUNT; color += 1) {
    for (let eyes = 0; eyes < AVATAR_EYES_COUNT; eyes += 1) {
      for (let mouth = 0; mouth < AVATAR_MOUTH_COUNT; mouth += 1) {
        const encoded = encodeAvatar({ color, eyes, mouth });
        assertValid(encoded);
        assert.deepEqual(parseAvatar(encoded), { color, eyes, mouth });
        assert.equal(normalizeAvatar(encoded), encoded);
      }
    }
  }
});

test("legacy and unknown avatar ids map deterministically to valid characters", () => {
  for (const legacy of ["cat", "ghost", "robot", "alien", "frog", "bolt", "bear", "star", "coffee", "shades", "fox", "panda", "lion"]) {
    const first = normalizeAvatar(legacy);
    const second = normalizeAvatar(legacy);
    assert.equal(first, second);
    assertValid(first);
    assert.equal(isAvatarValue(legacy), true);
  }

  const unknown = normalizeAvatar("not-an-avatar");
  assert.equal(unknown, normalizeAvatar("not-an-avatar"));
  assertValid(unknown);
  assert.equal(isAvatarValue("not-an-avatar"), false);

  assert.equal(normalizeAvatar(null), DEFAULT_AVATAR);
  assert.equal(normalizeAvatar(undefined), DEFAULT_AVATAR);
  assertValid(DEFAULT_AVATAR);
  assert.equal(isAvatarValue(DEFAULT_AVATAR), true);
  assert.equal(typeof avatarColor(DEFAULT_AVATAR), "string");
});

test("cycling wraps and randomization produces a valid character", () => {
  const start = encodeAvatar({ color: 0, eyes: 0, mouth: 0 });
  assert.equal(cycleAvatar(start, "color", -1), encodeAvatar({ color: AVATAR_COLOR_COUNT - 1, eyes: 0, mouth: 0 }));
  assert.equal(cycleAvatar(start, "eyes", -1), encodeAvatar({ color: 0, eyes: AVATAR_EYES_COUNT - 1, mouth: 0 }));
  assert.equal(cycleAvatar(start, "mouth", -1), encodeAvatar({ color: 0, eyes: 0, mouth: AVATAR_MOUTH_COUNT - 1 }));

  for (let index = 0; index < 20; index += 1) {
    assertValid(randomAvatar());
  }
});
