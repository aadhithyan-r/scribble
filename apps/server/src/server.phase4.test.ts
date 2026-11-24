import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createGameServer, type GameServerOptions } from "./server.js";

type Resp = {
  ok: boolean;
  error?: string;
  code?: string;
  room?: any;
  sessionToken?: string;
  profile?: any;
  profileToken?: string;
  inviteToken?: string;
  deepLink?: string;
  categories?: any[];
  rows?: any[];
  match?: any;
  reports?: any[];
  [key: string]: any;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(t: any, options: GameServerOptions = {}) {
  const server = createGameServer(options);
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });
  return { server, url, sockets };
}

async function client(url: string, sockets: Socket[]) {
  const socket = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket connect timed out")), 5000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  sockets.push(socket);
  return socket;
}

function call(socket: Socket, event: string, payload: unknown = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error: Error | null, response: Resp) => {
      if (error) reject(new Error(`${event} ack timed out`));
      else resolve(response);
    });
  });
}

function waitFor<T = any>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5000);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

test("concurrent quick-play enqueues form one full room and start it", async (t) => {
  const { server, url, sockets } = await boot(t, {
    matchmaking: { minPlayers: 3, maxPlayers: 3, waitMs: 5000 },
  });
  const a = await client(url, sockets);
  const b = await client(url, sockets);
  const c = await client(url, sockets);

  const matched = [a, b, c].map((socket) => waitFor<any>(socket, "mm:matched"));
  const acks = await Promise.all([
    call(a, "mm:enqueue", { name: "Ada" }),
    call(b, "mm:enqueue", { name: "Bo" }),
    call(c, "mm:enqueue", { name: "Cy" }),
  ]);
  assert.equal(acks.every((ack) => ack.ok), true);
  assert.equal(acks.every((ack) => ack.profileToken), true);

  const results = await Promise.all(matched);
  const codes = new Set(results.map((result) => result.roomCode));
  assert.equal(codes.size, 1);
  const room = results[0].room;
  assert.equal(room.players.length, 3);
  assert.equal(room.status, "choosing");
  assert.equal(room.visibility, "public");
  assert.equal(new Set(room.players.map((player: any) => player.profileId)).size, 3);
  assert.equal(new Set(results.map((result) => result.sessionToken)).size, 3);
  assert.equal(results.filter((result) => result.room.isDrawer).length, 1);
  assert.equal(server.matchmaker.size, 0);
});

test("queue cancellation and waiting timeout both release players", async (t) => {
  const { server, url, sockets } = await boot(t, {
    matchmaking: { minPlayers: 2, maxPlayers: 4, waitMs: 1000 },
  });
  const a = await client(url, sockets);
  const b = await client(url, sockets);

  assert.equal((await call(a, "mm:enqueue", { name: "Ada" })).ok, true);
  const cancelled = await call(a, "mm:cancel");
  assert.equal(cancelled.removed, true);
  assert.equal(server.matchmaker.size, 0);

  // Two cancelled players must never produce a match.
  let matched = 0;
  a.on("mm:matched", () => (matched += 1));
  assert.equal((await call(a, "mm:enqueue", { name: "Ada" })).ok, true);
  assert.equal((await call(a, "mm:cancel")).removed, true);
  await wait(200);
  assert.equal(matched, 0);

  // A lone player is timed out instead of waiting forever.
  const timeout = waitFor<any>(b, "mm:timeout");
  assert.equal((await call(b, "mm:enqueue", { name: "Bo" })).ok, true);
  await timeout;
  assert.equal(server.matchmaker.size, 0);

  // Disconnecting while queued also releases the slot.
  const c = await client(url, sockets);
  assert.equal((await call(c, "mm:enqueue", { name: "Cy" })).ok, true);
  assert.equal(server.matchmaker.size, 1);
  c.close();
  await wait(200);
  assert.equal(server.matchmaker.size, 0);

  // Invalid configuration is refused at startup.
  assert.throws(() => createGameServer({ matchmaking: { minPlayers: 1 } }));
});

