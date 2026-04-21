const $ = (id) => document.getElementById(id);

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json();
}

// Tabs
document.querySelectorAll('nav.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'emails') loadEmails();
    if (b.dataset.tab === 'history') loadRuns();
    if (b.dataset.tab === 'prefs') loadPrefs();
    if (b.dataset.tab === 'settings') loadEnv();
  });
});

// Cost estimate
let perEmailCost = 0.003; // replaced when /api/status loads
let estimateModel = 'claude-haiku-4-5';

function updateEstimate() {
  const n = Math.max(0, Number($('max-emails').value) || 0);
  const cap = Number($('max-usd').value) || 0;
  const cost = n * perEmailCost;
  const el = $('estimate');
  const overCap = cost > cap && cap > 0;
  el.classList.toggle('warn', overCap);
  el.innerHTML = `Estimated cost for ${n} emails on ${estimateModel}: <b>$${cost.toFixed(4)}</b>` +
    (overCap
      ? ` <span style="color:var(--warn)">(exceeds cap of $${cap.toFixed(2)} — run will stop early)</span>`
      : ` <span class="muted">(~$${perEmailCost.toFixed(4)} per email)</span>`);
}

$('max-emails').addEventListener('input', updateEstimate);
$('max-usd').addEventListener('input', updateEstimate);

// Start / stop
$('start-btn').addEventListener('click', async () => {
  const agenda = $('agenda').value.trim();
  const item = ($('item')?.value || '').trim() || 'stickers';
  const maxEmails = Number($('max-emails').value);
  const maxUsd = Number($('max-usd').value);
  try {
    await api('/api/start', {
      method: 'POST',
      body: JSON.stringify({ agenda, maxEmails, maxUsd, item }),
    });
    currentLogSince = 0;
    $('log').innerHTML = '';
  } catch (e) {
    alert('Start failed: ' + e.message);
  }
});

$('stop-btn').addEventListener('click', async () => {
  try {
    await api('/api/stop', { method: 'POST' });
  } catch (e) {
    alert('Stop failed: ' + e.message);
  }
});

// Preferences
async function loadPrefs() {
  const r = await api('/api/preferences');
  $('prefs').value = r.content || '';
}
$('save-prefs').addEventListener('click', async () => {
  try {
    await api('/api/preferences', { method: 'POST', body: JSON.stringify({ content: $('prefs').value }) });
    $('prefs-saved').textContent = 'Saved.';
    setTimeout(() => ($('prefs-saved').textContent = ''), 2000);
  } catch (e) {
    $('prefs-saved').textContent = 'Error: ' + e.message;
  }
});

// Settings
async function loadEnv() {
  const r = await api('/api/status');
  const e = r.env;
  if (e.perEmailCostUsd) perEmailCost = e.perEmailCostUsd;
  if (e.model) estimateModel = e.model;
  updateEstimate();
  $('env').innerHTML = `
    <div class="muted">API key: ${e.hasApiKey ? 'set' : '<span style="color:var(--bad)">not set</span>'}</div>
    <div class="muted">From: ${escapeHtml(e.fromName || '')} &lt;${escapeHtml(e.user || '')}&gt;</div>
    <div class="muted">Mailing address: ${escapeHtml(e.senderAddress || '(not set)')}</div>
    <div class="muted">SMTP host: ${e.smtpHost || '(none)'}</div>
    <div class="muted">IMAP host: ${e.imapHost || '(none)'}</div>
    <div class="muted">Model: ${escapeHtml(e.model || '')}</div>
    <div class="muted">Estimated cost per email: ~$${Number(e.perEmailCostUsd || 0).toFixed(4)}</div>
  `;
}

$('test-smtp').addEventListener('click', async () => {
  $('conn-result').textContent = 'Testing SMTP...';
  try {
    await api('/api/test-smtp', { method: 'POST' });
    $('conn-result').textContent = 'SMTP OK';
  } catch (e) {
    $('conn-result').textContent = 'SMTP failed: ' + e.message;
  }
});

$('test-imap').addEventListener('click', async () => {
  $('conn-result').textContent = 'Testing IMAP...';
  try {
    await api('/api/test-imap', { method: 'POST' });
    $('conn-result').textContent = 'IMAP OK';
  } catch (e) {
    $('conn-result').textContent = 'IMAP failed: ' + e.message;
  }
});

// Emails
async function loadEmails() {
  const r = await api('/api/emails');
  const box = $('emails');
  if (!r.emails.length) {
    box.innerHTML = '<div class="muted">No emails yet.</div>';
    return;
  }
  box.innerHTML = r.emails
    .map((e) => `
      <div class="email-item">
        <div class="head">
          <div><span class="company">${escapeHtml(e.company)}</span> <span class="addr">${escapeHtml(e.to_address)}</span></div>
          <span class="badge ${e.verified ? 'verified' : e.status}">${e.verified ? 'verified' : e.status}</span>
        </div>
        <div class="subject">${escapeHtml(e.subject || '')}</div>
        <div class="body">${escapeHtml(e.body || '')}</div>
      </div>
    `)
    .join('');
}

// Runs
async function loadRuns() {
  const r = await api('/api/runs');
  const box = $('runs');
  if (!r.runs.length) {
    box.innerHTML = '<div class="muted">No runs yet.</div>';
    return;
  }
  box.innerHTML = r.runs
    .map((run) => `
      <div class="run-item">
        <div class="head">
          <div><b>Run #${run.id}</b> <span class="muted">${fmtTime(run.started_at)}</span></div>
          <span class="badge ${run.status === 'running' ? 'pending' : run.status === 'completed' ? 'verified' : 'sent'}">${run.status}</span>
        </div>
        <div class="muted">agenda: ${escapeHtml(run.agenda || '(none)')}</div>
        <div class="muted">sent ${run.sent_count}/${run.max_emails}, spent $${Number(run.spent_usd || 0).toFixed(4)} / $${run.max_usd}</div>
      </div>
    `)
    .join('');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Polling
let currentLogSince = 0;
let currentRunId = null;

async function poll() {
  try {
    const r = await api('/api/status');
    const pill = $('status-pill');
    const startBtn = $('start-btn');
    const stopBtn = $('stop-btn');
    if (r.current) {
      pill.textContent = r.current.status;
      pill.className = 'pill running';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      $('live-run').textContent = `#${r.current.runId}`;
      $('live-step').textContent = r.current.currentStep || '-';
      $('live-sent').textContent = `${r.current.sentCount} / ${r.current.maxEmails}`;
      $('live-spent').textContent = `$${Number(r.current.spentUsd).toFixed(4)} / $${r.current.maxUsd}`;
      if (currentRunId !== r.current.runId) {
        currentRunId = r.current.runId;
        currentLogSince = 0;
        $('log').innerHTML = '';
      }
      await pullLog(currentRunId);
    } else {
      pill.textContent = 'idle';
      pill.className = 'pill idle';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      $('live-step').textContent = '-';
      if (currentRunId) {
        await pullLog(currentRunId);
      }
    }
  } catch (e) {
    // ignore transient errors
  }
}

async function pullLog(runId) {
  const r = await api(`/api/log?runId=${runId}&sinceId=${currentLogSince}`);
  const box = $('log');
  for (const e of r.entries) {
    const div = document.createElement('div');
    div.className = `entry ${e.level}`;
    div.innerHTML = `<span class="ts">${fmtTime(e.ts)}</span>${escapeHtml(e.message)}`;
    box.appendChild(div);
    currentLogSince = e.id;
  }
  box.scrollTop = box.scrollHeight;
}

setInterval(poll, 1500);
poll();
loadEnv();
