import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

// Tokens are only as secret as this key. The dev fallback is public (it's in
// the repo), so a production boot without a real secret means anyone can forge
// a token for any user in any org — refuse to start rather than fail silently.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET must be set in production.\n' +
    'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
  );
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.warn('⚠  JWT_SECRET not set — using the public dev fallback. Do not use this in production.');
}

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, org: user.org_id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

export function registerOrg({ orgName, name, email, password }) {
  if (!orgName || !name || !email || !password) throw httpError(400, 'All fields are required');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw httpError(409, 'An account with that email already exists');
  const org = db.prepare('INSERT INTO orgs (name) VALUES (?)').run(orgName);
  const hash = bcrypt.hashSync(password, 10);
  const res = db
    .prepare("INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'dispatcher')")
    .run(org.lastInsertRowid, email.toLowerCase(), hash, name);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(res.lastInsertRowid);
}

export function createDriver(orgId, { name, email, password }) {
  if (!name || !email || !password) throw httpError(400, 'Name, email, and password are required');
  if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw httpError(409, 'An account with that email already exists');
  const hash = bcrypt.hashSync(password, 10);
  const res = db
    .prepare("INSERT INTO users (org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'driver')")
    .run(orgId, email.toLowerCase(), hash, name);
  return db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(res.lastInsertRowid);
}

export function login({ email, password }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw httpError(401, 'Invalid email or password');
  }
  return user;
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired — sign in again' });
  }
}

export function roleRequired(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) return res.status(403).json({ error: `Requires ${role} role` });
    next();
  };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
