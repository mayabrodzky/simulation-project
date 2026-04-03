require('dotenv').config();

const express          = require('express');
const cors             = require('cors');
const bcrypt           = require('bcryptjs');
const jwt              = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'polaris-dev-secret';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Auth middleware
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const { data: existing } = await supabase
    .from('users').select('id').eq('email', email.toLowerCase()).single();

  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: 'USR' + Date.now(), email: email.toLowerCase(), password_hash: passwordHash };

  const { error } = await supabase.from('users').insert(user);
  if (error) {
    console.error('[register error]', error.message);
    return res.status(500).json({ error: 'Failed to create account.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  console.log(`[register] ${user.email}`);
  res.status(201).json({ token, user: { id: user.id, email: user.email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { data: user } = await supabase
    .from('users').select('*').eq('email', email.toLowerCase()).single();

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  console.log(`[login] ${user.email}`);
  res.json({ token, user: { id: user.id, email: user.email } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email });
});

// ── Signups (waitlist) ─────────────────────────────────────────────────────────

app.post('/api/signups', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const { data: existing } = await supabase
    .from('signups').select('id').eq('email', email.toLowerCase()).single();

  if (existing) {
    return res.status(200).json({ message: "Already registered — you're on the list!" });
  }

  const { error } = await supabase.from('signups').insert({
    email: email.toLowerCase(),
    source: req.get('referer') || 'direct',
  });

  if (error) {
    console.error('[signup error]', error.message);
    return res.status(500).json({ error: 'Failed to save signup.' });
  }

  console.log(`[signup] ${email}`);
  res.status(201).json({ message: 'Signup successful' });
});

app.get('/api/admin/signups', async (req, res) => {
  const { data: signups, error } = await supabase
    .from('signups').select('*').order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: signups.length, signups });
});

// ── Sessions ───────────────────────────────────────────────────────────────────

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { sessionId, startTime, actions, finalState } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

  const record = {
    id: sessionId,
    user_id: req.user.id,
    user_email: req.user.email,
    start_time: startTime || null,
    action_count: Array.isArray(actions) ? actions.length : 0,
    actions: actions || [],
    final_state: finalState || {},
  };

  const { error } = await supabase.from('sessions').upsert(record);
  if (error) {
    console.error('[session save error]', error.message);
    return res.status(500).json({ error: 'Failed to save session.' });
  }

  console.log(`[session saved] ${req.user.email} — ${sessionId}`);
  res.status(201).json({ message: 'Session saved', id: sessionId });
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  const { data: sessions, error } = await supabase
    .from('sessions')
    .select('id, start_time, saved_at, action_count, final_state')
    .eq('user_id', req.user.id)
    .order('saved_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(sessions);
});

app.get('/api/sessions/:id', requireAuth, async (req, res) => {
  const { data: session, error } = await supabase
    .from('sessions').select('*')
    .eq('id', req.params.id).eq('user_id', req.user.id).single();

  if (error || !session) return res.status(404).json({ error: 'Session not found.' });
  res.json(session);
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('sessions').delete()
    .eq('id', req.params.id).eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Session deleted' });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nPolaris backend → http://localhost:${PORT}\n`);
});
