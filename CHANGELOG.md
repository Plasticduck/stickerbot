# StickerBot Changelog

Changes made during the iterative improvement session, most recent first.

## Configurable request item
- Added a "What to ask for" input with `stickers` as the default.
  - Python: `run_bot` prompts for the item; threaded through `run_one` → `compose(item=...)`.
  - Node: added `#item` input in [public/index.html](public/index.html), posted from [public/app.js](public/app.js), stored on `current.item` in [src/orchestrator.js](src/orchestrator.js), and passed to `composeEmail({ item })` in [src/compose.js](src/compose.js).
- `COMPOSE_SYSTEM` no longer hardcodes "stickers or small swag". The user prompt injects the requested item and tells the model to use that exact word in the ask (no silent substitution back to "stickers"/"swag").

## Compose factual discipline
- Banned any specific factual claim about the organization: conference, division, subdivision (FBS/FCS/D2/D3), league, years, rankings, records, championships, coach or player names, locations, founding dates. Guessing wrong is worse than omitting.
  - Triggered by Kennesaw being described as FCS Big South in one email and Presbyterian treated as FBS in another.
- Banned invented relationships: no claiming to be an alum, student, former employee, constituent, resident, local, customer, donor, member, season ticket holder, or subscriber.
  - Triggered by a "constituent" claim in a message to Bernie Sanders while the return address is in Texas.
- Banned geographic proximity claims ("I'm from your area", "a fellow [state]er", "a local").
- Banned political / religious / ideological / values alignment claims. Admiration must stay generic and aesthetic.
- Mirrored these rules in both [stickerbot.py](stickerbot.py) `COMPOSE_SYSTEM` and [src/compose.js](src/compose.js) `SYSTEM`.

## Session dedup false positives
- Fixed orgs being flagged "already emailed this session" when they hadn't been contacted.
- Root cause: at queue-pop, the candidate's own discovery domain was pre-added to `contacted_domains`. When `run_one` resolved the email address, its domain usually matched the discovery domain, so the candidate was flagged as a duplicate of itself.
- Fix: only add name + normalized name at pop. A resolved domain is only added to `contacted_domains` after a successful send.

## MSGID lookup CLI
- Added `python stickerbot.py lookup <msgid>` (also `--lookup` / `-l`) to view any previously-sent email by Message-ID.
- Lookup sources, in order:
  1. Local JSONL log at `~/.stickerbot_sent.jsonl` (written after every successful send).
  2. IMAP `HEADER Message-ID` SEARCH + RFC822 FETCH against the Sent folder.
- Added helpers: `normalize_msgid`, `append_sent_log`, `lookup_in_local_log`, `imap_fetch_by_msgid`, `_print_email_record`, `cmd_lookup`.

## Terminal stability
- Previously, any exception outside the narrow `RateLimitError` catch killed the Python process, closing a double-clicked terminal window before the error could be read.
- Broadened the per-candidate catch in `run_bot` from `except RateLimitError` to `except Exception` so a single bad candidate never kills the whole run.
- Added a last-resort `except Exception` around the main loop with `traceback.print_exc()`.
- Wrapped `save_config()` so config-write errors never take the process down.
- Added an always-pause-on-exit (`input("press Enter to exit...")`) in `main()` so the console stays open on crash or normal finish.

## JSON preamble handling
- Sonnet occasionally narrated (e.g. "I need to identify NCAA Group of Five...") before emitting the JSON object, causing strict `parse_json` to fail with "bad discovery JSON".
- Added `extract_json_object()`: a brace-depth scanner that tracks string literals and escape sequences, collects every complete top-level `{...}` region, and returns the last one that parses. Tolerates markdown fences, preambles, and trailing text.
- Mirrored as `extractJsonObject()` in [src/discover.js](src/discover.js).

## Silent seed fallback removed
- Previously, when the discovery API call failed, the orchestrator silently fell back to `SEED_COMPANIES` (a generic tech list: Mozilla, GitHub, etc.), ignoring the user's agenda.
- Triggered by an "AGENDA: group of 6 football teams" run that emailed Mozilla.
- Fix: if an agenda is set and discovery fails, halt loudly with the underlying API error instead of switching categories. Seed fallback is only allowed when the user specified no agenda at all.
- Applied to both [stickerbot.py](stickerbot.py) and [src/orchestrator.js](src/orchestrator.js).

## Agenda qualifier enforcement + Sonnet upgrade
- Previously, "group of 6 ncaa football teams" was returning Texas and Houston (both Power-conference Big 12 schools).
- Upgraded discovery to Claude Sonnet 4.6 (`claude-sonnet-4-6`, $3/$15 per MTok). Compose and web-search stay on Haiku 4.5 for cost.
- Added `DISCOVERY_MODEL` export and threaded `model` through `complete()` / `estimateCost()` in [src/anthropic.js](src/anthropic.js); mirrored the constants in [stickerbot.py](stickerbot.py).
- Rewrote `DISCOVER_SYSTEM` / `buildUserPrompt` with:
  - A two-rule framework: **KIND match** (entry must BE an instance of the agenda category, not a sponsor/supplier/partner) and **QUALIFIER match** (every narrowing qualifier in the agenda must hold for each entry as of today).
  - Worked examples: "Group of Five FBS" (Memphis/Tulane/Boise State valid; Texas/Houston/Alabama/Presbyterian invalid), "Power Four" (inverse), "FBS D1" (all FBS valid; FCS invalid), "indie bookstores", "craft breweries in Texas".
  - Explicit FCS negative examples (Presbyterian, Dartmouth, Yale, Montana, NDSU).
  - Subdivision reminder: any FBS-specific agenda excludes all FCS programs.
  - "Fewer well-vetted entries beats one wrong entry."
- Lowered discovery `temperature` to 0.2 and raised `maxTokens` to 1200.

## Agenda obedience
- Previously, "FBS D1 Football Teams" was emailing New Balance instead of schools.
- Rewrote the discovery prompt so the agenda defines the literal target category, and the model must produce instances of that category — not sponsors, suppliers, or tangentially related companies.
- Updated `WEB_SEARCH_SYSTEM` / `SEARCH_SYSTEM` to handle schools and teams (athletics / fan-mail / alumni contacts, `.edu` and dedicated athletics domains) rather than only company-style contact pages.

## Baseline (pre-existing, for reference)
- Two parallel implementations share the same behavior:
  - Python single-file CLI at [stickerbot.py](stickerbot.py).
  - Node/Express + SQLite + static UI at [server.js](server.js), [src/](src/), [public/](public/).
- Discovery → web-search address lookup → compose → SMTP send (Namecheap, 45 s inter-send delay) → IMAP append-to-Sent → IMAP verify.
- Session-scoped dedup by exact name, normalized name, domain, and address.
- Per-run budget cap and max-email cap.
