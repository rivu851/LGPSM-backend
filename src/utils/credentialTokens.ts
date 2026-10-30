import { generateSecureToken, hashToken } from './invitation.util';
import { decryptToken, encryptToken } from './tokenCipher';

// Two independent secrets per guest.
//
//  * The INVITATION token is in the guest's invitation link. It lets them open their page, answer the RSVP and choose a food
//    preference, and fetch their current pass. It does not change when a pass is replaced or revoked.
//  * The ADMISSION credential is what the QR code carries and what the door scanner presents. It is the only secret the check-in
//    accepts, and the only one that is revoked or replaced. (Stored as `qrTokenHash` / `qrTokenCipher`.)
//
// Guests invited before the two were separated have ONE token doing both jobs: `invitationTokenHash` is absent, and the
// invitation link is found through `qrTokenHash` until the guest's pass is next replaced or re-sent, when that token becomes
// the (stable) invitation token and a new admission credential is minted.

type TokenFields = {
  invitationTokenHash?: string | null; invitationTokenCipher?: string | null;
  qrTokenHash?: string | null; qrTokenCipher?: string | null;
};

/** Mongo filter that finds a guest by the token in their invitation link. */
export const invitationLookup = (hash: string) => ({
  $or: [{ invitationTokenHash: hash }, { invitationTokenHash: { $exists: false }, qrTokenHash: hash }]
});

/** The raw invitation token, when it can be recovered (needs the ciphers to have been selected). */
export function readInvitationToken(g: TokenFields): string | null {
  if (g.invitationTokenHash) {
    const t = decryptToken(g.invitationTokenCipher || undefined);
    return t && hashToken(t) === g.invitationTokenHash ? t : null;
  }
  const t = decryptToken(g.qrTokenCipher || undefined); // pre-separation guest: the one shared token
  return t && g.qrTokenHash && hashToken(t) === g.qrTokenHash ? t : null;
}

/** The raw ADMISSION credential currently held by the guest, or null. */
export function readAdmissionToken(g: TokenFields): string | null {
  const t = decryptToken(g.qrTokenCipher || undefined);
  return t && g.qrTokenHash && hashToken(t) === g.qrTokenHash ? t : null;
}

export interface InvitationTokenPlan { raw: string; hash: string; cipher: string; /** true when the guest record must be updated to hold it */ persist: boolean }

/** The invitation token to put in links: the guest's existing one (adopting a pre-separation shared token), or a new one. */
export function planInvitationToken(g: TokenFields): InvitationTokenPlan {
  const existing = readInvitationToken(g);
  if (existing) return { raw: existing, hash: hashToken(existing), cipher: g.invitationTokenHash ? (g.invitationTokenCipher as string) : encryptToken(existing), persist: !g.invitationTokenHash };
  const raw = generateSecureToken();
  return { raw, hash: hashToken(raw), cipher: encryptToken(raw), persist: true };
}
