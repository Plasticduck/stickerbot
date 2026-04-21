import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeWithWebSearch } from './anthropic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));

const BAD_LOCALS = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'postmaster', 'abuse', 'privacy', 'legal', 'security', 'unsubscribe', 'compliance',
]);

function normalize(s) {
  return (s || '').toLowerCase().trim();
}

function isBadLocal(addr) {
  const local = addr.split('@')[0].toLowerCase();
  return BAD_LOCALS.has(local);
}

export function findSeed(name, domain) {
  const n = normalize(name);
  const d = normalize(domain);
  return seed.find((s) => normalize(s.name) === n || (d && normalize(s.domain) === d));
}

export function listSeed() {
  return seed;
}

const SEARCH_SYSTEM = `You are a contact-lookup assistant. You will be given an organization (company, school, team, nonprofit, etc.) and you must find their REAL, PUBLISHED contact email address by searching the live web.

Rules:
1. Use the web_search tool. Actually search. Do not answer from memory.
2. Look at the organization's official website (contact page, support page, about page, athletics/fan-mail page for teams, communications/alumni page for schools), and reputable directory sites.
3. Only return an email address you actually saw on a real page during search. Never guess, never invent, never infer a pattern.
4. The address must be at the organization's own domain or a clearly owned subdomain. For universities that is usually the .edu domain. For athletics programs it may be a dedicated athletics site (rolltide.com, mgoblue.com, etc.).
5. Prefer addresses meant for human replies. For companies: customer service, community, hello, contact. For schools/teams: athletics communications, fan mail, alumni relations, general info. Avoid noreply, privacy, legal, abuse, compliance.
6. If no real published address can be found on the web, return null. Do NOT guess.
7. Output strict JSON as the LAST thing in your response.`;

function extractJson(text) {
  // Grab the last {...} JSON object in the response (Claude may narrate before it).
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i][0]);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// Returns { address, confidence, sourceUrl, cost } or { address: null, cost }.
async function webSearchForEmail({ name, domain }) {
  const user = `Find the real published contact email address for this company by searching the web.

Company: ${name}${domain ? `\nWebsite: https://${domain}` : ''}

Search for their actual contact page. Read what the page says. Report only an email address you literally saw printed on a real page.

Return JSON as the last thing in your response:
{"address":"real@address.com","confidence":"high|medium|low","source_url":"https://page-where-you-found-it.com/contact","note":"short quote or explanation of where it was found"}

If no real email is visible anywhere you searched, return:
{"address":null,"confidence":"low","source_url":null,"note":"reason (e.g. only a contact form; site behind login; no email exposed)"}`;

  try {
    const { text, cost, searchUses } = await completeWithWebSearch({
      system: SEARCH_SYSTEM,
      user,
      maxTokens: 1500,
      temperature: 0.0,
      maxSearches: 3,
    });
    const parsed = extractJson(text);
    if (!parsed) {
      return { address: null, confidence: 'low', sourceUrl: null, note: 'no JSON in response', cost, searchUses };
    }
    const addr = parsed.address;
    if (!addr || typeof addr !== 'string') {
      return {
        address: null,
        confidence: parsed.confidence || 'low',
        sourceUrl: parsed.source_url || null,
        note: parsed.note || 'not found',
        cost,
        searchUses,
      };
    }
    const cleaned = addr.toLowerCase().trim();
    if (!cleaned.includes('@') || isBadLocal(cleaned)) {
      return { address: null, confidence: 'low', sourceUrl: parsed.source_url || null, note: 'filtered', cost, searchUses };
    }
    return {
      address: cleaned,
      confidence: parsed.confidence || 'medium',
      sourceUrl: parsed.source_url || null,
      note: parsed.note || '',
      cost,
      searchUses,
    };
  } catch (e) {
    return { address: null, confidence: 'low', sourceUrl: null, note: `error: ${e.message}`, cost: 0, searchUses: 0 };
  }
}

// Main entry. Actively searches the live web; never guesses.
// Returns { address, source, cost, sourceUrl?, note?, searchUses? } or null.
// source: 'seed' | 'web-search' | null (caller should skip on null)
export async function pickAddress({ name, domain }) {
  const found = findSeed(name, domain);
  if (found && found.emails?.length) {
    return { address: found.emails[0], source: 'seed', cost: 0 };
  }

  const result = await webSearchForEmail({ name, domain });
  if (result.address) {
    return {
      address: result.address,
      source: `web-search (${result.confidence})`,
      cost: result.cost,
      sourceUrl: result.sourceUrl,
      note: result.note,
      searchUses: result.searchUses,
    };
  }

  return {
    address: null,
    source: null,
    cost: result.cost,
    note: result.note,
    searchUses: result.searchUses,
  };
}
