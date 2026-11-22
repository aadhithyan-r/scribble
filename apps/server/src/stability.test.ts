import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { createGameServer, type GameServerOptions } from "./server.js";

type Resp = {
  ok: boolean;
  code?: string;
  error?: string;
  room?: any;
  sessionToken?: string;
  duplicate?: boolean;
  appended?: number;
  correct?: boolean;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await wait(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectClient(url: string) {
  const socket = connect(url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
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

async function startServer(t: TestContext, options: GameServerOptions = {}) {
  const server = createGameServer(options);
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await server.close();
  });
  return { server, sockets, url: `http://127.0.0.1:${port}` };
}

/** Two players in the drawing phase with a chosen word. */
async function drawingRoom(url: string, sockets: Socket[]) {
  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);

  const created = await call(a, "room:create", { name: "Drawer" });
  assert.equal(created.ok, true);
  const code = created.room.code as string;

  const joined = await call(b, "room:join", { code, name: "Guesser" });
  assert.equal(joined.ok, true);

  const options = waitFor<string[]>(a, "word:options");
  assert.equal((await call(a, "game:start")).ok, true);
  const words = await options;

  const update = waitFor<any>(b, "room:update");
  assert.equal((await call(a, "word:choose", { word: words[0] })).ok, true);
  let room = await update;
  while (room.status !== "drawing") room = await waitFor<any>(b, "room:update");

  return {
    a,
    b,
    code,
    tokenA: created.sessionToken as string,
    tokenB: joined.sessionToken as string,
    word: words[0]!,
  };
}

test("a dropped player keeps seat, score and role during the grace window", async (t) => {
  const { server, url, sockets } = await startServer(t, { reconnectGraceMs: 1500 });
  const { a, b, code, tokenB, word } = await drawingRoom(url, sockets);

  assert.equal((await call(b, "chat:guess", { text: word })).correct, true);
  const before = (await call(a, "room:sync")).room;
  const scored = before.players.find((player: any) => player.name === "Guesser");
  assert.ok(scored.score > 0);

  b.close();
  await until(
    () => server.game.rooms.get(code)?.players.find((p) => p.name === "Guesser")?.connected === false,
    "player disconnect",
  );

  const snapshot = (await call(a, "room:sync")).room;
  const held = snapshot.players.find((player: any) => player.name === "Guesser");
  assert.equal(held.reconnecting, true);
  assert.equal(held.score, scored.score);
  assert.equal(snapshot.players.length, 2);

  const b2 = await connectClient(url);
  sockets.push(b2);
  const resumed = await call(b2, "room:resync", { code, token: tokenB });
  assert.equal(resumed.ok, true);
  const after = resumed.room.players.find((player: any) => player.name === "Guesser");
  assert.equal(after.connected, true);
  assert.equal(after.reconnecting, false);
  assert.equal(after.score, scored.score);
});

test("the active drawer reconnects inside the grace window and keeps the turn", async (t) => {
  const { server, url, sockets } = await startServer(t, { reconnectGraceMs: 2500 });
  const { a, b, code, tokenA } = await drawingRoom(url, sockets);
  const drawerSocketId = a.id;

  a.close();
  await until(
    () =>
      server.game.rooms
        .get(code)
        ?.players.find((player) => player.id === drawerSocketId)?.reconnecting === true,
    "drawer marked reconnecting",
  );

  const view = (await call(b, "room:sync")).room;
  assert.equal(view.status, "drawing");
  assert.equal(view.drawerId, drawerSocketId);
  assert.equal(view.players.find((p: any) => p.id === drawerSocketId).reconnecting, true);
  assert.equal(view.secretWord, undefined);

  const a2 = await connectClient(url);
  sockets.push(a2);
  const resumed = await call(a2, "room:resync", { code, token: tokenA });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.room.isDrawer, true);
  assert.equal(resumed.room.drawerId, a2.id);
  assert.equal(resumed.room.status, "drawing");
  assert.ok(resumed.room.secretWord);

  const begin = await call(a2, "draw:stroke:begin", {
    id: "stroke-after-reconnect",
    color: "#112233",
    width: 4,
    tool: "pen",
  });
  assert.equal(begin.ok, true);
});

test("an expired grace window hands the turn over and then collects the room", async (t) => {
  const { server, url, sockets } = await startServer(t, { reconnectGraceMs: 1000 });
  const { a, b, code } = await drawingRoom(url, sockets);

  a.close();
  await until(() => server.game.rooms.get(code)?.players.length === 1, "seat release", 6000);

  const snapshot = (await call(b, "room:sync")).room;
  assert.equal(snapshot.players.length, 1);
  assert.equal(snapshot.drawerId, b.id);
  assert.equal(snapshot.status, "choosing");
  assert.equal(snapshot.round, 1);

  b.close();
  await until(() => !server.game.rooms.has(code), "empty room collected", 6000);
});

