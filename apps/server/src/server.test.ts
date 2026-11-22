import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createGameServer } from "./server.js";

type Resp = {
  ok: boolean;
  error?: string;
  code?: string;
  room?: any;
  sessionToken?: string;
  stroke?: any;
  [key: string]: any;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await wait(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectClient(url: string) {
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

async function setup(url: string, sockets: Socket[]) {
  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);

  const created = await call(a, "room:create", { name: "Drawer" });
  assert.equal(created.ok, true);
  const code = created.room.code as string;
  const tokenA = created.sessionToken as string;

  const joined = await call(b, "room:join", { code, name: "Guesser" });
  assert.equal(joined.ok, true);
  const tokenB = joined.sessionToken as string;
  assert.ok(tokenB && tokenB !== tokenA);

  const wordOptions = waitFor<string[]>(a, "word:options");
  assert.equal((await call(a, "game:start")).ok, true);
  const options = await wordOptions;

  const drawingUpdate = waitFor(b, "room:update");
  const chosen = await call(a, "word:choose", { word: options[0] });
  assert.equal(chosen.ok, true);
  let drawing = await drawingUpdate;
  while (drawing.status !== "drawing") drawing = await waitFor(b, "room:update");
  assert.equal(drawing.secretWord, undefined);

  return { a, b, code, tokenA, tokenB, secret: options[0] };
}

test("stroke sync, drawer-only permissions, undo/redo and clear over real sockets", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const { a, b, code, secret } = await setup(url, sockets);

  const seenByGuesser: unknown[] = [];
  b.onAny((event, ...args) => seenByGuesser.push([event, ...args]));

  // Role information is not a secret, but the word is.
  assert.equal(secret.length > 0, true);
  assert.equal((await call(b, "room:sync")).room.strokes.length, 0);

  const begins: any[] = [];
  const chunks: { id: string; points: { x: number; y: number }[] }[] = [];
  const ends: string[] = [];
  b.on("draw:stroke:begin", (payload) => begins.push(payload));
  b.on("draw:stroke:points", (payload) => chunks.push(payload));
  b.on("draw:stroke:end", (payload) => ends.push(payload.id));

  const strokeId = "stroke-integration-1";
  const begin = await call(a, "draw:stroke:begin", {
    id: strokeId,
    color: "#112233",
    width: 5,
    tool: "pen",
  });
  assert.equal(begin.ok, true);
  await until(() => begins.length === 1, "stroke begin");
  assert.equal(begins[0].id, strokeId);
  assert.equal(begins[0].seq, 0);
  assert.equal(begins[0].tool, "pen");

  assert.equal(
    (await call(a, "draw:stroke:points", { id: strokeId, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }))
      .ok,
    true,
  );
  assert.equal(
    (await call(a, "draw:stroke:points", { id: strokeId, points: [{ x: 0.3, y: 0.3 }] })).ok,
    true,
  );
  await until(() => chunks.length === 2, "two point chunks");
  assert.deepEqual(chunks[0].points, [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]);
  assert.deepEqual(chunks[1].points, [{ x: 0.3, y: 0.3 }]);

  assert.equal((await call(a, "draw:stroke:end", { id: strokeId })).ok, true);
  await until(() => ends.length === 1, "stroke end");
  assert.equal(ends[0], strokeId);

  // The guesser cannot draw, undo, redo or clear.
  const deniedBegin = await call(b, "draw:stroke:begin", {
    id: "stroke-hacker-1",
    color: "#000000",
    width: 4,
    tool: "pen",
  });
  assert.equal(deniedBegin.ok, false);
  assert.equal(deniedBegin.code, "NOT_DRAWER");
  assert.equal((await call(b, "draw:undo")).code, "NOT_DRAWER");
  assert.equal((await call(b, "draw:redo")).code, "NOT_DRAWER");
  assert.equal((await call(b, "draw:clear")).code, "NOT_DRAWER");

  // Malformed payloads are rejected, not relayed.
  const badPoint = await call(a, "draw:stroke:points", { id: strokeId, points: [{ x: 1.4, y: 0.2 }] });
  assert.equal(badPoint.ok, false);
  assert.equal(badPoint.code, "VALIDATION");
  const badColor = await call(a, "draw:stroke:begin", {
    id: "stroke-bad-color",
    color: "red",
    width: 4,
    tool: "pen",
  });
  assert.equal(badColor.code, "VALIDATION");

  // Undo/redo are broadcast to every client, including the drawer.
  const undone = waitFor(b, "draw:undo");
  assert.equal((await call(a, "draw:undo")).ok, true);
  const undoEvent = await undone;
  assert.equal(undoEvent.strokeId, strokeId);
  assert.equal(undoEvent.undoDepth, 0);
  assert.equal(undoEvent.redoDepth, 1);

  const redone = waitFor(b, "draw:redo");
  assert.equal((await call(a, "draw:redo")).ok, true);
  const redoEvent = await redone;
  assert.equal(redoEvent.stroke.id, strokeId);
  assert.equal(redoEvent.stroke.points.length, 3);

  const synced = await call(b, "room:sync");
  assert.equal(synced.room.strokes.length, 1);
  assert.equal(synced.room.strokes[0].points.length, 3);
  assert.equal(synced.room.boardVersion, redoEvent.boardVersion);
  assert.equal(synced.room.undoDepth, 1);
  assert.equal(synced.room.redoDepth, 0);

  const cleared = waitFor(b, "draw:clear");
  assert.equal((await call(a, "draw:clear")).ok, true);
  await cleared;
  assert.equal((await call(b, "room:sync")).room.strokes.length, 0);

  // The secret word was never sent to the guessing player.
  const guesserStream = JSON.stringify(seenByGuesser);
  assert.ok(!guesserStream.includes(secret), "secret word leaked to guesser");
  assert.ok(!guesserStream.includes("sessionToken"), "session token leaked");
});

test("a disconnected player resumes the same seat with the full board", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const { a, b, code, tokenB } = await setup(url, sockets);

  for (const [index, points] of [
    [0, [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }]],
    [1, [{ x: 0.6, y: 0.1 }, { x: 0.7, y: 0.2 }]],
  ]) {
    const id = `stroke-replay-${index}`;
    assert.equal((await call(a, "draw:stroke:begin", { id, color: "#334455", width: 8, tool: "pen" })).ok, true);
    assert.equal((await call(a, "draw:stroke:points", { id, points })).ok, true);
    assert.equal((await call(a, "draw:stroke:end", { id })).ok, true);
  }

  const roomBefore = server.game.rooms.get(code)!;
  assert.equal(roomBefore.strokes.length, 2);

  b.close();
  await until(() => roomBefore.players.find((p) => p.name === "Guesser")?.connected === false, "disconnect");

  const resumedSocket = await connectClient(url);
  sockets.push(resumedSocket);
  const resumed = await call(resumedSocket, "room:resume", { code, token: tokenB });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.sessionToken, tokenB);

  const room = resumed.room;
  assert.equal(room.status, "drawing");
  assert.equal(room.players.length, 2);
  assert.equal(room.players.find((p: any) => p.name === "Guesser").connected, true);
  assert.equal(room.strokes.length, 2);
  assert.equal(room.strokes[1].points.length, 2);
  assert.equal(room.secretWord, undefined);
  assert.equal(room.isDrawer, false);

  // Matching the word after a reconnect still works through the server.
  const guess = await call(resumedSocket, "chat:guess", { text: roomBefore.secretWord });
  assert.equal(guess.ok, true);
  assert.equal(guess.correct, true);
  const scored = await call(resumedSocket, "room:sync");
  assert.ok(scored.room.players.find((p: any) => p.name === "Guesser").score > 0);

  // A bad token cannot steal the seat.
  const other = await connectClient(url);
  sockets.push(other);
  const denied = await call(other, "room:resume", { code, token: "invalid-token-value" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "INVALID_SESSION");
});

