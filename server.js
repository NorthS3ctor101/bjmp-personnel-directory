'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const path     = require('path');
const crypto   = require('crypto');

const app = express();
app.disable('x-powered-by');

const PORT        = process.env.PORT        || 3000;
const GAS_URL     = process.env.GAS_WEB_APP_URL;
const TOTP_SECRET = process.env.TOTP_SECRET;
const GAS_SECRET  = process.env.GAS_SHARED_SECRET;

if (!GAS_URL || !TOTP_SECRET || !GAS_SECRET) {
  console.error('FATAL: Missing required environment variables.');
  process.exit(1);
}

const SESSION_TTL_MS = 30 * 60 * 1000;
const activeSessions = new Map();

function createSession() {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  activeSessions.set(token, { expiresAt });
  return token;
}

function validateSession(token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  if (token) activeSessions.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of activeSessions.entries()) {
    if (now > session.expiresAt) activeSessions.delete(token);
  }
}, 5 * 60 * 1000);

const RATE = {
  WINDOW_MS:    15 * 60 * 1000,
  MAX_ATTEMPTS: 10,
  LOCKOUT_MS:   15 * 60 * 1000,
};
const rateLimitStore = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const raw = fwd ? fwd.split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
  return raw.replace('::ffff:', '').replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
}

function checkRateLimit(ip) {
  const now = Date.now();
  let r = rateLimitStore.get(ip) || { count: 0, windowStart: now, lockedUntil: 0 };
  rateLimitStore.set(ip, r);

  if (r.lockedUntil && now < r.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((r.lockedUntil - now) / 1000) };
  }
  if (now - r.windowStart > RATE.WINDOW_MS) {
    r.count = 0; r.windowStart = now; r.lockedUntil = 0;
  }
  r.count++;
  if (r.count > RATE.MAX_ATTEMPTS) {
    r.lockedUntil = now + RATE.LOCKOUT_MS;
    return { allowed: false, retryAfter: Math.ceil(RATE.LOCKOUT_MS / 1000) };
  }
  return { allowed: true };
}

function decodeBase32(b32) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = b32.replace(/\s+|=/g, '').toUpperCase();
  const buf   = Buffer.alloc(Math.floor(clean.length * 5 / 8));
  let bits = 0, val = 0, idx = 0;
  for (const ch of clean) {
    const v = CHARS.indexOf(ch);
    if (v === -1) continue;
    val = (val << 5) | v; bits += 5;
    if (bits >= 8) { buf[idx++] = (val >> (bits - 8)) & 0xff; bits -= 8; }
  }
  return buf;
}

function generateTOTP(secret, counter) {
  const key = decodeBase32(secret);
  const buf = Buffer.alloc(8);
  let tmp = BigInt(counter);
  for (let i = 7; i >= 0; i--) { buf[i] = Number(tmp & 0xffn); tmp >>= 8n; }
  const hmac   = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code   = ((hmac[offset]     & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) <<  8) |
                  (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

function verifyTOTP(token, secret) {
  if (!secret || !token || !/^\d{6}$/.test(token)) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const expected = Buffer.from(generateTOTP(secret, counter + d));
    const actual   = Buffer.from(token);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'blob:'],
      fontSrc:        ["'self'"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy:            { policy: 'strict-origin-when-cross-origin' },
  frameguard:                { action: 'deny' },
  noSniff:                   true,
  hsts:                      { maxAge: 31536000, includeSubDomains: true, preload: true },
}));

app.use(cors({ origin: false }));
app.use(express.json({ limit: '10kb' }));

app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

app.get('/login.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.css')));
app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'script.js')));

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

function requireSession(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!validateSession(token)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or expired session.' });
  }
  req.sessionToken = token;
  next();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/verify', async (req, res) => {
  const ip    = getClientIp(req);
  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).json({
      success: false,
      message: `Too many attempts. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`,
    });
  }

  const { totpCode, machineInfo } = req.body;

  if (!totpCode || typeof totpCode !== 'string' || !/^\d{6}$/.test(totpCode.trim())) {
    return res.status(400).json({ success: false, message: 'Invalid code format.' });
  }

  if (!verifyTOTP(totpCode.trim(), TOTP_SECRET)) {
    return res.status(401).json({ success: false, message: 'Invalid or expired authentication code.' });
  }

  const rawMachine   = typeof machineInfo === 'string' ? machineInfo : 'Unknown';
  const cleanMachine = rawMachine.replace(/[\r\n\t|]/g, ' ').slice(0, 200);
  const logEntry     = `${cleanMachine} | IP: ${ip}`;
  const timestamp    = Date.now().toString();
  const hmacSig      = crypto.createHmac('sha256', GAS_SECRET)
                             .update(timestamp + logEntry)
                             .digest('hex');

  try {
    const response = await fetch(GAS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ machineInfo: logEntry, timestamp, signature: hmacSig }),
      signal:  AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    if (!data.success) {
      console.error('GAS log rejected:', data.message);
      return res.status(502).json({ success: false, message: 'Backend logging error.' });
    }
  } catch (err) {
    console.error('GAS log error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error during authentication.' });
  }

  const sessionToken = createSession();
  return res.json({ success: true, sessionToken, expiresIn: SESSION_TTL_MS / 1000 });
});

app.post('/api/logout', (req, res) => {
  destroySession(req.headers['x-session-token']);
  return res.json({ success: true });
});

app.get('/api/records', requireSession, async (req, res) => {
  try {
    const response = await fetch(GAS_URL, { signal: AbortSignal.timeout(15_000) });
    const data     = await response.json();
    return res.json(data);
  } catch (err) {
    console.error('Data proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve records.' });
  }
});

app.get('*', (req, res) => {
  res.redirect('/login.html');
});

app.listen(PORT, () => {
  console.log(`PRMIS server on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
