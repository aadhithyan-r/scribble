/**
 * Composable skribbl-style avatars.
 *
 * The wire format is a compact, storage-friendly string such as `c3_e1_m4`.
 * It fits the existing `varchar(16)` avatar columns, so no server migration is
 * needed. Legacy ids from earlier builds are mapped deterministically to a
 * color/eyes/mouth combination when they are read.
 */

export type AvatarId = string;

export type AvatarConfig = {
  color: number;
  eyes: number;
  mouth: number;
};

export type AvatarLayer = keyof AvatarConfig;

export const AVATAR_COLORS = [
  { id: "c0", label: "Red", value: "#FF3B30" },
  { id: "c1", label: "Orange", value: "#FF8C00" },
  { id: "c2", label: "Yellow", value: "#FFD600" },
  { id: "c3", label: "Lime", value: "#38D947" },
  { id: "c4", label: "Cyan", value: "#00E5FF" },
  { id: "c5", label: "Blue", value: "#3B5BFF" },
  { id: "c6", label: "Purple", value: "#9B30FF" },
  { id: "c7", label: "Pink", value: "#FF4D8D" },
  { id: "c8", label: "Coral", value: "#FF6B6B" },
  { id: "c9", label: "Mint", value: "#5CE1E6" },
  { id: "c10", label: "White", value: "#FFFFFF" },
  { id: "c11", label: "Charcoal", value: "#444444" },
] as const;

export const AVATAR_EYES = [
  { id: "e0", label: "Normal" },
  { id: "e1", label: "Happy" },
  { id: "e2", label: "Derpy" },
  { id: "e3", label: "Sunglasses" },
  { id: "e4", label: "Eyepatch" },
  { id: "e5", label: "Cyclops" },
  { id: "e6", label: "Angry" },
  { id: "e7", label: "Unibrow" },
  { id: "e8", label: "Star eyes" },
  { id: "e9", label: "Sleepy" },
  { id: "e10", label: "Wink" },
] as const;

export const AVATAR_MOUTHS = [
  { id: "m0", label: "Smirk" },
  { id: "m1", label: "Big grin" },
  { id: "m2", label: "Buck teeth" },
  { id: "m3", label: "Surprised" },
  { id: "m4", label: "Wavy" },
  { id: "m5", label: "Frown" },
  { id: "m6", label: "Flat" },
  { id: "m7", label: "Tongue out" },
  { id: "m8", label: "Cat" },
  { id: "m9", label: "Mustache" },
] as const;

export const AVATAR_COLOR_COUNT = AVATAR_COLORS.length;
export const AVATAR_EYES_COUNT = AVATAR_EYES.length;
export const AVATAR_MOUTH_COUNT = AVATAR_MOUTHS.length;

const FALLBACK_CONFIG: AvatarConfig = { color: 1, eyes: 0, mouth: 0 };
export const DEFAULT_AVATAR = "c1_e0_m0";

/** Old ids from the first vector pack, kept readable for existing accounts. */
const LEGACY_CONFIGS: Record<string, AvatarConfig> = {
  cat: { color: 2, eyes: 0, mouth: 8 },
  ghost: { color: 10, eyes: 9, mouth: 6 },
  robot: { color: 4, eyes: 3, mouth: 6 },
  alien: { color: 3, eyes: 5, mouth: 4 },
  frog: { color: 3, eyes: 1, mouth: 1 },
  bolt: { color: 1, eyes: 6, mouth: 7 },
  bear: { color: 8, eyes: 0, mouth: 1 },
  star: { color: 2, eyes: 8, mouth: 7 },
  coffee: { color: 11, eyes: 9, mouth: 0 },
  shades: { color: 7, eyes: 3, mouth: 0 },
  fox: { color: 1, eyes: 0, mouth: 0 },
  panda: { color: 10, eyes: 8, mouth: 1 },
  lion: { color: 1, eyes: 6, mouth: 9 },
};

const COMPACT_PATTERN = /^c(\d{1,2})_e(\d{1,2})_m(\d{1,2})$/;

const wrapIndex = (value: number, count: number) => ((value % count) + count) % count;

/** Deterministic fallback for an unknown legacy string. */
const hashConfig = (raw: string): AvatarConfig => {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  }
  const unsigned = hash >>> 0;
  return {
    color: unsigned % AVATAR_COLOR_COUNT,
    eyes: Math.floor(unsigned / AVATAR_COLOR_COUNT) % AVATAR_EYES_COUNT,
    mouth: Math.floor(unsigned / (AVATAR_COLOR_COUNT * AVATAR_EYES_COUNT)) % AVATAR_MOUTH_COUNT,
  };
};

export const encodeAvatar = (config: AvatarConfig): AvatarId =>
  `c${wrapIndex(config.color, AVATAR_COLOR_COUNT)}_e${wrapIndex(config.eyes, AVATAR_EYES_COUNT)}_m${wrapIndex(config.mouth, AVATAR_MOUTH_COUNT)}`;

/** Always returns a valid config, including for null, legacy and garbage input. */
export const parseAvatar = (value?: string | null): AvatarConfig => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = raw ? COMPACT_PATTERN.exec(raw) : null;
  if (match) {
    return {
      color: wrapIndex(Number(match[1]), AVATAR_COLOR_COUNT),
      eyes: wrapIndex(Number(match[2]), AVATAR_EYES_COUNT),
      mouth: wrapIndex(Number(match[3]), AVATAR_MOUTH_COUNT),
    };
  }
  const legacy = raw ? LEGACY_CONFIGS[raw] : undefined;
  if (legacy) return { ...legacy };
  if (raw) return hashConfig(raw);
  return { ...FALLBACK_CONFIG };
};

export const normalizeAvatar = (value?: string | null): AvatarId => encodeAvatar(parseAvatar(value));

export const isAvatarValue = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const raw = value.trim().toLowerCase();
  return COMPACT_PATTERN.test(raw) || raw in LEGACY_CONFIGS;
};

export const avatarColor = (value?: string | null) =>
  AVATAR_COLORS[parseAvatar(value).color].value;

export const avatarLabel = (value?: string | null) => {
  const config = parseAvatar(value);
  return `${AVATAR_COLORS[config.color].label} / ${AVATAR_EYES[config.eyes].label} / ${AVATAR_MOUTHS[config.mouth].label}`;
};

export const cycleAvatar = (value: string | null | undefined, layer: AvatarLayer, delta: number) => {
  const config = parseAvatar(value);
  const count =
    layer === "color"
      ? AVATAR_COLOR_COUNT
      : layer === "eyes"
        ? AVATAR_EYES_COUNT
        : AVATAR_MOUTH_COUNT;
  return encodeAvatar({ ...config, [layer]: wrapIndex(config[layer] + delta, count) });
};

export const randomAvatar = () =>
  encodeAvatar({
    color: Math.floor(Math.random() * AVATAR_COLOR_COUNT),
    eyes: Math.floor(Math.random() * AVATAR_EYES_COUNT),
    mouth: Math.floor(Math.random() * AVATAR_MOUTH_COUNT),
  });
