import {
  createRun,
  updateRun,
  logEvent,
  recordEmail,
  updateEmail,
  hasEmailedCompany,
  getPreferences,
  getRun,
} from './db.js';
import { discoverCompanies } from './discover.js';
import { pickAddress, listSeed } from './emailFinder.js';
import { composeEmail } from './compose.js';
import { sendEmail } from './send.js';
import { verifySent, appendToSent } from './verify.js';

let current = null;

// Namecheap Private Email caps roughly 150 emails/hour account-wide.
// 45s between sends keeps us well under that ceiling.
const SEND_DELAY_MS = 45000;

const RATE_LIMIT_PATTERNS = [
  'sending limit',
  'rate limit',
  'too many',
  'quota exceeded',
  'policy rejection',
];

function isRateLimitError(err) {
  const msg = (err && (err.response || err.message || String(err))).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => msg.includes(p)) || err?.responseCode === 450 || err?.responseCode === 421;
}

export function getCurrent() {
  if (!current) return null;
  return {
    runId: current.runId,
    status: current.status,
    agenda: current.agenda,
    item: current.item,
    maxEmails: current.maxEmails,
    maxUsd: current.maxUsd,
    sentCount: current.sentCount,
    spentUsd: Number(current.spentUsd.toFixed(4)),
    currentStep: current.currentStep,
  };
}

export function stopCurrent() {
  if (!current) return false;
  current.stopRequested = true;
  return true;
}

function log(level, message) {
  if (!current) return;
  logEvent(current.runId, level, message);
  console.log(`[run ${current.runId}] ${level}: ${message}`);
}

