import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Runway-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 10000);

// تشخیص هوشمند و دقیق مسیر index.html در تمامی ساختارها
function getIndexFilePath() {
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(process.cwd(), 'index.html'),
    path.join(process.cwd(), 'public', 'index.html')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

const DB = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

const cfg = {
  adminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || 'CHANGE_THIS_STRONG_PASSWORD',
  runwayKey: process.env.RUNWAYML_API_SECRET || '',
  runwayBase: (process.env.RUNWAY_API_BASE || 'https://api.dev.runwayml.com/v1').replace(/\/$/, ''),
  freeUrl: (process.env.FREE_ENGINE_URL || '').replace(/\/$/, ''),
  freeKey: process.env.FREE_ENGINE_API_KEY || '',
  freeMode: (process.env.FREE_ENGINE_MODE || 'legacy').trim().toLowerCase(),
  freeEndpoint: (process.env.FREE_ENGINE_ENDPOINT || 'generate').replace(/^\//, '').replace(/\/$/, ''),
  zMerchant: process.env.ZARINPAL_MERCHANT_ID || '',
  zCallback: process.env.ZARINPAL_CALLBACK_URL || '',
  zBase: (process.env.ZARINPAL_API_BASE || 'https://api.zarinpal.com/pg/v4/payment').replace(/\/$/, ''),
  price: Number(process.env.PRICE_PER_VIDEO || 10000),
  userFree: Number(process.env.DAILY_FREE_USER || 5),
  adminFree: Number(process.env.DAILY_FREE_ADMIN || 80),
  currency: process.env.CURRENCY || 'IRT'
};

function ensure() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  if (!fs.existsSync(DB)) {
    fs.writeFileSync(DB, JSON.stringify({ users: [], payments: [], jobs: [], settings: { bankName: '', accountHolder: '', cardNumber: '', iban: '', bankNote: '' } }, null, 2));
  }
}

function db() {
  ensure();
  let d;
  try { d = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { d = { users: [], payments: [], jobs: [], settings: {} }; }
  d.users ??= [];
  d.payments ??= [];
  d.jobs ??= [];
  d.settings ??= {};
  return d;
}

function save(d) { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); }
function hash(p, s = crypto.randomBytes(16).toString('hex')) { return `${s}:${crypto.scryptSync(p, s, 64).toString('hex')}`; }
function check(p, h) {
  try {
    const [s, x] = String(h).split(':');
    if (!s || !x) return false;
    const a = Buffer.from(x, 'hex'), b = crypto.scryptSync(p, s, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function uid() { return crypto.randomBytes(12).toString('hex'); }
function token(id) { return Buffer.from(`${id}.${Date.now()}.${crypto.randomBytes(24).toString('hex')}`).toString('base64url'); }

const sessions = new Map();

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(t);
  if (!s) return res.status(401).json({ error: 'نیاز به ورود دارید.' });
  const d = db();
  const u = d.users.find(x => x.id === s.id);
  if (!u) return res.status(401).json({ error: 'کاربر یافت نشد.' });
  req.user = u;
  req.db = d;
  req.token = t;
  next();
}

function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'دسترسی فقط برای Admin مجاز است.' });
  next();
}

function day() { return new Date().toISOString().slice(0, 10); }
function usage(d, u) {
  const ds = day();
  const n = d.jobs.filter(j => j.userId === u.id && j.day === ds && ['PROCESSING', 'SUCCEEDED'].includes(j.status)).length;
  return { date: ds, used: n, limit: u.role === 'admin' ? cfg.adminFree : cfg.userFree, unlimited: u.role === 'admin' };
}
function publicUser(d, u) { return { id: u.id, email: u.email, role: u.role, wallet: Number(u.wallet || 0), usage: usage(d, u) }; }
function chargeFor(u, d) {
  const q = usage(d, u);
  if (q.unlimited || q.used < q.limit) return 0;
  return cfg.price;
}
async function callJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let x = {};
  try { x = await r.json(); } catch {}
  if (!r.ok) throw Error(x?.error?.message || x?.errors?.message || x?.error || `HTTP ${r.status}`);
  return x;
}
function safePublicSettings(d) {
  return { bankName: d.settings.bankName || '', accountHolder: d.settings.accountHolder || '', cardNumber: d.settings.cardNumber || '', iban: d.settings.iban || '', bankNote: d.settings.bankNote || '' };
}