test("entering a new room releases the previous seat", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);
  const first = await call(a, "room:create", { name: "Host" });
  const oldCode = first.room.code as string;
  assert.equal((await call(b, "room:join", { code: oldCode, name: "Guest" })).ok, true);
  assert.equal(server.game.rooms.get(oldCode)!.players.length, 2);

  const second = await call(b, "room:create", { name: "Guest" });
  assert.equal(second.ok, true);
  assert.notEqual(second.room.code, oldCode);
  assert.equal(server.game.rooms.get(oldCode)!.players.length, 1);
  assert.equal(server.game.rooms.get(oldCode)!.players[0]!.name, "Host");
  assert.equal(server.game.rooms.get(second.room.code as string)!.players.length, 1);
});

test("the server timer ends the drawing phase and rotates the drawer", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const { code } = await setup(url, sockets);
  const room = server.game.rooms.get(code)!;
  const drawerBefore = room.drawerId;
  room.endsAt = Date.now() - 1;

  await until(() => room.status === "choosing", "timer to advance the turn");
  assert.notEqual(room.drawerId, drawerBefore);
  assert.equal(room.strokes.length, 0);
});

test("three private choices, chat, redaction and announced correct guesses", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);
  const seenByGuesser: unknown[] = [];
  const optionsForGuesser: string[][] = [];
  const chatForDrawer: any[] = [];
  b.onAny((event, ...args) => seenByGuesser.push([event, ...args]));
  b.on("word:options", (options: string[]) => optionsForGuesser.push(options));
  a.on("chat:message", (message: any) => chatForDrawer.push(message));

  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  assert.equal((await call(b, "room:join", { code, name: "Guesser" })).ok, true);

  const optionsP = waitFor<string[]>(a, "word:options");
  assert.equal((await call(a, "game:start")).ok, true);
  const choices = await optionsP;
  assert.equal(choices.length, 3);
  assert.equal(new Set(choices).size, 3);
  assert.deepEqual(optionsForGuesser, []);
  // Starting twice must not reset the round or hand out new options.
  assert.equal((await call(a, "game:start")).code, "WRONG_PHASE");

  const chosen = choices[2]!;
  const updateP = waitFor<any>(b, "room:update");
  assert.equal((await call(a, "word:choose", { word: chosen })).ok, true);
  // A double-tap must not restart the drawing timer or re-mask anything.
  assert.equal((await call(a, "word:choose", { word: chosen })).code, "WRONG_PHASE");
  let drawing = await updateP;
  while (drawing.status !== "drawing") drawing = await waitFor(b, "room:update");
  assert.equal(drawing.secretWord, undefined);
  assert.equal(drawing.wordChoices, undefined);
  assert.equal(drawing.maskedWord, "_".repeat(chosen.length));
  assert.equal(drawing.isDrawer, false);

  const drawerSync = await call(a, "room:sync");
  assert.equal(drawerSync.room.secretWord, chosen);
  assert.equal(drawerSync.room.isDrawer, true);

  // A wrong guess is chat.
  const wrongP = waitFor<any>(b, "chat:message");
  assert.equal((await call(b, "chat:guess", { text: "banana" })).correct, false);
  const wrongMessage = await wrongP;
  assert.equal(wrongMessage.kind, "chat");
  assert.equal(wrongMessage.text, "banana");
  assert.equal(wrongMessage.name, "Guesser");

  // The drawer can chat but never scores from it.
  const banterP = waitFor<any>(b, "chat:message");
  assert.equal((await call(a, "chat:guess", { text: "hurry up!" })).correct, false);
  assert.equal((await banterP).text, "hurry up!");

  // A line containing the word is blocked and never broadcast.
  const leaked: any[] = [];
  const leakListener = (message: any) => leaked.push(message);
  b.on("chat:message", leakListener);
  const reveal = await call(a, "chat:guess", { text: `the answer is ${chosen}` });
  assert.equal(reveal.ok, false);
  assert.equal(reveal.code, "INVALID_GUESS");
  await wait(300);
  b.off("chat:message", leakListener);
  assert.equal(leaked.length, 0);

  // Extra fields cannot inject scores.
  const injected = await call(b, "chat:guess", { text: "hi", score: 9999 });
  assert.equal(injected.ok, false);
  assert.equal(injected.code, "VALIDATION");

  // Everything B has seen while merely guessing must be word-free.
  const streamBeforeGuess = JSON.stringify(seenByGuesser);
  const correctP = waitFor<any>(b, "chat:message");
  const correct = await call(b, "chat:guess", { text: ` ${chosen.toUpperCase()} ` });
  assert.equal(correct.correct, true);
  assert.ok((correct.score as number) >= 100);
  const announcement = await correctP;
  assert.equal(announcement.kind, "correct");
  assert.ok(!announcement.text.includes(chosen));

  assert.ok(
    chatForDrawer.some((message) => message.kind === "correct"),
    "the drawer must see the correct-guess announcement",
  );

  const finalSync = await call(b, "room:sync");
  const guesser = finalSync.room.players.find((p: any) => p.name === "Guesser");
  const drawer = finalSync.room.players.find((p: any) => p.name === "Drawer");
  assert.equal(guesser.score, correct.score);
  assert.equal(drawer.score, 35);
  assert.equal(finalSync.room.status, "choosing");

  assert.ok(!streamBeforeGuess.includes(chosen), "secret word leaked to guesser");
  assert.ok(!streamBeforeGuess.includes("sessionToken"));
});

