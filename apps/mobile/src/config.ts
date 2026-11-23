import * as SecureStore from "expo-secure-store";

const SERVER_KEY = "skrible.server.url.v1";

/**
 * Accepts "192.168.1.10:3001", "http://host:3001/", "https://game.example.com"
 * and returns a canonical `scheme://host[:port]` with no path or trailing slash.
 * Anything with a path is rejected rather than silently truncated.
 */
export function normalizeServerUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const match = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[^/:?#\s]+)(?::(\d{1,5}))?$/i.exec(withScheme);
  if (!match) return null;
  const port = match[3] ? Number.parseInt(match[3], 10) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}${port ? `:${port}` : ""}`;
}

/** Build-time default. Runtime overrides live in SecureStore. */
export const envServerUrl = () => normalizeServerUrl(process.env.EXPO_PUBLIC_SERVER_URL);

export async function loadStoredServerUrl(): Promise<string | null> {
  try {
    return normalizeServerUrl(await SecureStore.getItemAsync(SERVER_KEY));
  } catch {
    return null;
  }
}

export async function saveServerUrl(url: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(SERVER_KEY, url);
  } catch {
    // Best-effort: the address still applies to this run.
  }
}

export async function clearServerUrl(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SERVER_KEY);
  } catch {
    // Ignore; nothing sensitive is left behind beyond a host name.
  }
}

/** True for addresses that only work on the developer's machine. */
export const isLoopbackUrl = (url: string) =>
  /^(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)(:|\/|$)/i.test(url);
