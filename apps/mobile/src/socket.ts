import { io, Socket } from "socket.io-client";
import { envServerUrl, normalizeServerUrl } from "./config";

/**
 * Production default. A fresh install (or one whose app data was cleared)
 * connects here without any manual setup; the developer server screen can
 * still override it at runtime, and EXPO_PUBLIC_SERVER_URL still wins for
 * local builds.
 */
const PRODUCTION_URL = "https://skrible-server-production.up.railway.app";

const createSocket = (url: string): Socket =>
  io(url, {
    autoConnect: false,
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    // Exponential backoff with jitter: quick after a blip, gentle on battery
    // during a long outage instead of hammering the network.
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
    timeout: 10_000,
    // Connection-state recovery is negotiated by the server (v4.6+); the client
    // only needs to reconnect, then room:resync returns the authoritative state.
    auth: {},
  });

let currentUrl = envServerUrl() ?? PRODUCTION_URL;
// The production default always counts as configured, so a clean install can
// play immediately instead of being held on the emulator fallback.
let configured = true;
let lastToken: string | null = null;

/**
 * Reassigned when the address changes. ESM exports are live bindings, so
 * importers always read the current socket at call time.
 */
export let socket: Socket = createSocket(currentUrl);

export const getSocketUrl = () => currentUrl;

/** False when neither the build nor the user supplied an address. */
export const hasConfiguredServer = () => configured;

/**
 * Points the client at another server. Existing listeners are dropped with the
 * old socket; callers should also clear the room seat and account, because
 * tokens are scoped to the server that issued them.
 */
export const applyServerUrl = (raw: string): boolean => {
  const url = normalizeServerUrl(raw);
  if (!url) return false;
  configured = true;
  // No implicit connect here: screens decide when a connection is needed, so
  // launching the app never dials out before the user picks a room.
  if (url === currentUrl) return false;
  try {
    socket.disconnect();
  } catch {
    // The old socket may already be closed.
  }
  socket.removeAllListeners();
  currentUrl = url;
  socket = createSocket(url);
  setSocketToken(lastToken);
  return true;
};

/**
 * The bearer token is attached to every (re)connect handshake. Updating it here
 * also affects future reconnection attempts without recreating the socket.
 */
export const setSocketToken = (token: string | null | undefined) => {
  lastToken = token ?? null;
  socket.auth = token ? { token } : {};
};

/** Connects once and resolves when the socket is usable. */
export const connectSocket = (timeoutMs = 8000) =>
  new Promise<void>((resolve, reject) => {
    if (!configured) {
      reject(new Error("The game server is offline. Try again."));
      return;
    }
    if (socket.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Connection timed out. Check your connection and try again."));
    }, timeoutMs);
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };
    socket.on("connect", onConnect);
    socket.on("connect_error", onError);
    socket.connect();
  });