// Routes API
app.get('/api/health', (req, res) => res.json({ ok: true, configured: Boolean(cfg.runwayKey), freeEngineConfigured: Boolean(cfg.freeUrl), freeEngineMode: cfg.freeMode, freeEngineEndpoint: cfg.freeEndpoint, model: 'seedance2_5', minDuration: 4, maxDuration: 30, dailyFreeUser: cfg.userFree, dailyFreeAdmin: cfg.adminFree, pricePerVideo: cfg.price, currency: cfg.currency, zarinpalConfigured: Boolean(cfg.zMerchant && cfg.zCallback) }));

app.post('/api/auth/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return res.status(400).json({ error: 'ایمیل معتبر و رمز عبور حداقل ۶ کاراکتری لازم است.' });
  const d = db();
  if (d.users.some(u => u.email === email)) return res.status(409).json({ error: 'این کاربر قبلاً ثبت شده است.' });
  const u = { id: uid(), email, passwordHash: hash(password), role: 'user', wallet: 0, createdAt: Date.now() };
  d.users.push(u);
  save(d);
  const t = token(u.id);
  sessions.set(t, { id: u.id });
  res.json({ token: t, user: publicUser(d, u) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const d = db();
  let u = d.users.find(x => x.email === email);
  if (!u && email === cfg.adminEmail) {
    u = { id: 'admin', email: cfg.adminEmail, passwordHash: hash(cfg.adminPassword), role: 'admin', wallet: 0, createdAt: Date.now() };
    d.users.push(u);
    save(d);
  }
  if (!u || !check(password, u.passwordHash)) return res.status(401).json({ error: 'ایمیل یا رمز عبور نادرست است.' });
  const t = token(u.id);
  sessions.set(t, { id: u.id });
  res.json({ token: t, user: publicUser(d, u) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.db, req.user) }));
app.post('/api/auth/logout', auth, (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });

app.get('/api/wallet', auth, (req, res) => res.json({ wallet: Number(req.user.wallet || 0), usage: usage(req.db, req.user), pricePerVideo: cfg.price, currency: cfg.currency, bank: safePublicSettings(req.db) }));
app.get('/api/jobs', auth, (req, res) => res.json({ jobs: req.db.jobs.filter(x => x.userId === req.user.id).slice(0, 100) }));
app.get('/api/payments', auth, (req, res) => res.json({ payments: req.db.payments.filter(x => x.userId === req.user.id).slice(0, 100) }));

app.post('/api/payment/zarinpal/request', auth, async (req, res) => {
  const amount = Math.floor(Number(req.body.amount || 0));
  if (!Number.isFinite(amount) || amount < 1000) return res.status(400).json({ error: 'مبلغ شارژ حداقل ۱۰۰۰ است.' });
  if (!cfg.zMerchant || !cfg.zCallback) return res.status(503).json({ error: 'زرین‌پال هنوز در تنظیمات سرور فعال نشده است.' });
  const d = req.db, id = uid();
  const p = { id, userId: req.user.id, amount, currency: cfg.currency, status: 'PENDING', createdAt: Date.now() };
  d.payments.push(p);
  save(d);
  try {
    const r = await callJson(`${cfg.zBase}/request.json`, { merchant_id: cfg.zMerchant, amount, callback_url: `${cfg.zCallback}${cfg.zCallback.includes('?') ? '&' : '?'}payment_id=${id}`, description: `شارژ کیف پول Ayaz - ${req.user.email}`, metadata: { email: req.user.email } });
    const authority = r?.data?.authority;
    if (!authority) throw Error(r?.errors?.message || 'Authority دریافت نشد.');
    p.authority = authority;
    save(d);
    res.json({ ok: true, paymentId: id, authority, url: `https://www.zarinpal.com/pg/StartPay/${authority}` });
  } catch (e) {
    p.status = 'FAILED';
    p.error = e.message;
    save(d);
    res.status(502).json({ error: 'خطا در ایجاد پرداخت زرین‌پال: ' + e.message });
  }
});

app.get('/api/payment/zarinpal/callback', async (req, res) => {
  const id = String(req.query.payment_id || ''), authority = String(req.query.Authority || ''), status = String(req.query.Status || '');
  const d = db(), p = d.payments.find(x => x.id === id);
  if (!p) return res.status(404).send('تراکنش پیدا نشد.');
  if (p.status === 'PAID') return res.send('این تراکنش قبلاً تأیید شده است.');
  if (status !== 'OK') { p.status = 'CANCELED'; save(d); return res.send('پرداخت لغو شد.'); }
  try {
    const r = await callJson(`${cfg.zBase}/verify.json`, { merchant_id: cfg.zMerchant, authority, amount: p.amount });
    const code = Number(r?.data?.code);
    if (code === 100 || code === 101) {
      p.status = 'PAID';
      p.refId = r?.data?.ref_id || null;
      p.verifiedAt = Date.now();
      const u = d.users.find(x => x.id === p.userId);
      if (u) u.wallet = Number(u.wallet || 0) + p.amount;
      save(d);
      return res.send('پرداخت موفق بود. کیف پول شما شارژ شد؛ به پنل بازگردید.');
    }
    p.status = 'FAILED';
    p.error = r?.errors?.message || `کد تأیید ${code}`;
    save(d);
    res.send('پرداخت تأیید نشد.');
  } catch (e) {
    p.status = 'FAILED';
    p.error = e.message;
    save(d);
    res.status(502).send('خطا در تأیید پرداخت: ' + e.message);
  }
});

app.get('/api/admin/overview', auth, admin, (req, res) => {
  const d = req.db;
  res.json({
    users: d.users.map(u => ({ id: u.id, email: u.email, role: u.role, wallet: Number(u.wallet || 0), usage: usage(d, u), createdAt: u.createdAt })),
    payments: d.payments.slice(0, 200),
    jobs: d.jobs.slice(0, 200),
    settings: { dailyFreeUser: cfg.userFree, dailyFreeAdmin: cfg.adminFree, pricePerVideo: cfg.price, currency: cfg.currency, freeEngineConfigured: Boolean(cfg.freeUrl), freeEngineMode: cfg.freeMode, freeEngineEndpoint: cfg.freeEndpoint, runwayConfigured: Boolean(cfg.runwayKey), zarinpalConfigured: Boolean(cfg.zMerchant && cfg.zCallback), bank: safePublicSettings(d) }
  });
});

app.post('/api/admin/users/:id/credit', auth, admin, (req, res) => {
  const d = req.db, u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'کاربر یافت نشد.' });
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'مبلغ نامعتبر است.' });
  u.wallet = Number(u.wallet || 0) + amount;
  d.payments.unshift({ id: uid(), userId: u.id, amount, currency: cfg.currency, status: 'ADMIN_ADJUSTMENT', createdAt: Date.now() });
  save(d);
  res.json({ ok: true, user: publicUser(d, u) });
});

