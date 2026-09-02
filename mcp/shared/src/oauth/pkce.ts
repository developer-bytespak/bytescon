/**
 * PKCE (RFC 7636) S256 verification.
 *
 * The authorization server advertises S256 only and rejects `plain`, so a
 * client that downgrades the challenge method cannot complete the flow.
 */
import crypto from "node:crypto";

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))). */
export function computeS256Challenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Constant-time check that `verifier` matches `challenge` under S256.
 * Enforces the RFC 7636 verifier length bounds (43-128 chars).
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const computed = Buffer.from(computeS256Challenge(verifier));
  const provided = Buffer.from(challenge);
  if (computed.length !== provided.length) return false;
  return crypto.timingSafeEqual(computed, provided);
}
