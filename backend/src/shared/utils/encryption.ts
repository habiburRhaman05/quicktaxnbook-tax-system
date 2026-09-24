import bcrypt from 'bcryptjs';
import crypto from 'crypto';

import config from '@/config/config';

// ---------------------------------------------------------------------------
// Passwords / OTP codes - one-way, slow hash (bcrypt)
// ---------------------------------------------------------------------------

/** Hash a password or OTP code before saving to the database. */
export const hashSecret = async (value: string): Promise<string> => {
  return bcrypt.hash(value, 10);
};

/** Compare a plaintext password/OTP against its stored hash. */
export const compareSecret = async (value: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(value, hash);
};

// Back-compat aliases used by earlier boilerplate call sites.
export const encryptPassword = hashSecret;
export const isPasswordMatch = compareSecret;

// ---------------------------------------------------------------------------
// Reversible PII encryption (SSN / EIN) - AES-256-GCM
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';

const getKey = (): Buffer => Buffer.from(config.security.encryptionKey, 'hex');

/** Encrypt a plaintext PII value (SSN, EIN...) for storage. Reversible. */
export const encryptPII = (plainText: string): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
};

/** Decrypt a value previously produced by encryptPII. */
export const decryptPII = (payload: string): string => {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

// ---------------------------------------------------------------------------
// Blind index - deterministic HMAC, used only for uniqueness lookups on PII
// ---------------------------------------------------------------------------

/** Strip everything but digits - used to normalize SSN/EIN before hashing. */
export const normalizeDigits = (value: string): string => value.replace(/\D/g, '');

export const lastDigits = (value: string, n = 4): string => {
  const digits = normalizeDigits(value);
  return digits.slice(-n);
};

/**
 * One-way HMAC-SHA256 blind index over normalized, labeled parts.
 * Used to detect duplicate Firm identities (EIN/SSN) without ever
 * storing or indexing the raw/encrypted value directly.
 */
export const blindIndex = (...labeledParts: Array<[string, string] | null | undefined>): string => {
  const normalized = labeledParts
    .filter((p): p is [string, string] => !!p && !!p[1])
    .map(([label, value]) => `${label}:${normalizeDigits(value)}`)
    .sort()
    .join('|');

  return crypto
    .createHmac('sha256', config.security.blindIndexPepper)
    .update(normalized)
    .digest('hex');
};

// ---------------------------------------------------------------------------
// Opaque tokens (sessions, onboarding links, invitations, password resets)
// ---------------------------------------------------------------------------

/** High-entropy URL-safe token to hand to the client (link/refresh token). */
export const generateSecureToken = (bytes = 32): string => {
  return crypto.randomBytes(bytes).toString('base64url');
};

/** Deterministic, fast hash for storing/looking-up opaque tokens (already high-entropy). */
export const hashToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// ---------------------------------------------------------------------------
// OTP codes
// ---------------------------------------------------------------------------

export const generateOtpCode = (length = 6): string => {
  const max = 10 ** length;
  const code = crypto.randomInt(0, max);
  return code.toString().padStart(length, '0');
};

// ---------------------------------------------------------------------------
// Random passwords (for admin-created team members / firm admins)
// ---------------------------------------------------------------------------

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';

/** Generates a secure, human-typeable random password meeting the app's password policy. */
export const generateRandomPassword = (length = 12): string => {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_CHARS[crypto.randomInt(0, PASSWORD_CHARS.length)];
  }
  // guarantee at least one letter and one digit per the password policy
  return `${out}A1`;
};
