# StickerBot

A tiny bot that finds organizations matching an "agenda" you type in, writes a
short polite email asking for free stickers (or any item you choose), and sends
it through your own SMTP account. Two parallel implementations:

- **Python CLI** (single file, stdlib-only) — `stickerbot.py`
- **Node + web UI** (Express + SQLite + static frontend) — `server.js` / `src/` / `public/`

Both use the Anthropic API:
- Discovery: **Claude Sonnet 4.6** (interprets agenda qualifiers like "Group of
  Five FBS", "Power Four", "indie bookstores in Texas", etc.)
- Web search for contact addresses: **Claude Haiku 4.5** with the native
  `web_search` tool.
- Compose: **Claude Haiku 4.5**.

---

## Requirements

- Python 3.10+ (for the CLI) or Node 20+ (for the web UI)
- An [Anthropic API key](https://console.anthropic.com/)
- An SMTP + IMAP account you control (tested with Namecheap Private Email)
- A mailing address where recipients can send you things

---

## One-line install

Clone and move in:

```bash
git clone https://github.com/Plasticduck/stickerbot.git
cd stickerbot
```

### Python CLI (no dependencies)

```bash
python stickerbot.py
```

On first run it walks you through setup (Anthropic key, email account,
return address) and saves the config to `~/.stickerbot.json`.

Look up a previously-sent email by Message-ID:

```bash
python stickerbot.py lookup "<some-msgid@yourdomain.com>"
```

### Node + web UI

```bash
npm install
cp .env.example .env
# then edit .env with your real credentials
npm start
```

Open http://localhost:3737.

---

## Environment variables (Node only)

See [`.env.example`](.env.example) for the full list. The Python CLI stores the
same info in `~/.stickerbot.json` instead of a `.env` file.

| Variable | What it's for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API access |
| `EMAIL_USER` / `EMAIL_PASS` | SMTP + IMAP login |
| `EMAIL_FROM_NAME` | Display name on the "From:" line |
| `SENDER_ADDRESS` | Mailing address included under the signature |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Outgoing mail server |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_SECURE` / `IMAP_SENT_FOLDER` | For verifying sends and appending to Sent |
| `PORT` | Web UI port (default 3737) |

---

## What it does, in order

1. **Discover** — asks Claude Sonnet 4.6 for a list of organizations that
   literally match your agenda (including any qualifier like conference,
   geography, size, era, genre).
2. **Find address** — uses Claude Haiku with the native `web_search` tool to
   look up a real, published contact email on the organization's own site.
3. **Compose** — writes a short, warm, human-sounding email asking for the
   item you chose (stickers by default). No invented relationships, no
   geographic or political alignment claims, no dubious factual claims about
   the organization.
4. **Send** — SMTP over SSL. Waits 45 s between sends to stay under Namecheap's
   ~150/hour account-level cap.
5. **Save + verify** — appends the sent message to your IMAP Sent folder and
   confirms it lands.

---

## Safety

- `.env` is gitignored.
- The per-run config (`~/.stickerbot.json`) and local sent log
  (`~/.stickerbot_sent.jsonl`) live in your home directory, not the repo.
- The SQLite database (`stickerbot.db`, Node side only) is gitignored.
- Budgets: you set a max spend and max email count per run; the bot stops
  when either is hit.
- Rate-limit detection: if the SMTP server returns a 450/421 or a known
  rate-limit phrase, the run halts immediately.

See [CHANGELOG.md](CHANGELOG.md) for the history of factual-discipline rules
and other behavior changes.

---

## License

MIT