app.post('/api/admin/users/:id/role', auth, admin, (req, res) => {
  const d = req.db, u = d.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'کاربر یافت نشد.' });
  if (u.id === req.user.id && req.body.role !== 'admin') return res.status(400).json({ error: 'حساب Admin فعلی را نمی‌توان به کاربر عادی تبدیل کرد.' });
  u.role = req.body.role === 'admin' ? 'admin' : 'user';
  save(d);
  res.json({ ok: true, user: publicUser(d, u) });
});

app.post('/api/admin/settings/bank', auth, admin, (req, res) => {
  const d = req.db;
  d.settings = { ...d.settings, bankName: String(req.body.bankName || '').trim(), accountHolder: String(req.body.accountHolder || '').trim(), cardNumber: String(req.body.cardNumber || '').trim(), iban: String(req.body.iban || '').trim(), bankNote: String(req.body.bankNote || '').trim() };
  save(d);
  res.json({ ok: true, bank: safePublicSettings(d) });
});

async function freeGenerate(body) {
  if (!cfg.freeUrl) throw Error('Free Engine هنوز متصل نشده است. مقدار FREE_ENGINE_URL را در Render تنظیم کنید.');
  const headers = cfg.freeKey ? { Authorization: `Bearer ${cfg.freeKey}` } : {};
  if (cfg.freeMode === 'gradio') {
    const payload = { data: [body.prompt, body.duration, body.ratio || '1280:720', body.promptImage || null] };
    const x = await callJson(`${cfg.freeUrl}/gradio_api/call/${encodeURIComponent(cfg.freeEndpoint)}`, payload, headers);
    if (!x.event_id) throw Error('Free Engine (Gradio) شناسه صف برنگرداند.');
    return { id: `gradio:${cfg.freeEndpoint}:${x.event_id}`, model: 'free-engine-gradio' };
  }
  return await callJson(`${cfg.freeUrl}/generate`, body, headers);
}