test("room:resync returns a complete authoritative snapshot on a fresh socket", async (t) => {
  const { server, url, sockets } = await startServer(t, { reconnectGraceMs: 2000 });
  const { a, b, code, tokenB } = await drawingRoom(url, sockets);

  await call(a, "draw:stroke:begin", {
    id: "stroke-resync-1",
    color: "#334455",
    width: 6,
    tool: "pen",
  });
  await call(a, "draw:stroke:points", {
    id: "stroke-resync-1",
    points: [
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.3 },
    ],
    seq: 1,
  });
  await call(a, "draw:stroke:end", { id: "stroke-resync-1" });
  await call(b, "chat:guess", { text: "nice drawing" });

  b.close();
  await until(
    () =>
      server.game.rooms
        .get(code)
        ?.players.find((player) => player.name === "Guesser")?.connected === false,
    "guesser disconnect",
  );

  const fresh = await connectClient(url);
  sockets.push(fresh);
  const resumed = await call(fresh, "room:resync", { code, token: tokenB });
  assert.equal(resumed.ok, true);

  const room = resumed.room;
  assert.equal(room.status, "drawing");
  assert.equal(typeof room.serverNow, "number");
  assert.ok(Math.abs(room.serverNow - Date.now()) < 5000);
  assert.equal(room.drawerId, a.id);
  assert.equal(room.strokes.length, 1);
  assert.equal(room.strokes[0].points.length, 2);
  assert.ok(room.chat.some((message: any) => message.text === "nice drawing"));
  assert.ok(room.endsAt > room.serverNow);
  assert.equal(room.isDrawer, false);
  assert.equal(room.players.find((p: any) => p.name === "Guesser").reconnecting, false);
});

test("resuming a seat replaces the old socket instead of creating a ghost", async (t) => {
  const { server, url, sockets } = await startServer(t, { reconnectGraceMs: 4000 });
  const { a, b, code, tokenB } = await drawingRoom(url, sockets);

  const replaced = waitFor<{ error?: string }>(b, "session:replaced");
  const b2 = await connectClient(url);
  sockets.push(b2);
  const resumed = await call(b2, "room:resume", { code, token: tokenB });
  assert.equal(resumed.ok, true);
  await replaced;
  await until(() => !b.connected, "old socket closed");

  const view = (await call(a, "room:sync")).room;
  assert.equal(view.players.length, 2);
  assert.equal(view.players.find((player: any) => player.name === "Guesser").id, b2.id);
  assert.equal(
    server.game.rooms.get(code)!.players.filter((player) => player.name === "Guesser").length,
    1,
  );
});

test("chat floods are limited, and duplicate stroke events are idempotent", async (t) => {
  const { url, sockets } = await startServer(t);
  const { a, b } = await drawingRoom(url, sockets);

  const chat = await Promise.all(
    Array.from({ length: 8 }, (_, index) => call(b, "chat:guess", { text: `message ${index}` })),
  );
  assert.ok(chat.some((response) => response.code === "RATE_LIMITED"));

  const beginPayload = {
    id: "stroke-idempotent",
    color: "#123456",
    width: 4,
    tool: "pen",
  };
  assert.equal((await call(a, "draw:stroke:begin", beginPayload)).ok, true);
  const repeat = await call(a, "draw:stroke:begin", beginPayload);
  assert.equal(repeat.ok, true);
  assert.equal(repeat.duplicate, true);

  const firstChunk = await call(a, "draw:stroke:points", {
    id: beginPayload.id,
    points: [{ x: 0.1, y: 0.1 }],
    seq: 1,
  });
  const retransmit = await call(a, "draw:stroke:points", {
    id: beginPayload.id,
    points: [{ x: 0.9, y: 0.9 }],
    seq: 1,
  });
  assert.equal(firstChunk.appended, 1);
  assert.equal(retransmit.appended, 0);

  const sync = await call(a, "room:sync");
  assert.equal(
    sync.room.strokes.find((stroke: any) => stroke.id === beginPayload.id).points.length,
    1,
  );

  const flood = await Promise.all(
    Array.from({ length: 140 }, (_, index) =>
      call(a, "draw:stroke:begin", {
        id: `stroke-flood-${index}`,
        color: "#123456",
        width: 4,
        tool: "pen",
      }),
    ),
  );
  assert.ok(flood.some((response) => response.code === "RATE_LIMITED"));
});

test("empty rooms are collected when the last seat leaves", async (t) => {
  const { server, url, sockets } = await startServer(t);
  const a = await connectClient(url);
  const b = await connectClient(url);
  sockets.push(a, b);

  const created = await call(a, "room:create", { name: "Host" });
  const code = created.room.code as string;
  assert.equal((await call(b, "room:join", { code, name: "Guest" })).ok, true);

  assert.equal((await call(a, "room:leave")).ok, true);
  assert.equal((await call(b, "room:leave")).ok, true);
  await until(() => !server.game.rooms.has(code), "room collected");
  assert.equal(server.game.rooms.size, 0);
});
