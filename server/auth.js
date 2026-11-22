import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 30;
const COOKIE = 'lawlens_session';

let store;
export const useStore = (s) => (store = s);

async function hash(password, salt) {
  return (await scrypt(password, salt, 64)).toString('hex');
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const https = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = https ? 'SameSite=Lax; Secure' : 'SameSite=Lax';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; ${attrs}; Max-Age=${maxAgeSec}`);
}

async function startSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  await store.createSession(token, userId, Date.now() + SESSION_DAYS * 86400000);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

export const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, settings: u.settings || {} };

// Attaches req.user when a valid session cookie is present.
export async function sessionMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  try {
    if (token) {
      const user = await store.userForSession(token);
      if (user) {
        req.user = user;
        req.sessionToken = token;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}

// Naive per-IP limiter for auth endpoints.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  list.push(now);
  attempts.set(ip, list);
  return list.length > 20;
}

export async function register(req, res) {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  const { email, password, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (await store.findUserByEmail(email.trim())) return res.status(409).json({ error: 'An account with that email already exists.' });
  const salt = randomBytes(16).toString('hex');
  const user = await store.createUser({
    email: email.trim(),
    name: (name || '').trim().slice(0, 80) || null,
    pwHash: await hash(password, salt),
    salt,
  });
  await startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
}

export async function login(req, res) {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  const { email, password } = req.body || {};
  const user = email && (await store.findUserByEmail(email.trim()));
  const ok = user && password && timingSafeEqual(Buffer.from(await hash(password, user.salt), 'hex'), Buffer.from(user.pwHash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  await startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
}

export async function logout(req, res) {
  if (req.sessionToken) await store.deleteSession(req.sessionToken);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}