async function freeTask(taskId) {
  if (!cfg.freeUrl) throw Error('Free Engine تنظیم نشده است.');
  const headers = cfg.freeKey ? { Authorization: `Bearer ${cfg.freeKey}` } : {};
  if (cfg.freeMode !== 'gradio') {
    const rr = await fetch(`${cfg.freeUrl}/tasks/${encodeURIComponent(taskId)}`, { headers });
    let r = {}; try { r = await rr.json(); } catch {}
    if (!rr.ok) throw Error(r?.error || `Free Engine HTTP ${rr.status}`);
    return r;
  }
  const m = String(taskId).match(/^gradio:([^:]+):(.+)$/);
  if (!m) throw Error('شناسه Gradio نامعتبر است.');
  const rr = await fetch(`${cfg.freeUrl}/gradio_api/call/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`, { headers });
  const text = await rr.text();
  if (!rr.ok) throw Error(`Free Engine Gradio HTTP ${rr.status}`);
  let event = '', data = null, lastData = null;
  for (const block of text.split(/\n\n+/)) {
    const em = block.match(/^event:\s*(.+)$/m); const dm = block.match(/^data:\s*(.+)$/m);
    if (em) event = em[1].trim();
    if (dm) { try { data = JSON.parse(dm[1]); lastData = data; } catch {} }
    if (event === 'complete') break;
    if (event === 'error') return { status: 'FAILED', error: typeof data === 'string' ? data : 'Free Engine خطا داد.' };
  }
  if (event === 'complete') {
    const out = Array.isArray(lastData) ? lastData[0] : lastData;
    const url = out?.url || out?.video_url || (typeof out === 'string' && /^https?:/.test(out) ? out : null);
    return { status: 'SUCCEEDED', url, output: out };
  }
  return { status: 'PROCESSING' };
}

