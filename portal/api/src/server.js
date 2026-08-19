import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { createDocumentRoutes } from './documents/routes.js';
import { createStore, resolveDriver } from './store/index.js';

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 8080);

// Preview mode: run the portal before Postgres exists.
//
// Everything that makes this safe for a team — accounts, per-developer virtual
// keys, saved history — lives in the database, so until it is provisioned there
// is nothing to authenticate against. `AUTH_DISABLED=true` drops the sign-in
// screen and serves one shared anonymous session: chat works, conversations
// live in this process's memory and are gone on restart, and the developer-key
// and usage pages stay closed because they have no user to be about.
//
// It must be asked for explicitly. Auto-enabling whenever DATABASE_URL happened
// to be missing would mean one unset Railway variable silently turns a private
// portal into an open one.
const PREVIEW_MODE = /^(1|true|yes)$/i.test(String(process.env.AUTH_DISABLED || '').trim());
const PREVIEW_USER = { id: '00000000-0000-4000-8000-000000000000', name: 'Preview session', email: 'preview@local' };

const JWT_SECRET = authSecret('JWT_SECRET');
const KEY_ENCRYPTION_SECRET = authSecret('KEY_ENCRYPTION_SECRET');
const SESSION_HOURS = Math.max(1, Number(process.env.SESSION_HOURS || 12));
const MAX_USERS = Math.min(100, Math.max(1, Number(process.env.MAX_USERS || 20)));
const REGISTRATION_ACCESS_CODE = authSecret('REGISTRATION_ACCESS_CODE');
const ALLOWED_EMAIL_DOMAIN = String(process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
const LITELLM_BASE_URL = String(process.env.LITELLM_BASE_URL || 'http://litellm:4000').replace(/\/$/, '');
const LITELLM_MASTER_KEY = requireSecret('LITELLM_MASTER_KEY');
const DEV_MODELS = ['auto', 'code', 'think', 'fast'];
const SYSTEM_PROMPT = `You are JSAN Dev AI, a senior software engineering copilot. Be concise, production-minded and practical. For code work, prioritize correctness, security, maintainability and verifiable next steps. State important assumptions. Never pretend to have executed or inspected something you have not. Prefer focused changes over unnecessary rewrites.`;
const DEV_MONTHLY_BUDGET = Number(process.env.DEVELOPER_MONTHLY_BUDGET_USD || 0);
const DEV_RPM_LIMIT = Number(process.env.DEVELOPER_RPM_LIMIT || 0);
const DEV_TPM_LIMIT = Number(process.env.DEVELOPER_TPM_LIMIT || 0);
// Storage. The driver (postgres | sqlite | memory) is chosen in ./store, and is
// opened during boot() below — every use of it happens inside a request handler,
// which runs long after that.
let store = null;
const DB_DRIVER = PREVIEW_MODE ? 'memory' : resolveDriver();

function requireSecret(name) {
  const value = String(process.env[name] || '').trim();
  if (!value || value.includes('change-me')) throw new Error(`${name} must be configured`);
  return value;
}

// Secrets that only exist to serve accounts: sessions to sign, stored keys to
// encrypt, registration to gate. Preview mode has none of those, so requiring
// them would block the very situation preview mode is for.
function authSecret(name) {
  return PREVIEW_MODE ? String(process.env[name] || '').trim() : requireSecret(name);
}

app.use(cookieParser());
app.use(express.json({ limit: '12mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Rate limiting.
//
// A whole team typically shares one public IP, so limits keyed only on IP are
// consumed by the group rather than the individual: 20 developers behind one
// office NAT would share a single 30-requests-per-minute chat allowance, and
// onboarding the team would stop after the tenth registration.
//
// Anything that runs after authentication is therefore keyed on the user id.
// Unauthenticated routes stay keyed on IP — that is what makes them useful
// against brute force — but are sized for a shared network, and login adds a
// second, strict per-account limit so one targeted account cannot be hammered
// under cover of the generous network-wide allowance.
const byIp = (req) => ipKeyGenerator(req.ip);

// Chat: per developer. `auth` runs before this limiter, so req.user is set.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'You are sending messages too quickly. Wait a moment and try again.' }
});

// Login, limit 1 of 2: per account. Only failures count, so a developer
// signing in normally never approaches it while brute force is stopped fast.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => String(req.body?.email || '').trim().toLowerCase() || byIp(req),
  message: { error: 'Too many failed sign-in attempts for this account. Try again in 15 minutes.' }
});