test("invite-only rooms require the host's token and deep link", async (t) => {
  const { url, sockets } = await boot(t);
  const a = await client(url, sockets);
  const b = await client(url, sockets);
  const c = await client(url, sockets);

  const created = await call(a, "room:create", { name: "Host" });
  const code = created.room.code as string;
  assert.equal((await call(b, "room:join", { code, name: "Guest" })).ok, true);
  assert.equal((await call(a, "room:configure", { requireInvite: true })).ok, true);
  assert.equal((await call(a, "room:sync")).room.requireInvite, true);

  const denied = await call(c, "room:join", { code, name: "Late" });
  assert.equal(denied.code, "INVALID_INVITE");
  const wrong = await call(c, "room:join", { code, name: "Late", invite: "0".repeat(48) });
  assert.equal(wrong.code, "INVALID_INVITE");

  const invite = await call(a, "room:invite");
  assert.equal(invite.ok, true);
  assert.equal(invite.inviteToken!.length, 48);
  assert.ok(invite.deepLink!.startsWith("skrible://join?code="));
  assert.ok(invite.deepLink!.includes(invite.inviteToken!));

  const joined = await call(c, "room:join", { code, name: "Late", invite: invite.inviteToken! });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.players.length, 3);
  assert.equal((await call(b, "room:invite")).code, "NOT_HOST");
});

