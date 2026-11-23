import * as SecureStore from "expo-secure-store";

export type Session = {
  code: string;
  token: string;
  name: string;
  /** Local timestamp used to expire a stale room session after abandonment. */
  savedAt: number;
};

export type SessionInput = Omit<Session, "savedAt">;

const SESSION_KEY = "skrible.room.session.v1";
/** The server holds empty/recovered rooms for six hours; older sessions are stale. */
const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

let current: Session | null = null;

const storageWrite = async (value: string | null): Promise<void> => {
  try {
    if (value === null) await SecureStore.deleteItemAsync(SESSION_KEY);
    else await SecureStore.setItemAsync(SESSION_KEY, value);
  } catch {
    // Session persistence is best-effort; in-memory recovery still works.
  }
};

export const getSession = () => current;

export const setSession = (session: SessionInput) => {
  current = { ...session, savedAt: Date.now() };
  void storageWrite(JSON.stringify(current));
};

export const clearSession = () => {
  current = null;
  void storageWrite(null);
};

const isSession = (value: unknown): value is Session => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    candidate.code.length === 5 &&
    typeof candidate.token === "string" &&
    candidate.token.length >= 8 &&
    typeof candidate.name === "string" &&
    typeof candidate.savedAt === "number"
  );
};

/**
 * Restores the seat token from the previous launch. A stale session is discarded
 * locally; the server would expire it anyway, and this avoids showing a doomed
 * "Resume" prompt days later.
 */
export const hydrateSession = async (): Promise<Session | null> => {
  if (current) return current;
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isSession(parsed) || Date.now() - parsed.savedAt > MAX_SESSION_AGE_MS) {
      void storageWrite(null);
      return null;
    }
    current = parsed;
    return current;
  } catch {
    return null;
  }
};
