import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 30;
const COOKIE = 'lawlens_session';

function hash(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
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
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function startSession(req, res, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    userId,
    Date.now() + SESSION_DAYS * 86400000,
  );
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

export const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, settings: JSON.parse(u.settings || '{}') };

// Attaches req.user when a valid session cookie is present.
export function sessionMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = db
      .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
      .get(token, Date.now());
    if (row) {
      req.user = row;
      req.sessionToken = token;
    }
  }
  next();
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

export function register(req, res) {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  const { email, password, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const salt = randomBytes(16).toString('hex');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, name, pw_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email.trim(), (name || '').trim().slice(0, 80) || null, hash(password, salt), salt, Date.now());
  startSession(req, res, Number(lastInsertRowid));
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) });
}

export function login(req, res) {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, try again later.' });
  const { email, password } = req.body || {};
  const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim());
  const ok =
    user && password && timingSafeEqual(Buffer.from(hash(password, user.salt), 'hex'), Buffer.from(user.pw_hash, 'hex'));
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
}

export function logout(req, res) {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}
