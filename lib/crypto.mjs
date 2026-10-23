// Encryption at rest (AES-256-GCM) and signed session tokens (HMAC-SHA256).
import crypto from 'node:crypto';

function deriveKey(secret, purpose) {
  return crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();
}

export function encryptBytes(secret, bytes) {
  const key = deriveKey(secret, 'enc-v1');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: 1 byte version | 12 iv | 16 tag | data
  return Buffer.concat([Buffer.from([1]), iv, tag, data]);
}

export function decryptBytes(secret, blob) {
  const buf = Buffer.from(blob);
  if (buf[0] !== 1) throw new Error('Unknown encryption version');
  const key = deriveKey(secret, 'enc-v1');
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
}

export function encryptJSON(secret, obj) {
  return encryptBytes(secret, Buffer.from(JSON.stringify(obj), 'utf8'));
}

export function decryptJSON(secret, blob) {
  return JSON.parse(decryptBytes(secret, blob).toString('utf8'));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', deriveKey(secret, 'tok-v1')).update(body).digest();
  return `${body}.${b64u(mac)}`;
}

export function verifyToken(secret, token, expectedType) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', deriveKey(secret, 'tok-v1')).update(body).digest();
  const given = Buffer.from(mac || '', 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || payload.t !== expectedType) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

// Stable, non-reversible employee id so a re-uploaded roster still lines up with submissions.
export function employeeId(secret, slug, ssn, dob) {
  return crypto.createHmac('sha256', deriveKey(secret, 'emp-v1')).update(`${slug}|${ssn}|${dob}`).digest('hex').slice(0, 24);
}

export function hashForKey(secret, value) {
  return crypto.createHmac('sha256', deriveKey(secret, 'rl-v1')).update(String(value)).digest('hex').slice(0, 32);
}

export function safeEqualString(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function randomId(n = 8) {
  return crypto.randomBytes(n).toString('hex');
}
