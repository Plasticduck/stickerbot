import { ImapFlow } from 'imapflow';

function getClient() {
  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_SECURE).toLowerCase() !== 'false',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    logger: false,
  });
}

export async function verifyImap() {
  const c = getClient();
  await c.connect();
  await c.logout();
  return true;
}

async function ensureSentFolder(c) {
  const folder = process.env.IMAP_SENT_FOLDER || 'Sent';
  const exists = await c.mailboxExists?.(folder);
  if (exists) return folder;
  // mailboxExists may not be on every imapflow version; fall back to list
  try {
    const list = await c.list();
    if (list.some((m) => m.path === folder)) return folder;
  } catch {}
  // create it; mark with \Sent special-use where supported
  try {
    await c.mailboxCreate(folder, { specialUse: '\\Sent' });
  } catch (e) {
    // retry without specialUse for servers that reject it
    try {
      await c.mailboxCreate(folder);
    } catch (e2) {
      // swallow: folder may now exist due to race
    }
  }
  return folder;
}

// Append a raw RFC822 message to the Sent folder. Creates the folder if missing.
export async function appendToSent(rawMessage) {
  const c = getClient();
  await c.connect();
  try {
    const folder = await ensureSentFolder(c);
    await c.append(folder, rawMessage, ['\\Seen']);
    return true;
  } finally {
    await c.logout().catch(() => {});
  }
}

// Poll the Sent folder for the given messageId. Returns true if found within timeoutMs.
export async function verifySent(messageId, { timeoutMs = 15000 } = {}) {
  if (!messageId) return false;
  const folder = process.env.IMAP_SENT_FOLDER || 'Sent';
  const c = getClient();
  await c.connect();
  const deadline = Date.now() + timeoutMs;
  try {
    // If the Sent folder doesn't exist, we can't verify. Return false quietly.
    const list = await c.list();
    if (!list.some((m) => m.path === folder)) return false;

    while (Date.now() < deadline) {
      const lock = await c.getMailboxLock(folder);
      try {
        // imapflow's search syntax for custom headers: { header: { name: value } }
        const search = await c.search({ header: { 'message-id': messageId } });
        if (search && search.length > 0) return true;
      } finally {
        lock.release();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  } finally {
    await c.logout().catch(() => {});
  }
}
