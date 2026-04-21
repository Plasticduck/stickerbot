# StickerBot

Type an "agenda." StickerBot finds real organizations that match, looks up a
published contact email on the open web, writes a short polite message asking
for free stickers (or anything you name), and sends it from your own email
account. All in your terminal.

```
┌─ stickerbot ────────────────────────────────────────────────────┐
│  Agenda (company focus, blank for mix): indie board game studios│
│  What to ask for: stickers                                      │
│  How many emails: 5                                             │
│  Budget cap (USD): 0.50                                         │
│                                                                  │
│  [1/5] Stonemaier Games                                         │
│    ✓ address: press@stonemaier.com (contact page)               │
│    ✓ composed ($0.0014)                                         │
│    ✓ sent to press@stonemaier.com                               │
│    ✓ saved to Sent folder                                       │
└──────────────────────────────────────────────────────────────────┘
```

Under the hood it uses the Anthropic API: Claude Sonnet 4.6 for agenda
comprehension, Claude Haiku 4.5 with the native `web_search` tool to find real
published contact addresses, and Haiku again to compose the email.

---

## Install

One command. Requires Python 3.10+.

### with `pipx` (recommended)

```bash
pipx install git+https://github.com/Plasticduck/stickerbot.git
```

### with `uv`

```bash
uv tool install git+https://github.com/Plasticduck/stickerbot.git
```

### with plain `pip` (inside a venv)

```bash
pip install git+https://github.com/Plasticduck/stickerbot.git
```

Now `stickerbot` is a command in your terminal.

---

## First run

```bash
stickerbot
```

The setup wizard walks you through:

1. Your Anthropic API key (get one at https://console.anthropic.com/).
2. Your email account (SMTP + IMAP — tested against Namecheap Private Email;
   anything that speaks SSL SMTP/IMAP works).
3. Your display name and return mailing address.

Config is saved to `~/.stickerbot.json`. The local "sent" log is at
`~/.stickerbot_sent.jsonl`. Nothing is written to the repo directory.

### Running a batch

Every subsequent `stickerbot` run asks for:

- **Agenda** — the category to target. This is taken literally, including
  qualifiers. `Group of Five FBS football programs` excludes Power-Four
  schools; `indie bookstores in Texas` excludes chains and non-Texas stores.
- **What to ask for** — defaults to `stickers`, but you can ask for anything
  small (pins, bookplates, signatures, postcards, patches, fan-mail replies).
- **How many emails** and **budget cap** — the run stops when either is hit.

### Looking up a previous email

```bash
stickerbot lookup "<msgid@yourdomain.com>"
```

Looks up by Message-ID in the local log first, then falls back to an IMAP
`HEADER Message-ID` search against your Sent folder.

---

## Skills (the "app store")

A **skill** is a reusable preset that bundles an agenda template, a default
request item, and a bit of tone/filtering guidance. Set one active and the
run form fills itself in.

```bash
stickerbot skill list                          # your installed skills
stickerbot skill browse                        # what's published on GitHub
stickerbot skill install someone/stickerbot-skill-indie-games
stickerbot skill use indie-games               # make it the active skill
stickerbot skill clear                         # back to default behavior
```

### Create your own

Interactive playground:
```bash
stickerbot skill new
```

AI-drafted (Claude writes the JSON for you from a description):
```bash
stickerbot skill new --ai "Target indie board game studios with a direct-to-consumer store; ask for stickers; tone should be warm and hobbyist"
```

### Publish one for others

```bash
stickerbot skill publish my-skill
```

This requires the [GitHub CLI](https://cli.github.com/) (one-time `gh auth login`). It creates a public repo
named `stickerbot-skill-<name>` and tags it with the topic
`stickerbot-skill`. That topic is the index — anyone running
`stickerbot skill browse` will see it, no registry file or central database.

### Rate limits

`skill browse` and `skill install` call the GitHub API unauthenticated, which
is 60 requests per hour. If you hit the limit, export a
[personal access token](https://github.com/settings/tokens) (no scopes
needed for public data) before running:

```bash
export GITHUB_TOKEN=ghp_...
```

---

## What it does, in order

1. **Discover** — Claude Sonnet 4.6 returns a list of organizations that
   literally match your agenda (every qualifier: conference, geography, size,
   era, genre). No sponsors, suppliers, or tangentially related companies.
2. **Find address** — Claude Haiku 4.5 uses the native `web_search` tool to
   locate a real, published contact email on the organization's own site.
3. **Compose** — writes a short, warm, human-sounding email asking for the
   item you chose. No invented relationships (alum, constituent, local,
   customer, etc.), no geographic proximity claims, no political alignment
   claims, no dubious factual claims about the organization.
4. **Send** — SMTP over SSL. Waits 45 s between sends to stay under typical
   provider caps (~150/hour on Namecheap Private Email).
5. **Save + verify** — appends the sent message to your IMAP Sent folder and
   confirms it landed.

---

## Safety

- Budgets: you set a max spend and max email count per run; the bot stops
  when either is hit.
- Rate-limit detection: if the SMTP server returns a 450/421 or a known
  rate-limit phrase, the run halts immediately.
- No silent fallbacks: if discovery fails while you have an agenda set, the
  bot halts loudly instead of emailing a generic seed list.
- Secrets live in `~/.stickerbot.json` (the CLI) or a local `.env` (the web
  UI). Neither is tracked by git.

See [CHANGELOG.md](CHANGELOG.md) for the history of behavior changes.

---

## Optional: Node + web UI

The repo also ships a Node/Express web-UI implementation if you want a
browser-based version with a SQLite-backed history tab.

```bash
git clone https://github.com/Plasticduck/stickerbot.git
cd stickerbot
npm install
cp .env.example .env
# edit .env with your credentials
npm start
```

Then open http://localhost:3737.

See [`.env.example`](.env.example) for the full list of environment variables.

---

## License

MIT