app.post('/api/generate', auth, async (req, res) => {
  const d = req.db, u = req.user, requestedEngine = req.body.engine === 'runway' ? 'runway' : 'free', duration = Number(req.body.duration || 5), prompt = String(req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'پرامپت را وارد کنید.' });
  if (duration < 4 || duration > 30) return res.status(400).json({ error: 'مدت باید بین ۴ تا ۳۰ ثانیه باشد.' });
  const cost = chargeFor(u, d);
  if (cost > 0 && Number(u.wallet || 0) < cost) return res.status(402).json({ error: `سهمیه رایگان امروز تمام شده است. برای ادامه ${cost.toLocaleString('fa-IR')} ${cfg.currency} کیف پول لازم است.` });
  let result, engine = requestedEngine, fallback = false;
  const freeBody = { prompt, duration, ratio: req.body.ratio || '1280:720', promptImage: req.body.promptImage || null };
  try {
    if (requestedEngine === 'runway') {
      try {
        if (!cfg.runwayKey) throw Error('Runway روی سرور تنظیم نشده است.');
        const body = { model: 'seedance2_5', promptText: prompt, duration, ratio: req.body.ratio || '1280:720' };
        if (req.body.promptImage) body.promptImage = req.body.promptImage;
        result = await callJson(`${cfg.runwayBase}/text_to_video`, body, { Authorization: `Bearer ${cfg.runwayKey}`, 'X-Runway-API-Version': '2024-11-06' });
        result.model = 'seedance2_5';
      } catch (runwayErr) {
        const msg = String(runwayErr?.message || runwayErr);
        const creditFailure = /credit|credits|insufficient|quota|billing|balance|payment|funds|اعتبار|سهمیه|موجودی/i.test(msg);
        if (!cfg.freeUrl || !creditFailure) throw runwayErr;
        result = await freeGenerate(freeBody);
        engine = 'free'; fallback = true;
      }
    } else {
      result = await freeGenerate(freeBody);
    }

    const effectiveCost = fallback ? 0 : cost;
    const taskId = result.id || result.taskId || result.data?.id;
    if (!taskId && result.url) {
      const job = { id: uid(), taskId: uid(), userId: u.id, day: day(), engine, status: 'SUCCEEDED', createdAt: Date.now(), cost: effectiveCost, duration, url: result.url, fallback };
      if (effectiveCost) u.wallet -= effectiveCost;
      d.jobs.unshift(job); save(d);
      return res.json({ taskId: job.taskId, model: result.model || engine, duration, url: result.url, engine, fallback });
    }
    if (!taskId) throw Error('موتور تولید شناسه Job برنگرداند.');
    const job = { id: uid(), taskId, userId: u.id, day: day(), engine, status: 'PROCESSING', createdAt: Date.now(), cost: effectiveCost, duration, fallback };
    d.jobs.unshift(job); if (effectiveCost) u.wallet -= effectiveCost; save(d);
    res.json({ taskId, model: result.model || engine, duration, engine, fallback });
  } catch (e) {
    res.status(502).json({ error: e.message || 'خطا در موتور تولید', engine, fallback });
  }
});

app.get('/api/tasks/:id', auth, async (req, res) => {
  const d = req.db, j = d.jobs.find(x => x.taskId === req.params.id && x.userId === req.user.id);
  if (!j) return res.status(404).json({ error: 'Job پیدا نشد.' });
  if (j.status === 'PROCESSING') {
    try {
      let r;
      if (j.engine === 'runway') {
        const rr = await fetch(`${cfg.runwayBase}/tasks/${encodeURIComponent(j.taskId)}`, { headers: { Authorization: `Bearer ${cfg.runwayKey}`, 'X-Runway-API-Version': '2024-11-06' } });
        r = await rr.json();
        if (rr.ok) {
          j.status = r.status || j.status;
          j.url = r.output?.[0] || r.output?.video_url || j.url;
          j.error = r.failure || r.error || j.error;
        }
      } else if (cfg.freeUrl) {
        r = await freeTask(j.taskId);
        j.status = r.status || j.status;
        j.url = r.url || r.output?.url || r.output || j.url;
        j.error = r.error || j.error;
      }
      if (['FAILED', 'CANCELED'].includes(j.status) && j.cost) {
        req.user.wallet = Number(req.user.wallet || 0) + j.cost;
        j.refunded = true;
        j.cost = 0;
      }
      save(d);
    } catch (e) { j.error = e.message; }
  }
  res.json({ status: j.status, url: j.url, error: j.error });
});

app.get('/api/admin', auth, admin, (req, res) => res.json({ ok: true }));

// سرو فایل‌های استاتیک
app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

// سرو فایل اصلی index.html برای تمام مسیرها
app.get('*', (req, res) => {
  const indexPath = getIndexFilePath();
  if (indexPath) {
    return res.sendFile(indexPath);
  }
  res.status(404).send('فایل index.html در هیچ پوشه‌ای پیدا نشد. لطفاً مطمئن شوید فایل index.html در ریشه پروژه وجود دارد.');
});

app.listen(PORT, () => console.log(`Ayaz V4.1 listening on ${PORT}`));