import { socket } from "./socket";
import type { AckResponse } from "./game/types";

/** Promise wrapper around Socket.IO acknowledgements with a mobile-safe timeout. */
export const request = (event: string, payload: unknown = {}): Promise<AckResponse> =>
  new Promise((resolve) => {
    // Failing fast beats a nine-second stall when the phone has no route to
    // the server (wrong Wi-Fi, server down, address not configured yet).
    if (!socket.connected) {
      resolve({
        ok: false,
        error: "Not connected to the game server. Tap retry to reconnect.",
      });
      return;
    }
    socket.timeout(9000).emit(event, payload, (error: Error | null, response: AckResponse) => {
      if (error) {
        resolve({ ok: false, error: "The server took too long to respond. Try again." });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from the server." });
    });
  });