function setStep(step) {
  if (!current) return;
  current.currentStep = step;
  log('info', `step: ${step}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Queue of pending candidate companies produced by discovery.
// Drained by the main loop; refilled when empty.
async function refillQueue(queue, exclude) {
  if (!current) return;
  const preferences = getPreferences();
  const batchSize = Math.min(5, current.maxEmails - current.sentCount + 2);
  setStep('discovering companies');
  const { companies, cost } = await discoverCompanies({
    agenda: current.agenda,
    preferences,
    count: batchSize,
    exclude,
  });
  current.spentUsd += cost;
  log('info', `discovery returned ${companies.length} candidates (cost $${cost.toFixed(4)})`);
  for (const c of companies) queue.push(c);
}

async function processOne(candidate) {
  if (!current) return false;
  const { name, domain, reason } = candidate;
  if (!name) return false;

  if (hasEmailedCompany(name)) {
    log('info', `skip ${name}: already contacted`);
    return false;
  }

  setStep(`searching web for ${name}'s contact email`);
  const pick = await pickAddress({ name, domain });
  if (pick?.cost) current.spentUsd += pick.cost;
  if (!pick || !pick.address) {
    const note = pick?.note ? ` (${pick.note})` : '';
    const searches = pick?.searchUses ? ` [${pick.searchUses} searches]` : '';
    log('warn', `skipping ${name}: no real email found on the web${note}${searches}`);
    return false;
  }
  log('info', `addr: ${pick.address} (${pick.source})`);
  if (pick.sourceUrl) log('info', `source: ${pick.sourceUrl}`);
  if (pick.searchUses) log('info', `web searches used: ${pick.searchUses}`);

  setStep(`writing email to ${name}`);
  const preferences = getPreferences();
  let subject, body, composeCost;
  try {
    const out = await composeEmail({
      company: name,
      reason,
      agenda: current.agenda,
      preferences,
      item: current.item,
    });
    subject = out.subject;
    body = out.body;
    composeCost = out.cost;
    current.spentUsd += composeCost;
    log('info', `composed (cost $${composeCost.toFixed(4)})`);
  } catch (e) {
    log('error', `compose failed for ${name}: ${e.message}`);
    return false;
  }

  const emailId = recordEmail({
    runId: current.runId,
    company: name,
    domain,
    to: pick.address,
    subject,
    body,
    status: 'pending',
  });

  setStep(`sending to ${pick.address}`);
  let sendResult;
  try {
    sendResult = await sendEmail({ to: pick.address, subject, body });
  } catch (e) {
    updateEmail(emailId, { status: 'failed', error: e.message });
    if (isRateLimitError(e)) {
      log('error', `rate limit hit: ${e.message}`);
      current.rateLimited = true;
      return false;
    }
    log('error', `send failed to ${pick.address}: ${e.message}`);
    return false;
  }

  const accepted = sendResult.accepted?.length > 0;
  updateEmail(emailId, {
    status: accepted ? 'sent' : 'failed',
    message_id: sendResult.messageId || null,
    error: accepted ? null : `rejected: ${JSON.stringify(sendResult.rejected)}`,
  });

  if (!accepted) {
    log('error', `smtp rejected ${pick.address}`);
    return false;
  }

  log('info', `sent to ${pick.address} (msgid ${sendResult.messageId})`);
  current.sentCount += 1;
  updateRun(current.runId, { sent_count: current.sentCount, spent_usd: current.spentUsd });

  setStep(`saving to Sent folder`);
  try {
    if (sendResult.raw) {
      await appendToSent(sendResult.raw);
      log('info', `saved to Sent folder`);
    }
  } catch (e) {
    log('warn', `could not save to Sent folder: ${e.message}`);
  }

  setStep(`verifying via IMAP`);
  try {
    const found = await verifySent(sendResult.messageId, { timeoutMs: 15000 });
    if (found) {
      updateEmail(emailId, { status: 'verified', verified: 1 });
      log('info', `verified in Sent folder`);
    } else {
      log('warn', `not found in Sent folder within 15s (still counted as sent)`);
    }
  } catch (e) {
    log('warn', `IMAP verify error: ${e.message}`);
  }

  return true;
}

export async function startRun({ agenda, maxEmails, maxUsd, item }) {
  if (current) throw new Error('A run is already in progress');

  const cleanItem = (item && String(item).trim()) || 'stickers';
  const runId = createRun({ agenda, maxEmails, maxUsd });
  current = {
    runId,
    status: 'running',
    agenda: agenda || '',
    item: cleanItem,
    maxEmails: Number(maxEmails),
    maxUsd: Number(maxUsd),
    sentCount: 0,
    spentUsd: 0,
    currentStep: 'starting',
    stopRequested: false,
  };

  log('info', `run started (max ${maxEmails} emails, cap $${maxUsd}, asking for: ${cleanItem})`);

  (async () => {
    const queue = [];
    const contacted = new Set();
    // Pre-seed contacted from the already-emailed list to avoid repeats.
    const seedList = listSeed();
    try {
      while (
        current.sentCount < current.maxEmails &&
        current.spentUsd < current.maxUsd &&
        !current.stopRequested
      ) {
        if (queue.length === 0) {
          try {
            await refillQueue(queue, [...contacted]);
          } catch (e) {
            log('error', `discovery failed: ${e.message}`);
            // The seed list is a generic tech-company list with no relation to
            // the agenda. Falling back to it silently emails Mozilla/GitHub/etc.
            // regardless of what the user asked for. Only allow the fallback
            // when there is no agenda at all.
            if (current.agenda && current.agenda.trim()) {
              log('error', 'refusing to fall back to the generic seed list because an agenda was specified. Fix the Anthropic API error above and re-run.');
              break;
            }
            for (const s of seedList) {
              if (!contacted.has(s.name)) queue.push({ name: s.name, domain: s.domain, reason: 'seed-fallback' });
            }
            if (queue.length === 0) break;
          }
        }
        if (queue.length === 0) {
          log('warn', 'no candidates available, stopping');
          break;
        }

        const candidate = queue.shift();
        contacted.add(candidate.name);

        if (current.spentUsd >= current.maxUsd) {
          log('warn', `budget reached ($${current.spentUsd.toFixed(4)} >= $${current.maxUsd})`);
          break;
        }

        const sent = await processOne(candidate);
        if (current.rateLimited) {
          log('warn', 'mail server rate limit reached, stopping run');
          log('info', 'Namecheap Private Email caps around 150 emails/hour. Wait an hour before the next run.');
          break;
        }
        if (sent && current.sentCount < current.maxEmails) {
          setStep(`waiting ${SEND_DELAY_MS / 1000}s before next send (rate-limit safety)`);
          await sleep(SEND_DELAY_MS);
        }
      }

      const finalStatus = current.stopRequested
        ? 'stopped'
        : current.sentCount >= current.maxEmails
        ? 'completed'
        : 'ended';
      current.status = finalStatus;
      updateRun(current.runId, {
        status: finalStatus,
        ended_at: Date.now(),
        sent_count: current.sentCount,
        spent_usd: current.spentUsd,
      });
      log('info', `run ${finalStatus}: ${current.sentCount} sent, $${current.spentUsd.toFixed(4)} spent`);
    } catch (e) {
      log('error', `run crashed: ${e.message}`);
      updateRun(current.runId, { status: 'error', ended_at: Date.now() });
    } finally {
      current = null;
    }
  })();

  return { runId };
}
