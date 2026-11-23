import * as SecureStore from "expo-secure-store";
import { isAvatarValue, normalizeAvatar } from "./game/avatars";

const AVATAR_KEY = "skrible.avatar.pref.v1";

/** Remembers the avatar picked on Home before an account exists. */
export async function loadAvatarPref(): Promise<string | null> {
  try {
    const value = await SecureStore.getItemAsync(AVATAR_KEY);
    return isAvatarValue(value) ? normalizeAvatar(value) : null;
  } catch {
    return null;
  }
}

export async function saveAvatarPref(value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AVATAR_KEY, normalizeAvatar(value));
  } catch {
    // Best-effort: the pick still applies for this run.
  }
}