// Login, limit 2 of 2: per network. Sized so a full office can sign in each
// morning, while still capping credential stuffing across many accounts.
const loginIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  message: { error: 'Too many sign-in attempts from this network. Try again shortly.' }
});

// Document conversion: one request parses a PDF and then calls a model, so it
// costs far more than a chat turn and is metered much tighter. Per developer,
// for the same reason chat is.
const documentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? byIp(req),
  message: { error: 'Too many conversions in a row. Wait a few minutes and try again.' }
});

// Registration: per network, sized so the whole team can onboard in one
// sitting. The access code and the seat cap are the real controls here; this
// limit only exists to slow down guessing at the code.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  message: { error: 'Too many registration attempts from this network. Try again later.' }
});



function previewUnavailable(res, what) {
  return res.status(503).json({ error: `${what} needs the database, which is not provisioned yet.` });
}

function encryptionKey() {
  return crypto.createHash('sha256').update(KEY_ENCRYPTION_SECRET).digest();
}
function encryptText(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decryptKey(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.litellm_key_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.litellm_key_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.litellm_key_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function createSession(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h`, issuer: 'jsan-dev-ai' });
}
function setSessionCookie(res, token) {
  res.cookie('jsan_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
    path: '/'
  });
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanError(error, fallback = 'Something went wrong') {
  const raw = String(error?.message || error || '');
  if (/budget/i.test(raw)) return 'Your AI usage limit has been reached. Contact the platform owner if you need more access.';
  if (/rate.?limit|429/i.test(raw)) return 'AI is busy right now. Try again in a moment.';
  if (/authentication|api.?key|401|403/i.test(raw)) return 'AI access needs attention. Please contact the platform owner.';
  return fallback;
}

async function litellmFetch(endpoint, { method = 'GET', body, key = LITELLM_MASTER_KEY, timeout = 20000 } = {}) {
  const response = await fetch(`${LITELLM_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) {
    const message = data?.detail?.error || data?.detail || data?.error?.message || data?.message || text || `LiteLLM ${response.status}`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}

/**
 * The key a developer's model calls are billed to.
 *
 * Preview mode has no per-developer key to decrypt, so the gateway is called
 * with the master key. Either way it stays server-side: the portal makes the
 * model call itself and never hands a key to a browser.
 */
function modelKeyFor(user) {
  if (PREVIEW_MODE) return LITELLM_MASTER_KEY;
  // A developer registered while the gateway had no key store has no personal
  // key to decrypt. Their chat still works on the gateway key, which stays
  // server-side. Only an absent key falls back — a key that fails to decrypt
  // still raises, because that means something is wrong rather than pending.
  if (!user?.litellm_key_ciphertext) return LITELLM_MASTER_KEY;
  return decryptKey(user);
}

/** True when this developer has a personal key of their own. */
function hasPersonalKey(user) {
  return !!user?.litellm_key_ciphertext;
}

function personalKeyPending(res) {
  return res.status(503).json({
    error: 'Your personal developer key has not been issued yet. The AI gateway needs its own database before it can create per-developer keys — chat and slides work in the meantime.',
    reason: 'personal-key-pending'
  });
}

/** One chat completion through the gateway. Shared by chat and document generation. */
async function callModel({ key, model, messages, user, timeout = 120000 }) {
  const upstream = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, ...(user ? { user } : {}) }),
    signal: AbortSignal.timeout(timeout)
  });
  const raw = await upstream.text();
  let data; try { data = JSON.parse(raw); } catch { data = {}; }
  if (!upstream.ok) throw new Error(data?.error?.message || data?.detail?.error || raw.slice(0, 500));
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Ask the gateway for a personal virtual key for a new developer.
 *
 * LiteLLM keeps its virtual keys in its own Postgres database, so a gateway
 * running without one — the normal case while the portal is on local SQLite —
 * cannot issue them. That must not block registration: the account is created
 * with no stored key, the developer's model calls fall back to the gateway key
 * held server-side, and the Tools page tells them the personal key is pending.
 * `key: null` is the signal for all of that.
 */
async function provisionLiteLLMUser({ id, name, email }) {
  try {
    return await issueLiteLLMKey({ id, name, email });
  } catch (error) {
    console.warn(`LiteLLM could not issue a personal key for ${email}: ${error.message}`);
    return { litellmUserId: id, key: null };
  }
}

