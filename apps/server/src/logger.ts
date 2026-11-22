import pino, { type Logger } from "pino";

export type { Logger };

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "token",
  "*.token",
  "profileToken",
  "sessionToken",
  "*.sessionToken",
  "accessToken",
  "*.accessToken",
  "password",
  "*.password",
  "headers.authorization",
];

/**
 * Structured JSON logging. Token-bearing fields are redacted so a log shipper
 * cannot become a credential store.
 */
export function createLogger(level = "info"): Logger {
  return pino({
    level,
    base: { service: "skrible-server" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const silentLogger: Logger = pino({ level: "silent" });
