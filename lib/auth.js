'use strict';
// Password auth + cookie sessions for remote access. Two levels:
//   listener — can browse and play (share this one with friends)
//   admin    — can also use /admin (uploads, edits, deletes)
// Passwords are stored as scrypt hashes in data/auth.json; sessions persist
// in data/sessions.json. Login attempts are rate-limited per IP.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days, sliding
const MAX_FAILS = 8;
const FAIL_WINDOW = 10 * 60 * 1000; // 10 minutes

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  const hash = crypto.scryptSync(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

class Auth {
  constructor(dataDir) {
    this.credsFile = path.join(dataDir, 'auth.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.creds = {};    // { listener: {salt,hash}, admin: {salt,hash} }
    this.sessions = {}; // token -> { role, expires }
    this.fails = new Map(); // ip -> { count, first }
    this._writeTimer = null;
    try { this.creds = JSON.parse(fs.readFileSync(this.credsFile, 'utf8')); } catch {}
    try {
      this.sessions = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      const now = Date.now();
      for (const [token, s] of Object.entries(this.sessions)) {
        if (!s.expires || s.expires < now) delete this.sessions[token];
      }
    } catch {}
  }

  hasPassword(role) {
    return !!this.creds[role];
  }

  setPassword(role, password) {
    this.creds[role] = hashPassword(password);
    fs.mkdirSync(path.dirname(this.credsFile), { recursive: true });
    fs.writeFileSync(this.credsFile, JSON.stringify(this.creds, null, 2), { mode: 0o600 });
  }

  // Returns 'admin' | 'listener' | null. Admin is checked first so the same
  // login box works for both.
  verify(password) {
    if (typeof password !== 'string' || !password) return null;
    if (verifyPassword(password, this.creds.admin)) return 'admin';
    if (verifyPassword(password, this.creds.listener)) return 'listener';
    return null;
  }

  _persistSessions() {
    clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessions), { mode: 0o600 });
    }, 250);
  }

  createSession(role) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[token] = { role, expires: Date.now() + SESSION_TTL };
    this._persistSessions();
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const s = this.sessions[token];
    if (!s) return null;
    if (s.expires < Date.now()) {
      delete this.sessions[token];
      this._persistSessions();
      return null;
    }
    // sliding expiry, refreshed at most daily to limit writes
    if (s.expires - Date.now() < SESSION_TTL - 24 * 3600 * 1000) {
      s.expires = Date.now() + SESSION_TTL;
      this._persistSessions();
    }
    return s;
  }

  destroySession(token) {
    if (token && this.sessions[token]) {
      delete this.sessions[token];
      this._persistSessions();
    }
  }

  // ---- login rate limiting

  blocked(ip) {
    const rec = this.fails.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.first > FAIL_WINDOW) { this.fails.delete(ip); return false; }
    return rec.count >= MAX_FAILS;
  }

  recordFail(ip) {
    const rec = this.fails.get(ip);
    if (rec && Date.now() - rec.first <= FAIL_WINDOW) rec.count++;
    else this.fails.set(ip, { count: 1, first: Date.now() });
  }

  clearFails(ip) {
    this.fails.delete(ip);
  }
}

function generatePassword() {
  // groups of unambiguous characters, easy to read out loud
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  return [0, 0, 0].map(() => pick() + pick() + pick() + pick()).join('-');
}

module.exports = { Auth, generatePassword };
