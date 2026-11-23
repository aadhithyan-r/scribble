import type { ChatMessage } from "./types";

/**
 * Server messages are authoritative but can arrive twice (live event plus a
 * room snapshot), so merge by server-generated id and keep chronological order.
 */
export function mergeChat(
  existing: ChatMessage[],
  incoming: ChatMessage[],
  limit = 100,
): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ChatMessage>();
  for (const message of existing) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values())
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}