async function issueLiteLLMKey({ id, name, email }) {
  const userResult = await litellmFetch('/user/new', {
    method: 'POST',
    body: { user_id: id, user_email: email, user_alias: name, user_role: 'internal_user' }
  });
  const litellmUserId = userResult?.user_id || id;
  const keyBody = {
    user_id: litellmUserId,
    key_alias: `jsan-${email}`,
    models: DEV_MODELS,
    metadata: { app: 'jsan-dev-ai', email }
  };
  if (DEV_MONTHLY_BUDGET > 0) {
    keyBody.max_budget = DEV_MONTHLY_BUDGET;
    keyBody.budget_duration = '30d';
  }
  if (DEV_RPM_LIMIT > 0) keyBody.rpm_limit = DEV_RPM_LIMIT;
  if (DEV_TPM_LIMIT > 0) keyBody.tpm_limit = DEV_TPM_LIMIT;
  const keyResult = await litellmFetch('/key/generate', { method: 'POST', body: keyBody });
  const key = keyResult?.key || keyResult?.token;
  if (!key) throw new Error('LiteLLM did not return a virtual key');
  return { litellmUserId, key };
}

async function getUserById(id) {
  return await store.findUserById(id);
}
async function sessionUser(req) {
  const token = req.cookies.jsan_session;
  if (!token) return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET, { issuer: 'jsan-dev-ai' });
    return await getUserById(claims.sub);
  } catch { return null; }
}
async function auth(req, res, next) {
  // Preview mode: one shared anonymous session, since there are no accounts.
  if (PREVIEW_MODE) { req.user = PREVIEW_USER; return next(); }
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
}

app.get('/api/health', async (_req, res) => {
  let db = false, gateway = false, registeredUsers = 0;
  if (!PREVIEW_MODE) {
    try {
      registeredUsers = await store.countUsers();
      db = true;
    } catch {}
  }
  try {
    await litellmFetch('/v1/models', { timeout: 5000 });
    gateway = true;
  } catch {}
  // In preview mode the database is knowingly absent, so the gateway alone
  // decides health — otherwise Railway would restart a service that is doing
  // exactly what it was configured to do.
  res.json({ ok: PREVIEW_MODE ? gateway : (db && gateway), db, driver: DB_DRIVER, gateway, previewMode: PREVIEW_MODE, registeredUsers, maxUsers: MAX_USERS, registrationOpen: !PREVIEW_MODE && registeredUsers < MAX_USERS });
});

app.get('/api/auth/registration-status', async (_req, res) => {
  if (PREVIEW_MODE) return res.json({ previewMode: true, registeredUsers: 0, maxUsers: MAX_USERS, remaining: 0, registrationOpen: false });
  const count = await store.countUsers();
  res.json({ registeredUsers: count, maxUsers: MAX_USERS, remaining: Math.max(0, MAX_USERS - count), registrationOpen: count < MAX_USERS });
});

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  if (PREVIEW_MODE) return previewUnavailable(res, 'Creating an account');
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const accessCode = String(req.body?.accessCode || '');

  if (!safeEqual(accessCode, REGISTRATION_ACCESS_CODE)) return res.status(403).json({ error: 'The team access code is not valid' });
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid work email' });
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) return res.status(400).json({ error: `Use your ${ALLOWED_EMAIL_DOMAIN} email` });
  if (password.length < 10) return res.status(400).json({ error: 'Use at least 10 characters for your password' });

  try {
    // Checked cheaply first so the common mistakes fail before doing any work.
    // The authoritative check is inside store.createUser, which holds a lock for
    // it — provisioning a gateway key is a network call and must not run inside
    // that transaction, or every registration would queue behind it.
    if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'An account already exists for this email' });
    if (await store.countUsers() >= MAX_USERS) return res.status(409).json({ error: 'Registration is full' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    const provision = await provisionLiteLLMUser({ id, name, email });

    const created = await store.createUser({
      id,
      name,
      email,
      passwordHash,
      litellmUserId: provision.litellmUserId,
      key: provision.key ? encryptText(provision.key) : null,
      maxUsers: MAX_USERS
    });
    if (!created.ok) {
      return res.status(409).json({
        error: created.reason === 'full' ? 'Registration is full' : 'An account already exists for this email'
      });
    }

    const user = { id, name, email };
    setSessionCookie(res, createSession(user));
    return res.status(201).json({ user, personalKeyIssued: !!provision.key });
  } catch (e) {
    console.error('Registration failed:', e.message);
    return res.status(502).json({ error: cleanError(e, 'Could not create the account. Please try again or contact the platform owner.') });
  }
});