test("two simultaneous correct guesses each score once and credit the drawer", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  const c = await connectClient(url);
  sockets.push(a, b, c);
  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guesser B" });
  await call(c, "room:join", { code, name: "Guesser C" });

  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const choices = await optionsP;
  const word = choices[0]!;
  await call(a, "word:choose", { word });

  const [resultB, resultC] = await Promise.all([
    call(b, "chat:guess", { text: word }),
    call(c, "chat:guess", { text: word }),
  ]);
  assert.equal(resultB.correct, true);
  assert.equal(resultC.correct, true);

  const sync = await call(a, "room:sync");
  const playerB = sync.room.players.find((p: any) => p.name === "Guesser B");
  const playerC = sync.room.players.find((p: any) => p.name === "Guesser C");
  const drawer = sync.room.players.find((p: any) => p.name === "Drawer");
  assert.equal(playerB.score, resultB.score);
  assert.equal(playerC.score, resultC.score);
  assert.equal(drawer.score, 35 * 2);
  assert.equal(sync.room.status, "choosing");

  // A repeat after the round moved on is plain chat and never scores again.
  const before = playerB.score + playerC.score;
  await call(b, "chat:guess", { text: word });
  const after = await call(a, "room:sync");
  const sum = after.room.players
    .filter((p: any) => p.name.startsWith("Guesser"))
    .reduce((total: number, p: any) => total + p.score, 0);
  assert.equal(sum, before);
});

