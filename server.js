import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listRuns,
  getRun,
  recentLog,
  getLog,
  listEmails,
  getPreferences,
  setPreferences,
} from './src/db.js';
import { startRun, stopCurrent, getCurrent } from './src/orchestrator.js';
import { verifySmtp } from './src/send.js';
import { verifyImap } from './src/verify.js';
import { PER_EMAIL_COST_USD, MODEL } from './src/anthropic.js';
import {
  listSkills,
  loadSkill,
  saveSkill,
  removeSkill,
  getActiveSkill,
  setActiveSkill,
  githubSearchSkills,
  githubFetchManifest,
  parseOwnerRepo,
  aiDraftSkill,
  publishSkill,
  validateSkill,
} from './src/skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '200kb' }));

// Local-only guard. Reject requests that aren't from localhost.
app.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const isLocal =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('127.') ||
    ip === '';
  if (!isLocal) {
    return res.status(403).send('Local only.');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  const current = getCurrent();
  res.json({
    current,
    env: {
      hasApiKey: !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('REPLACE'),
      user: process.env.EMAIL_USER,
      smtpHost: process.env.SMTP_HOST,
      imapHost: process.env.IMAP_HOST,
      perEmailCostUsd: PER_EMAIL_COST_USD,
      model: MODEL,
      fromName: process.env.EMAIL_FROM_NAME || '',
      senderAddress: process.env.SENDER_ADDRESS || '',
    },
  });
});

app.get('/api/runs', (_req, res) => {
  res.json({ runs: listRuns(30) });
});

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ run, emails: listEmails(run.id) });
});

app.get('/api/log', (req, res) => {
  const runId = Number(req.query.runId || 0);
  const sinceId = Number(req.query.sinceId || 0);
  if (runId) {
    res.json({ entries: getLog(runId, sinceId) });
  } else {
    res.json({ entries: recentLog(200) });
  }
});

app.get('/api/emails', (req, res) => {
  const runId = req.query.runId ? Number(req.query.runId) : null;
  res.json({ emails: listEmails(runId) });
});

app.get('/api/preferences', (_req, res) => {
  res.json({ content: getPreferences() });
});

app.post('/api/preferences', (req, res) => {
  const content = String(req.body?.content ?? '');
  setPreferences(content);
  res.json({ ok: true });
});

app.post('/api/start', async (req, res) => {
  try {
    const { agenda, maxEmails, maxUsd, item } = req.body || {};
    const n = Number(maxEmails);
    const u = Number(maxUsd);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return res.status(400).json({ error: 'maxEmails must be 1..500' });
    }
    if (!Number.isFinite(u) || u <= 0 || u > 50) {
      return res.status(400).json({ error: 'maxUsd must be >0 and <=50' });
    }
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('REPLACE')) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set in .env' });
    }
    const result = await startRun({ agenda: agenda || '', maxEmails: n, maxUsd: u, item: item || 'stickers' });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/stop', (_req, res) => {
  const ok = stopCurrent();
  res.json({ ok });
});

app.post('/api/test-smtp', async (_req, res) => {
  try {
    await verifySmtp();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/test-imap', async (_req, res) => {
  try {
    await verifyImap();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// --- Skills API ---

app.get('/api/skills', (_req, res) => {
  const active = getActiveSkill();
  res.json({ skills: listSkills(), activeName: active ? active.name : null });
});

app.get('/api/skills/browse', async (_req, res) => {
  try {
    const results = await githubSearchSkills();
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/skills/install', async (req, res) => {
  try {
    const ownerRepo = parseOwnerRepo(req.body?.ownerRepo || '');
    if (!ownerRepo.includes('/')) return res.status(400).json({ error: 'expected owner/repo' });
    const manifest = await githubFetchManifest(ownerRepo);
    const v = validateSkill(manifest);
    if (!v.ok) return res.status(400).json({ error: `invalid manifest: ${v.error}` });
    saveSkill(manifest);
    res.json({ ok: true, skill: manifest });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/skills', async (req, res) => {
  try {
    const { manifest, aiDescription } = req.body || {};
    let skill = manifest;
    let cost = 0;
    if (aiDescription && (!manifest || Object.keys(manifest).length === 0)) {
      if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('REPLACE')) {
        return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set' });
      }
      const drafted = await aiDraftSkill(aiDescription);
      skill = drafted.manifest;
      cost = drafted.cost;
    }
    if (!skill) return res.status(400).json({ error: 'provide manifest or aiDescription' });
    const v = validateSkill(skill);
    if (!v.ok) return res.status(400).json({ error: v.error });
    saveSkill(skill);
    res.json({ ok: true, skill, cost });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/skills/use', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) {
    setActiveSkill(null);
    return res.json({ ok: true, activeName: null });
  }
  if (!loadSkill(name)) return res.status(404).json({ error: `no skill named ${name}` });
  setActiveSkill(name);
  res.json({ ok: true, activeName: name });
});

app.delete('/api/skills/:name', (req, res) => {
  const ok = removeSkill(req.params.name);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/skills/publish', (req, res) => {
  try {
    const repoName = publishSkill(req.body?.name || '');
    res.json({ ok: true, repoName });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT || 3737);
app.listen(PORT, '127.0.0.1', () => {
  console.log(`StickerBot running at http://127.0.0.1:${PORT}`);
});