test("custom words and room settings are host-only and strictly validated", async (t) => {
  const { url, sockets } = await boot(t);
  const a = await client(url, sockets);
  const b = await client(url, sockets);

  const created = await call(a, "room:create", { name: "Host" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guest" });

  assert.equal((await call(b, "room:configure", { maxRounds: 2 })).code, "NOT_HOST");
  assert.equal((await call(b, "words:set", { categories: [] })).code, "NOT_HOST");
  assert.equal((await call(b, "words:get")).code, "NOT_HOST");

  // Cannot enable custom words before adding any.
  assert.equal((await call(a, "room:configure", { customWordsEnabled: true })).code, "INVALID_CONFIG");
  assert.equal(
    (await call(a, "words:set", { categories: [{ name: "Bad", words: ["fuck"] }] })).code,
    "INVALID_WORDS",
  );
  assert.equal(
    (await call(a, "words:set", { categories: [{ name: "Bad", words: ["word1"] }] })).code,
    "INVALID_WORDS",
  );
  assert.equal(
    (await call(a, "words:set", { categories: [{ name: "Food", words: ["pizza", "sushi", "tacos", "burger"] }] }))
      .ok,
    true,
  );
  assert.equal((await call(a, "room:configure", { customWordsEnabled: true })).ok, true);

  const seen = await call(b, "room:sync");      assert.equal(seen.room.customWordCount, 0);
      assert.equal(seen.room.savedWordCount, 4);
  assert.deepEqual(seen.room.customCategories, ["Food"]);
  assert.equal(JSON.stringify(seen.room).includes("pizza"), false);
  const hostList = await call(a, "words:get");
  assert.equal(hostList.categories![0].words.includes("pizza"), true);

  assert.equal((await call(a, "room:configure", { drawSeconds: 45, maxPlayers: 3 })).ok, true);
  assert.equal((await call(a, "room:sync")).room.drawSeconds, 45);
  assert.equal((await call(a, "room:configure", { drawSeconds: 5 })).code, "VALIDATION");
  assert.equal((await call(a, "room:configure", { maxRounds: 3, score: 999 })).code, "VALIDATION");

  const optionsP = waitFor<string[]>(a, "word:options");
  assert.equal((await call(a, "game:start")).ok, true);
  const choices = await optionsP;
  assert.equal(choices.every((word) => ["pizza", "sushi", "tacos", "burger"].includes(word)), true);
  assert.equal((await call(a, "room:configure", { maxRounds: 4 })).code, "WRONG_PHASE");

  await call(a, "word:choose", { word: choices[0] });
  const drawing = await call(b, "room:sync");
  assert.equal(drawing.room.secretWord, undefined);
  assert.ok(drawing.room.endsAt - Date.now() > 38_000);
  assert.ok(drawing.room.endsAt - Date.now() <= 46_000);
});

test("host can kick, ban, mute and review reports", async (t) => {
  const { url, sockets } = await boot(t);
  const a = await client(url, sockets);
  const b = await client(url, sockets);
  const c = await client(url, sockets);

  const created = await call(a, "room:create", { name: "Host" });
  const code = created.room.code as string;
  const joinedB = await call(b, "room:join", { code, name: "Guest B" });
  const joinedC = await call(c, "room:join", { code, name: "Guest C" });

  assert.equal((await call(b, "moderation:kick", { targetId: c.id })).code, "NOT_HOST");
  assert.equal((await call(a, "moderation:mute", { targetId: b.id, muted: true })).ok, true);
  assert.equal((await call(b, "chat:guess", { text: "hello" })).code, "MUTED");
  await call(a, "moderation:mute", { targetId: b.id, muted: false });
  const chatP = waitFor<any>(a, "chat:message");
  assert.equal((await call(b, "chat:guess", { text: "hello again" })).ok, true);
  assert.equal((await chatP).text, "hello again");

  const reported = await call(b, "moderation:report", { targetId: c.id, reason: "unfriendly drawing" });
  assert.equal(reported.ok, true);
  assert.equal(
    (await call(b, "moderation:report", { targetId: c.id, reason: "again and again" })).code,
    "REPORT_RATE_LIMITED",
  );
  assert.equal((await call(b, "moderation:state")).code, "NOT_HOST");
  const state = await call(a, "moderation:state");
  assert.equal(state.reports!.length, 1);
  assert.equal(state.reports![0].targetId, c.id);

  const kickedB = waitFor<any>(b, "room:kicked");
  assert.equal((await call(a, "moderation:kick", { targetId: b.id })).ok, true);
  assert.equal((await kickedB).banned, false);
  assert.equal((await call(b, "room:join", { code, name: "Guest B" })).ok, true);

  const bannedC = waitFor<any>(c, "room:kicked");
  assert.equal((await call(a, "moderation:kick", { targetId: c.id, ban: true })).ok, true);
  assert.equal((await bannedC).banned, true);

  // Same socket and a fresh socket presenting the banned profile both fail.
  assert.equal((await call(c, "room:join", { code, name: "Guest C" })).code, "BANNED");
  const c2 = await client(url, sockets);
  const again = await call(c2, "room:join", {
    code,
    name: "Guest C",
    token: joinedC.profileToken,
  });
  assert.equal(again.code, "BANNED");
  assert.equal(joinedB.profileToken != null, true);
});

test("profiles, match history and the leaderboard use server results", async (t) => {
  const { url, sockets } = await boot(t);
  const a = await client(url, sockets);
  const b = await client(url, sockets);
  const outsider = await client(url, sockets);

  const badName = await call(a, "profile:identify", { name: "you idiot" });
  assert.equal(badName.code, "INVALID_NAME");
  const identified = await call(a, "profile:identify", { name: "Ada", avatar: "panda" });
  assert.equal(identified.profile.avatar, "panda");
  assert.equal(identified.profile.stats.gamesPlayed, 0);
  assert.ok(identified.profileToken);

  const created = await call(a, "room:create", {
    name: "Ada",
    token: identified.profileToken,
  });
  const code = created.room.code as string;
  const joinedB = await call(b, "room:join", { code, name: "Bo" });
  await call(a, "room:configure", { maxRounds: 1 });
  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const options = await optionsP;
  await call(a, "word:choose", { word: options[0]! });

  // B guesses correctly, then becomes the drawer.
  const nextOptionsP = waitFor<string[]>(b, "word:options");
  assert.equal((await call(b, "chat:guess", { text: options[0]! })).correct, true);
  const nextOptions = await nextOptionsP;
  await call(b, "word:choose", { word: nextOptions[0]! });

  const matchP = waitFor<any>(a, "match:ended");
  assert.equal((await call(a, "chat:guess", { text: nextOptions[0]! })).correct, true);
  const match = await matchP;
  assert.equal(match.players.length, 2);
  assert.ok(match.players.every((player: any) => player.guesses === 1 && player.correctGuesses === 1));
  assert.ok(match.winners.length >= 1);

  const me = await call(a, "profile:me");
  assert.equal(me.profile.id, identified.profile.id);
  assert.equal(me.profile.stats.gamesPlayed, 1);
  assert.equal(me.profile.stats.guesses, 1);
  assert.equal(me.profile.stats.correctGuesses, 1);
  assert.equal(me.accuracy, 100);
  assert.ok(me.profile.stats.totalPoints > 0);
  assert.equal(me.history[0].id, match.id);

  const fetched = await call(a, "match:get", { matchId: match.id });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.match.id, match.id);
  assert.equal((await call(outsider, "match:get", { matchId: match.id })).code, "FORBIDDEN");

  const board = await call(outsider, "leaderboard:global");
  assert.equal(board.ephemeral, true);
  assert.equal(board.rows!.length, 2);
  assert.ok(board.rows!.every((row: any) => row.gamesPlayed === 1 && row.wins >= 0));
  assert.ok(board.rows!.some((row: any) => row.profileId === identified.profile.id));
  assert.equal(joinedB.profileToken != null, true);
});

test("spectators watch safely and can never guess or draw", async (t) => {
  const { url, sockets } = await boot(t);
  const a = await client(url, sockets);
  const b = await client(url, sockets);
  const c = await client(url, sockets);
  const d = await client(url, sockets);

  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guesser" });
  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const options = await optionsP;
  await call(a, "word:choose", { word: options[0]! });

  const watcher = await call(c, "room:join", { code, name: "Watcher" });
  assert.equal(watcher.ok, true);
  assert.equal(watcher.spectator, true);
  assert.equal(watcher.room.isSpectator, true);
  assert.equal(watcher.room.secretWord, undefined);
  assert.equal(watcher.room.wordChoices, undefined);
  assert.equal(watcher.room.spectators.length, 1);
  assert.equal(watcher.room.players.length, 2);
  assert.ok(!JSON.stringify(watcher.room).includes(options[0]!));

  // Typing the secret as a spectator is never evaluated as a guess, and the
  // leak guard still refuses to broadcast the word itself.
  const attempt = await call(c, "chat:guess", { text: options[0]! });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, "INVALID_GUESS");
  const spectatorChatP = waitFor<any>(b, "chat:message");
  assert.equal((await call(c, "chat:guess", { text: "nice drawing" })).ok, true);
  assert.equal((await spectatorChatP).text, "nice drawing");
  const afterChat = await call(b, "room:sync");
  assert.equal(afterChat.room.guessedIds.length, 0);
  assert.equal(afterChat.room.players.reduce((sum: number, p: any) => sum + p.score, 0), 0);
  assert.equal(afterChat.room.status, "drawing");

  const stroke = await call(c, "draw:stroke:begin", {
    id: "spectator-stroke",
    color: "#123456",
    width: 6,
    tool: "pen",
  });
  assert.equal(stroke.code, "NOT_DRAWER");
  assert.equal((await call(b, "room:sync")).room.status, "drawing");

  // A room can refuse spectators entirely.
  const created2 = await call(d, "room:create", { name: "Solo" });
  const code2 = created2.room.code as string;
  const e = await client(url, sockets);
  await call(e, "room:join", { code: code2, name: "Second" });
  await call(d, "room:configure", { allowSpectators: false });
  const options2P = waitFor<string[]>(d, "word:options");
  await call(d, "game:start");
  await options2P;
  const refused = await call(c, "room:join", { code: code2, name: "Watcher" });
  assert.equal(refused.code, "GAME_STARTED");
});