app.post('/api/auth/login', loginIpLimiter, loginAccountLimiter, async (req, res) => {
  if (PREVIEW_MODE) return previewUnavailable(res, 'Signing in');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = await store.findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
  await store.touchLastLogin(user.id);
  setSessionCookie(res, createSession(user));
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('jsan_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, previewMode: PREVIEW_MODE }));

// Developer keys are per account and are issued by LiteLLM at registration, so
// they cannot exist in preview mode. The master key is never an answer here: it
// would go to a browser, and it is the one credential that must not.
app.get('/api/me/api-key', auth, (req, res) => {
  if (PREVIEW_MODE) return previewUnavailable(res, 'Your personal developer key');
  if (!hasPersonalKey(req.user)) return personalKeyPending(res);
  try { res.json({ apiKey: decryptKey(req.user) }); }
  catch { res.status(500).json({ error: 'Could not read your developer key' }); }
});

app.post('/api/me/api-key/rotate', auth, async (req, res) => {
  if (PREVIEW_MODE) return previewUnavailable(res, 'Key rotation');
  if (!hasPersonalKey(req.user)) return personalKeyPending(res);
  try {
    const oldKey = decryptKey(req.user);
    const result = await litellmFetch('/key/regenerate', { method: 'POST', body: { key: oldKey } });
    const newKey = result?.key || result?.token;
    if (!newKey) throw new Error('LiteLLM did not return the regenerated key');
    const encrypted = encryptText(newKey);
    await store.updateUserKey(req.user.id, encrypted);
    res.json({ apiKey: newKey });
  } catch (e) {
    console.error('Key rotation failed:', e.message);
    res.status(502).json({ error: cleanError(e, 'Could not rotate your key') });
  }
});

app.get('/api/conversations', auth, async (req, res) => {
  res.json(await store.listConversations(req.user.id));
});
app.get('/api/conversations/:id', auth, async (req, res) => {
  const conversation = await store.getConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ...conversation, messages: await store.getMessages(req.params.id) });
});
app.delete('/api/conversations/:id', auth, async (req, res) => {
  await store.deleteConversation(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/chat', auth, chatLimiter, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const mode = String(req.body?.mode || 'auto');
  const conversationId = req.body?.conversationId;
  if (!message) return res.status(400).json({ error: 'Write a message first' });
  if (!DEV_MODELS.includes(mode)) return res.status(400).json({ error: 'Unknown mode' });

  // U+FFFD only appears when bytes failed to decode as text, so a pile of them
  // means a binary file was read as text somewhere upstream. The model cannot
  // read that, and it would still be billed for every token of it.
  const undecodable = (message.match(/\uFFFD/g) || []).length;
  if (undecodable > 50) {
    return res.status(400).json({ error: 'That attachment is not readable text, so the AI cannot use it. Attach a text or code file, or paste the content directly.' });
  }

  let cid = conversationId;
  let createdConversation = false;
  if (!cid) {
    cid = crypto.randomUUID();
    const title = message.replace(/\s+/g, ' ').slice(0, 64);
    await store.createConversation({ id: cid, userId: req.user.id, title, mode });
    createdConversation = true;
  } else {
    if (!await store.getConversation(cid, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
    await store.touchConversation(cid, mode);
  }

  const userMessageId = await store.addMessage({ conversationId: cid, role: 'user', content: message });
  const history = await store.getMessages(cid, 60);

  try {
    const answer = await callModel({
      key: modelKeyFor(req.user),
      model: mode,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history.map(x => ({ role: x.role, content: x.content }))],
      user: req.user.id
    }) || 'The model returned an empty response.';
    await store.addMessage({ conversationId: cid, role: 'assistant', content: answer });
    await store.touchConversation(cid);
    res.json({ conversationId: cid, answer });
  } catch (e) {
    console.error('Chat failed:', e.message);
    // Undo this request's writes so a failed send leaves nothing behind. The web
    // app puts the text back in the composer to be retried; if the row survived,
    // the retry would store a second copy and leave an unanswered turn in the
    // history for the model to trip over.
    if (userMessageId) await store.deleteMessage(userMessageId).catch(() => {});
    if (createdConversation) await store.deleteConversation(cid, req.user.id).catch(() => {});
    res.status(502).json({ error: cleanError(e, 'AI is unavailable right now. Try again shortly.') });
  }
});

app.get('/api/usage/me', auth, async (req, res) => {
  // Spend is tracked against a developer's own key, so there is nothing
  // meaningful to report for a shared anonymous session.
  if (PREVIEW_MODE) return previewUnavailable(res, 'Per-developer usage');
  if (!hasPersonalKey(req.user)) return personalKeyPending(res);
  try {
    const key = decryptKey(req.user);
    const info = await litellmFetch('/user/info', { key, timeout: 10000 });
    const userInfo = info?.user_info || info?.user || info || {};
    res.json({
      spend: Number(userInfo.spend || 0),
      maxBudget: userInfo.max_budget == null ? null : Number(userInfo.max_budget),
      budgetDuration: userInfo.budget_duration || null,
      models: DEV_MODELS,
      rpmLimit: userInfo.rpm_limit || DEV_RPM_LIMIT || null,
      tpmLimit: userInfo.tpm_limit || DEV_TPM_LIMIT || null
    });
  } catch (e) {
    console.error('Usage lookup failed:', e.message);
    res.status(502).json({ error: 'Usage is temporarily unavailable' });
  }
});

app.get('/api/tools/config', auth, (_req, res) => {
  const base = String(process.env.PUBLIC_BASE_URL || 'https://ai.jsanconsulting.com').replace(/\/$/, '');
  res.json({
    baseUrl: `${base}/v1`,
    codex: `model = "code"\nmodel_provider = "jsan"\n\n[model_providers.jsan]\nname = "JSAN Dev AI"\nbase_url = "${base}/v1"\nenv_key = "JSAN_AI_KEY"\nwire_api = "responses"`,
    claude: `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=<your developer key>\nclaude`,
    env: `OPENAI_BASE_URL=${base}/v1\nOPENAI_API_KEY=<your developer key>`,
    curl: `curl ${base}/v1/models -H "Authorization: Bearer <your developer key>"`
  });
});

// Document generation (PDF -> PPTX today). Auth, metering and the model call are
// passed in so the feature stays self-contained under src/documents.
app.use('/api/documents', createDocumentRoutes({
  auth,
  limiter: documentLimiter,
  callModel,
  modelKeyFor
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, '../../web/dist');
// Public developer API edge. LiteLLM itself stays private on Railway.
// This preserves streaming and lets Codex / Claude Code / SDKs use one JSAN domain.
app.use('/v1', async (req, res) => {
  try {
    const upstreamUrl = `${LITELLM_BASE_URL}/v1${req.originalUrl.slice('/v1'.length)}`;
    const headers = {};
    for (const name of ['authorization', 'content-type', 'anthropic-version', 'anthropic-beta', 'openai-organization', 'openai-project']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const body = hasBody && req.body != null
      ? (Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body))
      : undefined;
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    res.status(upstream.status);
    for (const [name, value] of upstream.headers.entries()) {
      if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (error) {
    console.error('Gateway proxy failed:', error.message);
    if (!res.headersSent) res.status(502).json({ error: 'AI gateway is temporarily unavailable' });
    else res.end();
  }
});

app.use(express.static(staticDir, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(staticDir, 'index.html'));
  next();
});

// This is a JSON API, but an oversized or malformed request body is rejected by
// the body parser before any route runs, and Express answers those with an HTML
// error page the web app cannot read. Translate them so the browser always has
// a message to show.
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large. PDFs must be under 8 MB.' });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'That request could not be read.' });
  }
  console.error('Unhandled request error:', error?.message || error);
  res.status(500).json({ error: 'Something went wrong' });
});

async function boot() {
  store = await createStore({ previewMode: PREVIEW_MODE });
  await store.initSchema();

  if (PREVIEW_MODE) {
    console.warn('AUTH_DISABLED=true — PREVIEW MODE. No sign-in: every visitor shares one anonymous session and the gateway budget behind it.');
    console.warn('Conversations are kept in this process only and are lost on restart. Provision a database and remove AUTH_DISABLED before inviting developers.');
  } else {
    console.log(`Storage: ${store.describe()}`);
    if (store.driver === 'sqlite') {
      console.warn('SQLite is a single local file — suitable for local development, not for a deployed team. Move to Postgres before inviting developers.');
    }
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`JSAN Dev AI listening on ${PORT}${PREVIEW_MODE ? ' (preview mode)' : ''}`));
}

boot().catch(err => { console.error(err); process.exit(1); });
