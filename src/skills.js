import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { complete } from './anthropic.js';

const SKILLS_DIR = path.join(os.homedir(), '.stickerbot', 'skills');
const ACTIVE_SKILL_PATH = path.join(os.homedir(), '.stickerbot', 'active_skill.txt');
export const SKILL_TOPIC = 'stickerbot-skill';
const MANIFEST_FILENAME = 'stickerbot.json';
const GITHUB_API = 'https://api.github.com';

const SCHEMA_FIELDS = {
  name: 'string',
  version: 'string',
  description: 'string',
  agenda_template: 'string',
  default_item: 'string',
  compose_extra: 'string',
  discovery_extra: 'string',
};

function slugify(s) {
  const cleaned = (s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'skill';
}

export function validateSkill(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest must be a JSON object' };
  const name = manifest.name;
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: "missing 'name'" };
  if (slugify(name) !== name) return { ok: false, error: `'name' must be a slug (lowercase, hyphens only), got "${name}"` };
  for (const [field, typ] of Object.entries(SCHEMA_FIELDS)) {
    if (field in manifest && typeof manifest[field] !== typ) {
      return { ok: false, error: `'${field}' must be a ${typ}` };
    }
  }
  return { ok: true };
}

function ensureDir() {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
}

export function listSkills() {
  ensureDir();
  const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')));
    } catch {
      /* ignore unreadable */
    }
  }
  out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return out;
}

export function loadSkill(name) {
  ensureDir();
  const p = path.join(SKILLS_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSkill(manifest) {
  const v = validateSkill(manifest);
  if (!v.ok) throw new Error(v.error);
  ensureDir();
  const p = path.join(SKILLS_DIR, `${manifest.name}.json`);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
  return p;
}

export function removeSkill(name) {
  const p = path.join(SKILLS_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  const active = getActiveSkill();
  if (active && active.name === name) setActiveSkill(null);
  return true;
}

export function getActiveSkill() {
  if (!fs.existsSync(ACTIVE_SKILL_PATH)) return null;
  const name = fs.readFileSync(ACTIVE_SKILL_PATH, 'utf8').trim();
  if (!name) return null;
  return loadSkill(name);
}

export function setActiveSkill(name) {
  fs.mkdirSync(path.dirname(ACTIVE_SKILL_PATH), { recursive: true });
  fs.writeFileSync(ACTIVE_SKILL_PATH, name == null ? '' : String(name));
}

async function githubGet(pathOrUrl, { accept = 'application/vnd.github+json' } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GITHUB_API}${pathOrUrl}`;
  const headers = {
    Accept: accept,
    'User-Agent': 'stickerbot-web',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    if (resp.status === 403) throw new Error('GitHub rate limit hit. Set GITHUB_TOKEN for a higher limit.');
    throw new Error(`GitHub ${resp.status}: ${await resp.text()}`);
  }
  if (accept === 'application/vnd.github+json') return resp.json();
  return resp.text();
}

export async function githubSearchSkills() {
  const data = await githubGet(
    `/search/repositories?q=topic:${SKILL_TOPIC}&sort=stars&order=desc&per_page=50`,
  );
  const items = data.items || [];
  return items.map((r) => ({
    full_name: r.full_name || '',
    description: r.description || '',
    stars: r.stargazers_count || 0,
    url: r.html_url || '',
    default_branch: r.default_branch || 'main',
  }));
}

export async function githubFetchManifest(ownerRepo) {
  const info = await githubGet(`/repos/${ownerRepo}`);
  const branch = info.default_branch || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${MANIFEST_FILENAME}`;
  const text = await githubGet(rawUrl, { accept: 'application/octet-stream' });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`fetched manifest is not valid JSON: ${e.message}`);
  }
}

export function parseOwnerRepo(arg) {
  const s = (arg || '').trim();
  if (s.startsWith('http')) {
    const parts = s.replace(/\/$/, '').split('/');
    if (parts.length >= 2) {
      let repo = parts[parts.length - 1];
      const owner = parts[parts.length - 2];
      if (repo.endsWith('.git')) repo = repo.slice(0, -4);
      return `${owner}/${repo}`;
    }
  }
  return s;
}

const AI_SKILL_SYSTEM = `You design "skills" for StickerBot, a CLI that writes polite free-item request emails to organizations. A skill is a reusable preset that steers the bot toward a category of organizations and shapes the email's tone without overriding the bot's absolute rules.

Given the user's description, output a single JSON object with these fields:
  name              (slug: lowercase, hyphens only, no spaces)
  version           (semver, start with "1.0.0")
  description       (one sentence)
  agenda_template   (default agenda text; taken literally by discovery, include every qualifier)
  default_item      (what to ask for by default: "stickers", "signatures", "patches", etc.)
  compose_extra     (tone/content nudges for the email; a short paragraph; must not claim relationships, geographic proximity, political alignment, or specific facts about the organization)
  discovery_extra   (extra filtering hints for discovery; a short paragraph)

Hard constraints for compose_extra:
- Do NOT instruct the model to claim to be an alum/student/constituent/local/customer/member/etc.
- Do NOT instruct the model to state conference/division/records/coach names/locations/founding dates.
- Do NOT instruct the model to use em dashes or en dashes.

Output strict JSON only. No prose, no markdown fences.`;

export async function aiDraftSkill(description) {
  const { text, cost } = await complete({
    system: AI_SKILL_SYSTEM,
    user: `Describe-your-skill input from the user:\n\n${description}\n\nEmit the skill JSON now.`,
    maxTokens: 800,
    temperature: 0.4,
  });
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first >= 0 && last > first) {
      parsed = JSON.parse(cleaned.slice(first, last + 1));
    } else {
      throw new Error(`bad skill JSON from model: ${text.slice(0, 200)}`);
    }
  }
  return { manifest: parsed, cost };
}

export function publishSkill(name) {
  const skill = loadSkill(name);
  if (!skill) throw new Error(`no skill named ${name}`);
  const ghCheck = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  if (ghCheck.status !== 0) {
    throw new Error("GitHub CLI 'gh' not found. Install from https://cli.github.com/ then run `gh auth login`.");
  }
  const repoName = `stickerbot-skill-${skill.name}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stickerbot-skill-'));
  try {
    fs.writeFileSync(path.join(tmp, MANIFEST_FILENAME), JSON.stringify(skill, null, 2));
    const readme = `# ${skill.name}\n\n${skill.description || ''}\n\nInstall:\n\n\`\`\`\nstickerbot skill install <owner>/${repoName}\n\`\`\`\n`;
    fs.writeFileSync(path.join(tmp, 'README.md'), readme);

    const run = (cmd, args) => {
      const r = spawnSync(cmd, args, { cwd: tmp, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
      return r;
    };
    run('git', ['init', '-b', 'main']);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', `publish skill: ${skill.name}`]);
    run('gh', [
      'repo', 'create', repoName,
      '--public', '--source=.', '--push',
      '--description', (skill.description || '').slice(0, 350) || `StickerBot skill: ${skill.name}`,
    ]);
    run('gh', ['repo', 'edit', '--add-topic', SKILL_TOPIC]);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return repoName;
}

export function skillsPath() {
  return SKILLS_DIR;
}
