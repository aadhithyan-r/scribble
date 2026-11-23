export type Point = { x: number; y: number };
export type Tool = "pen" | "eraser";

export type Stroke = {
  id: string;
  seq: number;
  points: Point[];
  color: string;
  width: number;
  tool: Tool;
  complete: boolean;
};

export type AvatarId = string;

export type PlayerInfo = {
  id: string;
  profileId: string;
  name: string;
  score: number;
  connected: boolean;
  /** Seat is held open for the reconnect grace window. */
  reconnecting?: boolean;
  avatar: AvatarId;
};

export type SpectatorInfo = {
  id: string;
  profileId: string;
  name: string;
  avatar: AvatarId;
  connected: boolean;
  reconnecting?: boolean;
};

export type RoomStatus = "lobby" | "choosing" | "drawing" | "ended";

export type ChatKind = "chat" | "system" | "correct";

export type ChatMessage = {
  id: string;
  kind: ChatKind;
  playerId?: string;
  name?: string;
  text: string;
  at: number;
};

export type WordCategory = { name: string; words: string[] };

export type ProfileStats = {
  gamesPlayed: number;
  gamesWon: number;
  totalPoints: number;
  guesses: number;
  correctGuesses: number;
};

export type Profile = {
  id: string;
  name: string;
  avatar: AvatarId;
  stats: ProfileStats;
  createdAt?: number;
  accuracy?: number;
};

export type MatchPlayerResult = {
  profileId?: string;
  name: string;
  avatar: AvatarId;
  score: number;
  rank: number;
  won: boolean;
  guesses: number;
  correctGuesses: number;
};

export type MatchRecord = {
  id: string;
  roomCode: string;
  at: number;
  rounds: number;
  players: MatchPlayerResult[];
  winners: string[];
};

export type LeaderboardRow = {
  rank: number;
  profileId: string;
  name: string;
  avatar: AvatarId;
  wins: number;
  gamesPlayed: number;
  points: number;
  accuracy: number;
};

export type PlayerReport = {
  id: string;
  roomCode: string;
  reporterId: string;
  reporterName: string;
  targetId: string;
  targetName: string;
  reason: string;
  at: number;
};

/** Public lobby row shown on the home screen. */
export type PublicRoomSummary = {
  code: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  round: number;
  maxRounds: number;
  drawSeconds: number;
};

/** Server-authoritative room snapshot. Mirrors `publicRoom` on the server. */
export type RoomUpdate = {
  code: string;
  status: RoomStatus;
  round: number;
  maxRounds: number;
  players: PlayerInfo[];
  spectators: SpectatorInfo[];
  hostId: string;
  drawerId?: string;
  drawerName?: string;
  maxPlayers: number;
  drawSeconds: number;
  visibility: "private" | "public";
  requireInvite: boolean;
  allowSpectators: boolean;
  customWordsEnabled: boolean;
  customWordCount: number;
  customCategories: string[];
  youAreMuted: boolean;
  startedAt?: number;
  endedAt?: number;
  matchId?: string;
  maskedWord?: string;
  endsAt?: number;
  strokes: Stroke[];
  boardVersion: number;
  /** Server clock at serialization time; used to offset countdowns. */
  serverNow?: number;
  undoDepth: number;
  redoDepth: number;
  guessedIds: string[];
  chat: ChatMessage[];
  chooseEndsAt?: number;
  isDrawer: boolean;
  isSpectator: boolean;
  avatar?: AvatarId;
  /** Private: only present for the current drawer. */
  wordChoices?: string[];
  /** Private: only present for the current drawer. */
  secretWord?: string;
};

export type AckResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  room?: RoomUpdate;
  roomCode?: string;
  sessionToken?: string;
  profile?: Profile;
  profileToken?: string;
  token?: string;
  expiresAt?: number;
  spectator?: boolean;
  seq?: number;
  correct?: boolean;
  score?: number;
  position?: number;
  size?: number;
  minPlayers?: number;
  removed?: boolean;
  inviteToken?: string;
  deepLink?: string;
  categories?: WordCategory[];
  match?: MatchRecord;
  history?: MatchRecord[];
  accuracy?: number;
  rows?: LeaderboardRow[];
  ephemeral?: boolean;
  note?: string;
  muted?: boolean;
  reportId?: string;
  reports?: PlayerReport[];
  mutedProfileIds?: string[];
  bannedProfileIds?: string[];
  rooms?: PublicRoomSummary[];
  /** True when Socket.IO connection-state recovery restored the session. */
  recovered?: boolean;
  duplicate?: boolean;
  appended?: number;
};