test("a player who already guessed cannot reveal the word in chat", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  const c = await connectClient(url);
  sockets.push(a, b, c);
  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guesser B" });
  await call(c, "room:join", { code, name: "Guesser C" });

  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const word = (await optionsP)[0]!;
  await call(a, "word:choose", { word });

  assert.equal((await call(b, "chat:guess", { text: word })).correct, true);
  const scoreBefore = (await call(c, "room:sync")).room.players.find(
    (p: any) => p.name === "Guesser B",
  ).score;
  const reveal = await call(b, "chat:guess", { text: `the word is ${word}` });
  assert.equal(reveal.ok, false);
  assert.equal(reveal.code, "INVALID_GUESS");
  const scoreAfter = (await call(c, "room:sync")).room.players.find(
    (p: any) => p.name === "Guesser B",
  ).score;
  assert.equal(scoreAfter, scoreBefore, "repeat attempts must never score again");

  // The round is still running for player C, and the word was not broadcast.
  const sync = await call(c, "room:sync");
  assert.equal(sync.room.status, "drawing");
  assert.equal(sync.room.secretWord, undefined);
  assert.ok(!sync.room.chat.some((message: any) => message.text.includes(word)));

  assert.equal((await call(c, "chat:guess", { text: word })).correct, true);
  const done = await call(a, "room:sync");
  assert.equal(done.room.status, "choosing");
});

test("an expired word choice auto-starts the drawing phase", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);
  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guesser" });
  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const choices = await optionsP;

  const room = server.game.rooms.get(code)!;
  room.endsAt = Date.now() - 1;
  await until(() => room.status === "drawing", "auto word pick");
  assert.ok(choices.includes(room.secretWord!));

  const guesserView = await call(b, "room:sync");
  assert.equal(guesserView.room.secretWord, undefined);
  assert.equal(guesserView.room.wordChoices, undefined);
  assert.equal(guesserView.room.maskedWord, "_".repeat(room.secretWord!.length));

  const guess = await call(b, "chat:guess", { text: room.secretWord });
  assert.equal(guess.correct, true);
});

test("only the host can change rounds, and only in the lobby", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);
  const created = await call(a, "room:create", { name: "Host" });
  const code = created.room.code as string;
  await call(b, "room:join", { code, name: "Guest" });

  // Chat is available before the game starts; guesses only exist while drawing.
  const lobbyChatP = waitFor<any>(b, "chat:message");
  assert.equal((await call(a, "chat:guess", { text: "hello lobby" })).ok, true);
  assert.equal((await lobbyChatP).text, "hello lobby");

  assert.equal((await call(a, "room:configure", { maxRounds: 2 })).ok, true);
  assert.equal((await call(b, "room:sync")).room.maxRounds, 2);
  assert.equal((await call(b, "room:configure", { maxRounds: 5 })).code, "NOT_HOST");
  assert.equal((await call(a, "room:configure", { maxRounds: 0 })).code, "VALIDATION");
  assert.equal((await call(a, "room:configure", { maxRounds: 3, score: 500 })).code, "VALIDATION");

  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  await optionsP;
  assert.equal((await call(a, "room:configure", { maxRounds: 4 })).code, "WRONG_PHASE");
  assert.equal((await call(a, "room:sync")).room.maxRounds, 2);
});

test("a reconnecting drawer recovers the same private choices", async (t) => {
  const server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });

  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);
  const created = await call(a, "room:create", { name: "Drawer" });
  const code = created.room.code as string;
  const tokenA = created.sessionToken as string;
  await call(b, "room:join", { code, name: "Guesser" });
  const optionsP = waitFor<string[]>(a, "word:options");
  await call(a, "game:start");
  const choices = await optionsP;

  a.close();
  await until(() => server.game.rooms.get(code)!.players.find((p) => p.id !== b.id)?.connected === false, "drawer disconnect");

  const resumedSocket = await connectClient(url);
  sockets.push(resumedSocket);
  const resumed = await call(resumedSocket, "room:resume", { code, token: tokenA });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.room.status, "choosing");
  assert.equal(resumed.room.isDrawer, true);
  assert.deepEqual(resumed.room.wordChoices, choices);
  assert.equal(resumed.room.secretWord, undefined);

  // The guesser still has no access to the choices.
  const guesserView = await call(b, "room:sync");
  assert.equal(guesserView.room.wordChoices, undefined);
  assert.equal(guesserView.room.secretWord, undefined);
});

