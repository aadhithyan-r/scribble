import * as SecureStore from "expo-secure-store";
import type { Profile } from "./game/types";
import {
  clearIdentity,
  getIdentity,
  identityFromProfile,
  setIdentity,
  type Identity,
} from "./profile";
import { request } from "./request";
import { connectSocket, setSocketToken } from "./socket";

const AUTH_KEY = "skrible.auth.session.v1";
const REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

type StoredIdentity = Identity & { version: 1 };

const storageRead = async (): Promise<string | null> => {
  try {
    return await SecureStore.getItemAsync(AUTH_KEY);
  } catch {
    // SecureStore is unavailable on web/older runtimes; the app still works for
    // this run, it just cannot remember the account across launches.
    return null;
  }
};

const storageWrite = async (value: string | null): Promise<void> => {
  try {
    if (value === null) await SecureStore.deleteItemAsync(AUTH_KEY);
    else await SecureStore.setItemAsync(AUTH_KEY, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED });
  } catch {
    // Persistence is best-effort; never lose the in-memory session over it.
  }
};

const isStoredIdentity = (value: unknown): value is StoredIdentity => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.token === "string" &&
    candidate.token.length >= 16 &&
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.avatar === "string"
  );
};

const remember = (identity: Identity) => {
  setIdentity(identity);
  setSocketToken(identity.token);
  void storageWrite(JSON.stringify({ ...identity, version: 1 }));
};

/** Loads the saved account into memory and attaches it to the socket handshake. */
let hydratePromise: Promise<Identity | null> | null = null;
export const hydrateIdentity = (): Promise<Identity | null> => {
  hydratePromise ??= (async () => {
    const raw = await storageRead();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredIdentity(parsed)) {
        void storageWrite(null);
        return null;
      }
      const identity: Identity = {
        token: parsed.token,
        id: parsed.id,
        name: parsed.name,
        avatar: parsed.avatar,
        ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
      };
      setIdentity(identity);
      setSocketToken(identity.token);
      return identity;
    } catch {
      void storageWrite(null);
      return null;
    }
  })();
  return hydratePromise;
};

/** Updates the locally stored name/avatar after a successful profile update. */
export const rememberProfile = (profile: Profile): Identity | null => {
  const current = getIdentity();
  if (!current) return null;
  const next: Identity = {
    ...current,
    id: profile.id,
    name: profile.name,
    avatar: profile.avatar,
  };
  remember(next);
  return next;
};

export const forgetIdentity = (): void => {
  clearIdentity();
  setSocketToken(null);
  void storageWrite(null);
};

let ensuring: Promise<Identity> | null = null;

/**
 * Guarantees this socket has a persistent account. A saved token is restored
 * first; only an explicitly invalid/revoked token is replaced with a new guest,
 * so a temporary network failure never destroys the account.
 */
export const ensureIdentity = (name: string, avatar: string): Promise<Identity> => {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    await hydrateIdentity();

    const current = getIdentity();
    if (current?.token) {
      setSocketToken(current.token);
      try {
        await connectSocket();
      } catch (error) {
        // An expired/revoked handshake token is rejected before any event can
        // run. Reconnect anonymously so restore can report it and a new guest
        // can be created instead of locking the user out.
        if (!(error instanceof Error) || error.message !== "AUTH_INVALID") throw error;
        setSocketToken(null);
        await connectSocket();
      }

      const restored = await request("auth:restore", { token: current.token });
      if (restored.ok && restored.profile) {
        let identity = identityFromProfile(restored.profile, current.token);
        identity = { ...identity, ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}) };
        remember(identity);

        // Rotate quietly before expiry. A failed refresh is not fatal; the
        // current token remains valid until its real expiry.
        if (
          current.expiresAt !== undefined &&
          current.expiresAt - Date.now() < REFRESH_AHEAD_MS
        ) {
          const refreshed = await request("auth:refresh", { token: current.token });
          if (refreshed.ok && refreshed.token && refreshed.profile) {
            identity = {
              ...identityFromProfile(refreshed.profile, refreshed.token),
              ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
            };
            remember(identity);
          }
        }
        return identity;
      }

      // The server rejected this token (expired/revoked/deleted account). Do
      // not reuse its profile id; start a fresh guest below.
      forgetIdentity();
    } else {
      setSocketToken(null);
      await connectSocket();
    }

    const created = await request("auth:guest", { name, avatar });
    if (!created.ok || !created.profile || !created.token) {
      throw new Error(created.error ?? "Could not start a guest session.");
    }
    const identity: Identity = {
      ...identityFromProfile(created.profile, created.token),
      ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
    };
    remember(identity);
    return identity;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
};

export const logout = async (): Promise<void> => {
  const identity = getIdentity();
  try {
    await request("auth:logout", identity ? { token: identity.token } : {});
  } finally {
    forgetIdentity();
  }
};

export const deleteAccount = async (): Promise<void> => {
  const response = await request("auth:delete", {});
  if (!response.ok) throw new Error(response.error ?? "Could not delete your account.");
  forgetIdentity();
};
