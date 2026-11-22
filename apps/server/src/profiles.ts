import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolveAvatar, validateName, type AvatarId } from "./validation.js";

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
  createdAt: number;
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

export type MatchInput = {
  roomCode: string;
  rounds: number;
  players: {
    profileId?: string;
    name: string;
    avatar: AvatarId;
    score: number;
    guesses: number;
    correctGuesses: number;
  }[];
};

const emptyStats = (): ProfileStats => ({
  gamesPlayed: 0,
  gamesWon: 0,
  totalPoints: 0,
  guesses: 0,
  correctGuesses: 0,
});

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const accuracyOf = (stats: ProfileStats) =>
  stats.guesses > 0 ? Math.round((stats.correctGuesses / stats.guesses) * 100) : 0;

/**
 * In-memory identity and match history for the lifetime of this server process.
 * It is deliberately behind a small store API so Phase 5 can replace it with
 * PostgreSQL without touching the socket layer. Nothing here survives a restart.
 */
export class ProfileStore {
  readonly profiles = new Map<string, Profile>();
  readonly matches = new Map<string, MatchRecord>();
  private readonly tokens = new Map<string, string>(); // sha256(token) -> profileId
  private readonly history = new Map<string, string[]>(); // profileId -> match ids

  identityCount() {
    return this.profiles.size;
  }

  identify(token: string | undefined, rawName: string, rawAvatar: unknown): { profile: Profile; token: string } {
    if (token) {
      const profileId = this.tokens.get(hashToken(token));
      const existing = profileId ? this.profiles.get(profileId) : undefined;
      if (existing) return { profile: existing, token };
    }

    const name = validateName(rawName);
    const profile: Profile = {
      id: randomUUID(),
      name,
      avatar: resolveAvatar(rawAvatar),
      stats: emptyStats(),
      createdAt: Date.now(),
    };
    const issued = randomBytes(32).toString("hex");
    this.profiles.set(profile.id, profile);
    this.tokens.set(hashToken(issued), profile.id);
    return { profile, token: issued };
  }

  update(profileId: string, patch: { name?: string; avatar?: unknown }): Profile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error("Profile not found");
    if (patch.name !== undefined) profile.name = validateName(patch.name);
    if (patch.avatar !== undefined) profile.avatar = resolveAvatar(patch.avatar);
    return profile;
  }

  view(profileId: string) {
    const profile = this.profiles.get(profileId);
    if (!profile) return undefined;
    return {
      profile: { ...profile, stats: { ...profile.stats } },
      accuracy: accuracyOf(profile.stats),
      history: this.historyFor(profileId),
    };
  }

  /** Records one finished match and folds the result into each profile's stats. */
  recordMatch(input: MatchInput): MatchRecord {
    const sorted = [...input.players].sort((a, b) => b.score - a.score);
    const players: MatchPlayerResult[] = sorted.map((player) => {
      const rank = 1 + sorted.filter((other) => other.score > player.score).length;
      return {
        profileId: player.profileId,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
        rank,
        won: rank === 1,
        guesses: player.guesses,
        correctGuesses: player.correctGuesses,
      };
    });

    const match: MatchRecord = {
      id: randomUUID(),
      roomCode: input.roomCode,
      at: Date.now(),
      rounds: input.rounds,
      players,
      winners: players.filter((player) => player.won).map((player) => player.profileId ?? player.name),
    };
    this.matches.set(match.id, match);
    if (this.matches.size > 500) {
      const oldest = this.matches.keys().next().value;
      if (oldest) this.matches.delete(oldest);
    }

    for (const player of players) {
      if (!player.profileId) continue;
      const profile = this.profiles.get(player.profileId);
      if (!profile) continue;
      profile.stats.gamesPlayed += 1;
      profile.stats.gamesWon += player.won ? 1 : 0;
      profile.stats.totalPoints += player.score;
      profile.stats.guesses += player.guesses;
      profile.stats.correctGuesses += player.correctGuesses;

      const entries = this.history.get(player.profileId) ?? [];
      entries.unshift(match.id);
      this.history.set(player.profileId, entries.slice(0, 25));
    }

    return match;
  }

  historyFor(profileId: string): MatchRecord[] {
    return (this.history.get(profileId) ?? [])
      .map((id) => this.matches.get(id))
      .filter((match): match is MatchRecord => match != null);
  }

  leaderboard(limit = 20): LeaderboardRow[] {
    return Array.from(this.profiles.values())
      .filter((profile) => profile.stats.gamesPlayed > 0)
      .sort(
        (a, b) =>
          b.stats.gamesWon - a.stats.gamesWon ||
          b.stats.totalPoints - a.stats.totalPoints ||
          accuracyOf(b.stats) - accuracyOf(a.stats) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((profile, index) => ({
        rank: index + 1,
        profileId: profile.id,
        name: profile.name,
        avatar: profile.avatar,
        wins: profile.stats.gamesWon,
        gamesPlayed: profile.stats.gamesPlayed,
        points: profile.stats.totalPoints,
        accuracy: accuracyOf(profile.stats),
      }));
  }
}
