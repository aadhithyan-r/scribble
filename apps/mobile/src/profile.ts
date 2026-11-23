import type { Profile } from "./game/types";

/**
 * Local identity for this app run. The server hashes the token it issued and
 * owns all statistics; this only remembers who we are between rooms. Full
 * cross-launch accounts arrive with authentication/persistence in Phase 5.
 */
export type Identity = {
  token: string;
  id: string;
  name: string;
  avatar: string;
  /** Server-provided session expiry, used to refresh proactively. */
  expiresAt?: number;
};

let identity: Identity | null = null;

export const getIdentity = () => identity;

export const setIdentity = (next: Identity) => {
  identity = next;
};

export const clearIdentity = () => {
  identity = null;
};

export const identityFromProfile = (profile: Profile, token: string): Identity => ({
  token,
  id: profile.id,
  name: profile.name,
  avatar: profile.avatar,
});
