#!/usr/bin/env python3
"""
StickerBot - polite AI sticker-request bot.

Single-file Python edition. Requires Python 3.9+. No external packages.
First run walks through setup; config is saved to ~/.stickerbot.json.
"""

from __future__ import annotations

import json
import os
import re
import smtplib
import sys
import time
import threading
import urllib.error
import urllib.request
import imaplib
from smtplib import SMTPRecipientsRefused, SMTPResponseException, SMTPSenderRefused
from email.message import EmailMessage
from email.utils import make_msgid, formatdate
from getpass import getpass
from pathlib import Path
from typing import Any

# -----------------------------------------------------------------------------
# Built-in defaults (Benjamin's account). These populate the "DEFAULT" options
# in the setup wizard. Edit freely.
# -----------------------------------------------------------------------------
DEFAULT_ANTHROPIC_KEY = ""
DEFAULT_BUDGET_USD = 1.50

DEFAULT_EMAIL_USER = ""
DEFAULT_EMAIL_PASS = ""
DEFAULT_FROM_NAME = ""
DEFAULT_SMTP_HOST = "mail.privateemail.com"
DEFAULT_SMTP_PORT = 465
DEFAULT_IMAP_HOST = "mail.privateemail.com"
DEFAULT_IMAP_PORT = 993
DEFAULT_SENT_FOLDER = "Sent"

MODEL = "claude-haiku-4-5-20251001"
# Haiku 4.5: $1/MTok input, $5/MTok output.
PRICE_IN_PER_MTOK = 1.0
PRICE_OUT_PER_MTOK = 5.0

# Discovery uses a smarter model so agenda categories get interpreted correctly
# (e.g. knowing which schools are FBS "Group of Five" vs. Power Five, which
# conference a school joined recently, etc.). Sonnet 4.6 pricing: $3 / $15 per MTok.
DISCOVERY_MODEL = "claude-sonnet-4-6"
DISCOVERY_PRICE_IN_PER_MTOK = 3.0
DISCOVERY_PRICE_OUT_PER_MTOK = 15.0

# Per-email cost estimate. Web search adds $0.01 per search (2-3 per company) +
# tokens; Sonnet-powered discovery share + Haiku compose add a few tenths of a cent.
PER_EMAIL_COST = 0.025

# Web-search tool pricing.
WEB_SEARCH_COST_PER_USE = 0.01

# Delay between successful sends. Namecheap Private Email caps around
# 150/hour at the account level, so 45s (~80/hour) keeps comfortable headroom.
SEND_DELAY_SECONDS = 45

# Substrings in SMTP error responses that indicate account-level rate limiting.
RATE_LIMIT_PATTERNS = (
    "sending limit",
    "rate limit",
    "too many",
    "quota exceeded",
    "policy rejection",
)


class RateLimitError(Exception):
    """Raised when the SMTP server signals we have exceeded a sending quota."""

CONFIG_PATH = Path.home() / ".stickerbot.json"
SENT_LOG_PATH = Path.home() / ".stickerbot_sent.jsonl"

# -----------------------------------------------------------------------------
# Terminal styling
# -----------------------------------------------------------------------------


class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"
    ORANGE = "\033[38;5;208m"
    AMBER = "\033[38;5;214m"
    GRAY = "\033[38;5;240m"
    LIGHT = "\033[38;5;250m"


def enable_vt() -> None:
    # Enables ANSI escape processing on Windows 10+ conhost / Windows Terminal.
    if os.name == "nt":
        os.system("")


def clear_screen() -> None:
    sys.stdout.write("\033[2J\033[H")
    sys.stdout.flush()


def hide_cursor() -> None:
    sys.stdout.write("\033[?25l")
    sys.stdout.flush()


def show_cursor() -> None:
    sys.stdout.write("\033[?25h")
    sys.stdout.flush()


def type_line(text: str, delay: float = 0.005) -> None:
    for ch in text:
        sys.stdout.write(ch)
        sys.stdout.flush()
        if ch.strip():
            time.sleep(delay)
    sys.stdout.write("\n")


LOGO_LINES = [
    "  ███████╗████████╗██╗ ██████╗██╗  ██╗███████╗██████╗ ",
    "  ██╔════╝╚══██╔══╝██║██╔════╝██║ ██╔╝██╔════╝██╔══██╗",
    "  ███████╗   ██║   ██║██║     █████╔╝ █████╗  ██████╔╝",
    "  ╚════██║   ██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗",
    "  ███████║   ██║   ██║╚██████╗██║  ██╗███████╗██║  ██║",
    "  ╚══════╝   ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
]


def print_logo() -> None:
    sys.stdout.write("\n")
    for line in LOGO_LINES:
        sys.stdout.write(f"{C.ORANGE}{line}{C.RESET}\n")
        sys.stdout.flush()
        time.sleep(0.04)
    sys.stdout.write(f"{C.AMBER}                        BOT{C.RESET}\n")
    sys.stdout.write(f"{C.GRAY}           free stickers on autopilot{C.RESET}\n")
    sys.stdout.write("\n")
    sys.stdout.flush()


# -----------------------------------------------------------------------------
# Keyboard input (cross-platform single-key reader)
# -----------------------------------------------------------------------------


def _read_key() -> str:
    if os.name == "nt":
        import msvcrt

        ch = msvcrt.getch()
        if ch in (b"\x00", b"\xe0"):
            ch2 = msvcrt.getch()
            return {
                b"H": "up",
                b"P": "down",
                b"K": "left",
                b"M": "right",
            }.get(ch2, "")
        if ch == b"\r":
            return "enter"
        if ch == b"\x03":
            raise KeyboardInterrupt
        if ch == b"\x1b":
            return "esc"
        try:
            return ch.decode("utf-8", errors="ignore")
        except Exception:
            return ""
    else:
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            if ch == "\x1b":
                # arrow keys: ESC [ A/B/C/D
                ch2 = sys.stdin.read(1)
                if ch2 == "[":
                    ch3 = sys.stdin.read(1)
                    return {
                        "A": "up",
                        "B": "down",
                        "C": "right",
                        "D": "left",
                    }.get(ch3, "")
                return "esc"
            if ch in ("\r", "\n"):
                return "enter"
            if ch == "\x03":
                raise KeyboardInterrupt
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)


def select_menu(prompt: str, options: list[str], default: int = 0) -> int:
    """Arrow-key selectable menu. Returns the chosen index."""
    idx = default
    sys.stdout.write(f"{C.BOLD}?{C.RESET} {prompt}\n")
    for _ in options:
        sys.stdout.write("\n")

    def render() -> None:
        sys.stdout.write(f"\033[{len(options)}A")
        for i, opt in enumerate(options):
            sys.stdout.write("\r\033[K")
            if i == idx:
                sys.stdout.write(f"  {C.ORANGE}>{C.RESET} {C.BOLD}{opt}{C.RESET}\n")
            else:
                sys.stdout.write(f"    {C.GRAY}{opt}{C.RESET}\n")
        sys.stdout.flush()

    hide_cursor()
    try:
        render()
        while True:
            k = _read_key()
            if k == "up":
                idx = (idx - 1) % len(options)
            elif k == "down":
                idx = (idx + 1) % len(options)
            elif k == "enter":
                break
            render()
    finally:
        show_cursor()
    sys.stdout.write("\n")
    return idx


def ask(prompt: str, default: str = "") -> str:
    suffix = f" {C.GRAY}[{default}]{C.RESET}" if default else ""
    try:
        val = input(f"{C.BOLD}?{C.RESET} {prompt}{suffix} ").strip()
    except EOFError:
        val = ""
    return val or default


def ask_secret(prompt: str) -> str:
    return getpass(f"? {prompt} ")


# -----------------------------------------------------------------------------
# Spinner
# -----------------------------------------------------------------------------


class Spinner:
    FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

    def __init__(self, label: str) -> None:
        self.label = label
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "Spinner":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join()
        # clear line
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()

    def set_label(self, label: str) -> None:
        self.label = label

    def _run(self) -> None:
        i = 0
        hide_cursor()
        try:
            while not self._stop.is_set():
                frame = self.FRAMES[i % len(self.FRAMES)]
                sys.stdout.write(f"\r  {C.ORANGE}{frame}{C.RESET} {self.label}")
                sys.stdout.flush()
                time.sleep(0.08)
                i += 1
        finally:
            show_cursor()


# -----------------------------------------------------------------------------
# Config load/save
# -----------------------------------------------------------------------------


def load_config() -> dict[str, Any] | None:
    if not CONFIG_PATH.exists():
        return None
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_config(cfg: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# -----------------------------------------------------------------------------
# Setup wizard
# -----------------------------------------------------------------------------


def setup_wizard() -> dict[str, Any]:
    sys.stdout.write(f"{C.BOLD}Welcome to StickerBot setup.{C.RESET}\n\n")

    key_choice = select_menu(
        "What Claude API Key are you using?",
        [
            f"Benjamin's Key (DEFAULT)  {C.GRAY}budget cap ${DEFAULT_BUDGET_USD:.2f}{C.RESET}",
            "Custom Key",
        ],
        default=0,
    )
    if key_choice == 0:
        anthropic_key = DEFAULT_ANTHROPIC_KEY
        budget = DEFAULT_BUDGET_USD
    else:
        anthropic_key = ask_secret("Paste your Anthropic API key").strip()
        while not anthropic_key.startswith("sk-ant-"):
            sys.stdout.write(f"{C.RED}  key must start with sk-ant-{C.RESET}\n")
            anthropic_key = ask_secret("Paste your Anthropic API key").strip()
        raw_budget = ask("Budget cap in USD", default="5.00")
        try:
            budget = float(raw_budget)
        except ValueError:
            budget = 5.00

    sys.stdout.write("\n")

    email_choice = select_menu(
        "What email are you using?",
        [
            f"{DEFAULT_EMAIL_USER} (DEFAULT)",
            "Custom mail server",
        ],
        default=0,
    )
    if email_choice == 0:
        email_user = DEFAULT_EMAIL_USER
        email_pass = DEFAULT_EMAIL_PASS
        from_name = DEFAULT_FROM_NAME
        smtp_host = DEFAULT_SMTP_HOST
        smtp_port = DEFAULT_SMTP_PORT
        imap_host = DEFAULT_IMAP_HOST
        imap_port = DEFAULT_IMAP_PORT
    else:
        email_user = ask("Email address").strip()
        email_pass = ask_secret("Email password").strip()
        from_name = ask("Display name", default="Benjamin Jowers").strip()
        smtp_host = ask("SMTP host", default="smtp.example.com").strip()
        smtp_port = int(ask("SMTP port", default="465") or "465")
        imap_host = ask("IMAP host", default=smtp_host).strip()
        imap_port = int(ask("IMAP port", default="993") or "993")

    sys.stdout.write("\n")
    sys.stdout.write(f"{C.BOLD}Address to get stickers.{C.RESET} ")
    sys.stdout.write(f"{C.GRAY}press Enter to begin{C.RESET}\n")
    try:
        input("")
    except EOFError:
        pass

    street = ask("Street address (STREET ONLY)").strip()
    while not street:
        street = ask("Street address cannot be empty").strip()
    city = ask("City").strip()
    while not city:
        city = ask("City cannot be empty").strip()
    zip_code = ask("ZIP").strip()
    while not zip_code:
        zip_code = ask("ZIP cannot be empty").strip()
    state = ask("State").strip()
    while not state:
        state = ask("State cannot be empty").strip()

    address = f"{street}, {city}, {state} {zip_code}"

    cfg = {
        "anthropic_key": anthropic_key,
        "budget_usd": budget,
        "email_user": email_user,
        "email_pass": email_pass,
        "from_name": from_name,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "imap_host": imap_host,
        "imap_port": imap_port,
        "sent_folder": DEFAULT_SENT_FOLDER,
        "address": {
            "street": street,
            "city": city,
            "state": state,
            "zip": zip_code,
            "formatted": address,
        },
        "contacted": [],
    }
    save_config(cfg)
    sys.stdout.write(
        f"\n{C.GREEN}✓{C.RESET} setup complete, config saved to {C.GRAY}{CONFIG_PATH}{C.RESET}\n\n"
    )
    return cfg


# -----------------------------------------------------------------------------
# Seed company list (known to have sticker / community programs)
# -----------------------------------------------------------------------------

SEED_COMPANIES = [
    {"name": "GitHub", "domain": "github.com", "emails": ["shop@github.com", "press@github.com"]},
    {"name": "GitLab", "domain": "gitlab.com", "emails": ["contact@gitlab.com"]},
    {"name": "DigitalOcean", "domain": "digitalocean.com", "emails": ["community@digitalocean.com"]},
    {"name": "Netlify", "domain": "netlify.com", "emails": ["press@netlify.com", "hello@netlify.com"]},
    {"name": "Vercel", "domain": "vercel.com", "emails": ["press@vercel.com"]},
    {"name": "Cloudflare", "domain": "cloudflare.com", "emails": ["press@cloudflare.com"]},
    {"name": "MongoDB", "domain": "mongodb.com", "emails": ["community@mongodb.com"]},
    {"name": "Postman", "domain": "postman.com", "emails": ["community@postman.com"]},
    {"name": "JetBrains", "domain": "jetbrains.com", "emails": ["info@jetbrains.com"]},
    {"name": "Docker", "domain": "docker.com", "emails": ["community@docker.com"]},
    {"name": "HashiCorp", "domain": "hashicorp.com", "emails": ["press@hashicorp.com"]},
    {"name": "Red Hat", "domain": "redhat.com", "emails": ["press@redhat.com"]},
    {"name": "Mozilla", "domain": "mozilla.org", "emails": ["press@mozilla.com"]},
    {"name": "DuckDuckGo", "domain": "duckduckgo.com", "emails": ["press@duckduckgo.com"]},
    {"name": "Framework", "domain": "frame.work", "emails": ["press@frame.work"]},
    {"name": "System76", "domain": "system76.com", "emails": ["press@system76.com"]},
    {"name": "Raspberry Pi", "domain": "raspberrypi.com", "emails": ["press@raspberrypi.com"]},
    {"name": "Adafruit", "domain": "adafruit.com", "emails": ["press@adafruit.com"]},
    {"name": "SparkFun", "domain": "sparkfun.com", "emails": ["press@sparkfun.com"]},
    {"name": "Arduino", "domain": "arduino.cc", "emails": ["press@arduino.cc"]},
    {"name": "Hugging Face", "domain": "huggingface.co", "emails": ["press@huggingface.co"]},
    {"name": "Replit", "domain": "replit.com", "emails": ["press@replit.com"]},
    {"name": "Linear", "domain": "linear.app", "emails": ["hello@linear.app"]},
    {"name": "Figma", "domain": "figma.com", "emails": ["press@figma.com"]},
    {"name": "Notion", "domain": "notion.so", "emails": ["press@notion.so"]},
    {"name": "1Password", "domain": "1password.com", "emails": ["press@1password.com"]},
    {"name": "Proton", "domain": "proton.me", "emails": ["press@proton.me"]},
    {"name": "Fastmail", "domain": "fastmail.com", "emails": ["press@fastmail.com"]},
    {"name": "Supabase", "domain": "supabase.com", "emails": ["hello@supabase.com"]},
    {"name": "PlanetScale", "domain": "planetscale.com", "emails": ["hello@planetscale.com"]},
    {"name": "Stripe", "domain": "stripe.com", "emails": ["press@stripe.com"]},
    {"name": "Twilio", "domain": "twilio.com", "emails": ["press@twilio.com"]},
    {"name": "Ubiquiti", "domain": "ui.com", "emails": ["press@ui.com"]},
    {"name": "Logitech", "domain": "logitech.com", "emails": ["press@logitech.com"]},
    {"name": "Sonos", "domain": "sonos.com", "emails": ["press@sonos.com"]},
]

BAD_LOCALS = {
    "noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon",
    "postmaster", "abuse", "privacy", "legal", "security", "unsubscribe", "compliance",
}


def find_seed(name: str, domain: str) -> dict | None:
    n = (name or "").strip().lower()
    d = (domain or "").strip().lower()
    for s in SEED_COMPANIES:
        if s["name"].lower() == n or (d and s["domain"].lower() == d):
            return s
    return None


_NAME_SUFFIXES = (" inc", " llc", " ltd", " corp", " corporation", " co")


def norm_org_name(name: str) -> str:
    """Light normalization for session dedup: lowercase, strip punctuation,
    collapse whitespace, and drop trailing corporate suffixes. We do NOT
    strip mascots, 'Football', 'University', etc. because those collide
    across distinct schools (e.g. LSU Tigers vs. Auburn Tigers)."""
    if not name:
        return ""
    s = name.strip().lower()
    for ch in ".,'\"()/&":
        s = s.replace(ch, "")
    s = " ".join(s.split())
    for sfx in _NAME_SUFFIXES:
        if s.endswith(sfx):
            s = s[: -len(sfx)]
            break
    return s.strip()


def norm_domain(domain: str) -> str:
    d = (domain or "").strip().lower()
    if d.startswith("www."):
        d = d[4:]
    return d


def _is_bad_local(addr: str) -> bool:
    return addr.split("@", 1)[0].lower() in BAD_LOCALS


def _extract_last_json(text: str) -> dict | None:
    """Grab the last parseable {...} block (Claude may narrate before it)."""
    candidates = re.findall(r"\{[^{}]*\}", text, re.DOTALL)
    for c in reversed(candidates):
        try:
            return json.loads(c)
        except Exception:
            continue
    # fall back to full-text parse after stripping code fences
    try:
        return parse_json(text)
    except Exception:
        return None


def extract_json_object(text: str) -> dict | None:
    """Return the last complete, top-level JSON object in text.

    Uses a brace-depth scan so it can recover JSON with nested arrays/objects
    even when the model narrates before it (e.g. 'I need to identify ...' then
    the actual JSON). Ignores braces inside string literals."""
    if not text:
        return None
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
    stripped = re.sub(r"\s*```\s*$", "", stripped)
    results: list[str] = []
    depth = 0
    start = -1
    in_str = False
    escape = False
    for i, ch in enumerate(stripped):
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    results.append(stripped[start:i + 1])
                    start = -1
    for candidate in reversed(results):
        try:
            return json.loads(candidate)
        except Exception:
            continue
    return None


WEB_SEARCH_SYSTEM = """You are a contact-lookup assistant. You will be given an organization (company, school, team, nonprofit, etc.) and you must find their REAL, PUBLISHED contact email address by searching the live web.

Rules:
1. Use the web_search tool. Actually search. Do not answer from memory.
2. Look at the organization's official website (contact page, support page, about page, athletics/fan-mail page for teams, communications/alumni page for schools), and reputable directory sites.
3. Only return an email address you actually saw on a real page during search. Never guess, never invent, never infer a pattern.
4. The address must be at the organization's own domain or a clearly owned subdomain. For universities that is usually the .edu domain. For athletics programs it may be a dedicated athletics site (rolltide.com, mgoblue.com, etc.).
5. Prefer addresses meant for human replies. For companies: customer service, community, hello, contact. For schools/teams: athletics communications, fan mail, alumni relations, general info. Avoid noreply, privacy, legal, abuse, compliance.
6. If no real published address can be found on the web, return null. Do NOT guess.
7. Output strict JSON as the LAST thing in your response."""


def web_search_for_email(
    api_key: str, name: str, domain: str
) -> tuple[str | None, str, str | None, str, float, int]:
    """Returns (address, confidence, source_url, note, cost, search_uses)."""
    user = f"""Find the real published contact email address for this company by searching the web.

Company: {name}{f'\nWebsite: https://{domain}' if domain else ''}

Search for their actual contact page. Read what the page says. Report only an email address you literally saw printed on a real page.

Return JSON as the last thing in your response:
{{"address":"real@address.com","confidence":"high|medium|low","source_url":"https://page-where-you-found-it.com/contact","note":"short quote or explanation of where it was found"}}

If no real email is visible anywhere you searched, return:
{{"address":null,"confidence":"low","source_url":null,"note":"reason (e.g. only a contact form; site behind login; no email exposed)"}}"""
    try:
        text, cost, searches = anthropic_complete_with_web_search(
            api_key, WEB_SEARCH_SYSTEM, user, max_tokens=1500, temperature=0.0, max_searches=3
        )
    except AnthropicError as e:
        return None, "low", None, f"api error: {e}", 0.0, 0

    parsed = _extract_last_json(text)
    if not parsed:
        return None, "low", None, "no JSON in response", cost, searches

    addr = parsed.get("address")
    conf = parsed.get("confidence", "low")
    src = parsed.get("source_url") or None
    note = parsed.get("note", "")

    if not addr or not isinstance(addr, str):
        return None, conf, src, note or "not found", cost, searches

    addr = addr.strip().lower()
    if "@" not in addr or _is_bad_local(addr):
        return None, "low", src, "filtered", cost, searches
    return addr, conf, src, note, cost, searches


def pick_address(
    api_key: str,
    name: str,
    domain: str,
) -> tuple[str | None, str, float, str | None, str, int]:
    """Returns (address, source, cost, source_url, note, search_uses).
    address is None if no real email was found (caller should skip the company)."""
    hit = find_seed(name, domain)
    if hit and hit.get("emails"):
        return hit["emails"][0], "seed", 0.0, None, "", 0

    addr, conf, src, note, cost, searches = web_search_for_email(api_key, name, domain)
    if addr:
        return addr, f"web-search ({conf})", cost, src, note, searches
    return None, "not-found", cost, src, note or "no real email found", searches


# -----------------------------------------------------------------------------
# Anthropic client (stdlib HTTP)
# -----------------------------------------------------------------------------


class AnthropicError(Exception):
    pass


def _anthropic_request(payload: dict, api_key: str, timeout: float = 90.0) -> dict:
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise AnthropicError(f"HTTP {e.code}: {body[:200]}") from e
    except urllib.error.URLError as e:
        raise AnthropicError(f"network: {e.reason}") from e


def _token_cost(usage: dict, model: str = MODEL) -> float:
    if model == DISCOVERY_MODEL:
        pin, pout = DISCOVERY_PRICE_IN_PER_MTOK, DISCOVERY_PRICE_OUT_PER_MTOK
    else:
        pin, pout = PRICE_IN_PER_MTOK, PRICE_OUT_PER_MTOK
    return (
        usage.get("input_tokens", 0) * pin
        + usage.get("output_tokens", 0) * pout
    ) / 1_000_000


def anthropic_complete(
    api_key: str,
    system: str,
    user: str,
    max_tokens: int = 600,
    temperature: float = 0.8,
    model: str = MODEL,
) -> tuple[str, float]:
    data = _anthropic_request(
        {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
        api_key,
    )
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return text, _token_cost(data.get("usage", {}), model)


def anthropic_complete_with_web_search(
    api_key: str,
    system: str,
    user: str,
    max_tokens: int = 1500,
    temperature: float = 0.0,
    max_searches: int = 3,
) -> tuple[str, float, int]:
    """Returns (text, cost, search_uses)."""
    data = _anthropic_request(
        {
            "model": MODEL,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "tools": [
                {
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": max_searches,
                }
            ],
            "messages": [{"role": "user", "content": user}],
        },
        api_key,
    )
    content = data.get("content", [])
    text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
    search_uses = sum(
        1 for b in content if b.get("type") == "server_tool_use" and b.get("name") == "web_search"
    )
    cost = _token_cost(data.get("usage", {})) + search_uses * WEB_SEARCH_COST_PER_USE
    return text, cost, search_uses


def parse_json(text: str) -> Any:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return json.loads(cleaned)


# -----------------------------------------------------------------------------
# Discovery & composition
# -----------------------------------------------------------------------------


DISCOVER_SYSTEM = (
    "You generate lists of real organizations the user wants to contact for free stickers or swag. "
    "The user's agenda defines the EXACT kind of organization to target. If the agenda names a category "
    "(e.g. 'FBS D1 football teams', 'state universities', 'indie game studios'), the list MUST be organizations "
    "of that category themselves, not their sponsors, suppliers, equipment makers, or other tangential companies. "
    "If the agenda is empty or general, pick well-known companies with sticker programs.\n\n"
    "Output format: respond with ONLY a JSON object. No preamble, no thinking aloud, no explanation, "
    "no markdown fences. Your entire response must start with `{` and end with `}`. Do your reasoning "
    "internally and emit only the final JSON."
)


def discover(api_key: str, agenda: str, count: int, exclude: list[str]) -> tuple[list[dict], float]:
    if agenda:
        agenda_line = (
            f"AGENDA (read this literally, including every qualifier): {agenda}\n\n"
            "Two hard rules:\n"
            "1. KIND match: every entry must BE an instance of the agenda category, not a sponsor, supplier, partner, parent company, or other related industry.\n"
            "2. QUALIFIER match: any narrowing qualifier in the agenda (conference, division, state, size, era, genre, etc.) must be satisfied by EACH entry individually. If you are not certain an entry satisfies the qualifier as of today, DO NOT include it, replace it with one you are sure about.\n\n"
            "Worked examples:\n"
            "  agenda 'Group of Five FBS football programs' -> Group of Five = American, Conference USA, MAC, Mountain West, Sun Belt. Valid: Memphis, Tulane, Boise State, Appalachian State, Coastal Carolina. INVALID: Texas (Big 12, Power conference), Houston (Big 12 since 2023, Power conference), Alabama (SEC), Ohio State (Big Ten), Notre Dame (independent but Power tier), Presbyterian (FCS Pioneer League, not FBS at all), Kennesaw State (FBS now but in CUSA, acceptable; note they are no longer FCS Big South as of 2024), any FCS program.\n"
            "  agenda 'Power Four conference football programs' -> SEC, Big Ten, Big 12, ACC only. Texas, Houston, Alabama, Ohio State all valid. Memphis, Tulane, Boise State INVALID.\n"
            "  agenda 'FBS D1 football teams' (FBS only, no narrowing) -> any FBS program qualifies. INVALID: any FCS school (Presbyterian, Dartmouth, Yale, Montana, NDSU are FCS — do NOT include them).\n"
            "  agenda 'indie bookstores' -> Powell's Books, The Strand, Parnassus Books. INVALID: Penguin Random House, Amazon, chain stores.\n"
            "  agenda 'craft breweries in Texas' -> Saint Arnold, Jester King, Austin Beerworks. INVALID: Anheuser-Busch, non-Texas breweries, distributors.\n\n"
            "College football subdivision reminder: FBS and FCS are DIFFERENT subdivisions of Division I. An agenda that says 'FBS', 'Group of Five', 'Group of Six', 'Power Four/Five', or names specific FBS conferences (AAC, CUSA, MAC, Mountain West, Sun Belt, SEC, Big Ten, Big 12, ACC) excludes all FCS programs. If you are not sure whether a specific program is FBS or FCS in the current season, DO NOT include it.\n\n"
            "Before you write the JSON: for every entry, mentally verify BOTH rules and the subdivision/conference as of the current season. If you feel any uncertainty about an entry's classification today, replace it with one you are confident about. It is better to return fewer well-vetted entries than to include a wrong one."
        )
        tail_reminder = (
            f"Final check before outputting: for the agenda `{agenda}`, each entry must satisfy every qualifier in that phrase. "
            "Conference/division/geographic/size qualifiers are not decorative, they exclude everything outside the set."
        )
    else:
        agenda_line = (
            "No specific agenda. Pick a varied mix of tech, hardware, dev tools, and open-source friendly "
            "companies known for sticker programs."
        )
        tail_reminder = ""
    exclude_line = (
        f"Do NOT include any of these already-contacted organizations: {', '.join(exclude)}."
        if exclude
        else ""
    )
    user = f"""{agenda_line}
{exclude_line}

Return exactly {count} organizations as JSON:
{{"companies":[{{"name":"OrganizationName","domain":"example.com","reason":"short phrase tied to the agenda"}}]}}

Rules:
- Real organizations only, matching the agenda category literally.
- "domain" is the organization's own primary website (e.g. "alabama.edu" for University of Alabama, not a sponsor's site).
- "reason" under 12 words and must explain how this entry IS the agenda category.
- JSON only.

{tail_reminder}
"""
    text, cost = anthropic_complete(
        api_key,
        DISCOVER_SYSTEM,
        user,
        max_tokens=1200,
        temperature=0.2,
        model=DISCOVERY_MODEL,
    )
    data = extract_json_object(text)
    if not data:
        raise AnthropicError(f"bad discovery JSON: {text[:200]}")
    return data.get("companies", []), cost


COMPOSE_SYSTEM = (
    "You write short, warm, human-sounding emails from a real person named Benjamin "
    "Jowers asking an organization (company, school, team, nonprofit, etc.) for a small free item. "
    "The specific item to request is given in the user message; use exactly that word or phrase in the ask. "
    "Tailor the greeting and tone to the type of organization: address a university athletics office differently "
    "from a software company. If the organization is a school or sports team, acknowledge that directly (fan of "
    "the program, following them, etc.) rather than treating it like a tech company.\n\n"
    "CRITICAL factual discipline:\n"
    "- Do NOT state the organization's conference, division, subdivision (FBS / FCS / D2 / D3), league, or any other classification. You may not know the current one and guessing wrong is worse than leaving it out.\n"
    "- Do NOT state years, rankings, records, championships, coach names, player names, locations, dates founded, or any specific factual claim about the organization. If you do not have verified knowledge, you cannot include the fact.\n"
    "- Do NOT invent a relationship. Never claim to be an alum, student, former employee, constituent, resident, local, customer, donor, member, season ticket holder, subscriber, or anything similar. The sender is a stranger asking politely for the requested item, nothing more.\n"
    "- Do NOT claim geographic proximity or shared identity. Do not say 'I'm from your area', 'a fellow [state]er', 'a local', 'from [city/state]', or anything that asserts where the sender lives relative to the recipient. The sender's mailing address speaks for itself; do not reference it in the body beyond placing it under the signature.\n"
    "- Do NOT assert political, religious, ideological, or values alignment. Never say the sender agrees with the recipient's positions, supports their causes, champions what they champion, or believes in their mission. Keep it to liking the brand/program/team aesthetically.\n"
    "- Keep any admiration generic: 'following the program', 'love what you do', 'fan of the team', 'appreciate the brand'. Avoid specific compliments that could be wrong.\n\n"
    "Absolute rules:\n"
    "- NEVER use em dashes or en dashes. Use commas, periods, or parentheses.\n"
    "- Sound like a real person. No marketing tone. No 'I hope this email finds you well.'\n"
    "- Be brief. 3 to 5 short sentences.\n"
    "- Be kind and polite. Do not beg. Do not apologize for writing.\n"
    "- Sign off as 'Benjamin Jowers'.\n"
    "- Output strict JSON only."
)


def postprocess(body: str) -> str:
    return body.replace("\u2014", ",").replace("\u2013", ",")


def compose(
    api_key: str,
    company: str,
    reason: str,
    agenda: str,
    address: str,
    item: str = "stickers",
) -> tuple[str, str, float]:
    item = (item or "stickers").strip() or "stickers"
    user = f"""Organization: {company}
{f'Why they fit the agenda: {reason}' if reason else ''}
{f'My interest / agenda: {agenda}' if agenda else ''}
What the sender is asking for: {item}
Mailing address (put it on the line directly after the signature): {address}

Return JSON: {{"subject":"...","body":"..."}}

Body structure:
1. Warm one-line greeting.
2. 2 to 4 short sentences of substance.
3. A simple polite ask for {item}. Use the word/phrase "{item}" naturally in the ask; do not substitute or paraphrase to "stickers" or "swag" unless those are literally what was requested.
4. "Thanks," on its own line.
5. "Benjamin Jowers" on its own line.
6. The mailing address on the line directly after the name.

Do not use em dashes or en dashes. No company, title, or phone. Only name and mailing address in the signature.
"""
    text, cost = anthropic_complete(api_key, COMPOSE_SYSTEM, user, max_tokens=600, temperature=0.8)
    try:
        data = parse_json(text)
    except Exception as e:
        raise AnthropicError(f"bad compose JSON: {text[:200]}") from e
    subject = postprocess(str(data.get("subject", "Hello from Benjamin")))
    body = postprocess(str(data.get("body", "")))
    return subject, body, cost


# -----------------------------------------------------------------------------
# Email send (SMTP) + save-to-Sent / verify (IMAP)
# -----------------------------------------------------------------------------


def build_message(cfg: dict, to_addr: str, subject: str, body: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f'"{cfg["from_name"]}" <{cfg["email_user"]}>'
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=cfg["email_user"].split("@", 1)[1])
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)
    return msg


def _is_rate_limit(text: str) -> bool:
    low = text.lower()
    return any(p in low for p in RATE_LIMIT_PATTERNS)


def smtp_send(cfg: dict, msg: EmailMessage) -> None:
    try:
        with smtplib.SMTP_SSL(cfg["smtp_host"], cfg["smtp_port"], timeout=30) as s:
            s.login(cfg["email_user"], cfg["email_pass"])
            s.send_message(msg)
    except SMTPRecipientsRefused as e:
        # e.recipients is {addr: (code, bytes_reason)}
        details = "; ".join(
            f"{addr}: {code} {reason.decode(errors='ignore') if isinstance(reason, bytes) else reason}"
            for addr, (code, reason) in e.recipients.items()
        )
        if _is_rate_limit(details) or any(
            code == 450 for (code, _r) in e.recipients.values()
        ):
            raise RateLimitError(details) from e
        raise RuntimeError(details) from e
    except SMTPSenderRefused as e:
        reason = e.smtp_error.decode(errors="ignore") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        if _is_rate_limit(reason) or e.smtp_code in (421, 450, 452):
            raise RateLimitError(f"sender refused: {e.smtp_code} {reason}") from e
        raise RuntimeError(f"sender refused: {e.smtp_code} {reason}") from e
    except SMTPResponseException as e:
        reason = e.smtp_error.decode(errors="ignore") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        if _is_rate_limit(reason) or e.smtp_code in (421, 450, 452):
            raise RateLimitError(f"{e.smtp_code} {reason}") from e
        raise RuntimeError(f"{e.smtp_code} {reason}") from e


def imap_connect(cfg: dict) -> imaplib.IMAP4_SSL:
    c = imaplib.IMAP4_SSL(cfg["imap_host"], cfg["imap_port"])
    c.login(cfg["email_user"], cfg["email_pass"])
    return c


def _folder_exists(c: imaplib.IMAP4_SSL, folder: str) -> bool:
    typ, data = c.list()
    if typ != "OK" or not data:
        return False
    needle = f'"{folder}"'
    for item in data:
        if item is None:
            continue
        line = item.decode("utf-8", errors="ignore")
        if needle in line or line.endswith(" " + folder):
            return True
    return False


def imap_append_to_sent(cfg: dict, msg: EmailMessage) -> None:
    folder = cfg.get("sent_folder", "Sent")
    c = imap_connect(cfg)
    try:
        if not _folder_exists(c, folder):
            c.create(folder)
            try:
                c.subscribe(folder)
            except Exception:
                pass
        c.append(folder, "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
    finally:
        try:
            c.logout()
        except Exception:
            pass


def normalize_msgid(s: str) -> str:
    """Trim angle brackets and whitespace from a Message-ID for matching."""
    return (s or "").strip().strip("<>").strip()


def append_sent_log(msg: EmailMessage, *, to: str, subject: str, body: str, company: str) -> None:
    """Record one successful send to a local JSONL file so the user can look
    up the full email later by Message-ID without going through IMAP."""
    record = {
        "msgid": normalize_msgid(msg.get("Message-ID", "")),
        "to": to,
        "from": msg.get("From", ""),
        "subject": subject,
        "body": body,
        "company": company,
        "sent_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
    }
    try:
        with SENT_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        # Logging should never crash a live run.
        pass


def lookup_in_local_log(msgid: str) -> dict | None:
    target = normalize_msgid(msgid)
    if not target or not SENT_LOG_PATH.exists():
        return None
    try:
        with SENT_LOG_PATH.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if normalize_msgid(rec.get("msgid", "")) == target:
                    return rec
    except Exception:
        return None
    return None


def imap_fetch_by_msgid(cfg: dict, msgid: str) -> dict | None:
    """Search the Sent folder for a Message-ID and return a dict with the
    raw message bytes + parsed subject/body/headers. Returns None if absent."""
    from email import message_from_bytes
    needle = normalize_msgid(msgid)
    if not needle:
        return None
    folder = cfg.get("sent_folder", "Sent")
    c = imap_connect(cfg)
    try:
        if not _folder_exists(c, folder):
            return None
        typ, _ = c.select(folder)
        if typ != "OK":
            return None
        # HEADER search tolerates both <msgid> and bare msgid forms.
        typ, data = c.search(None, "HEADER", "Message-ID", needle)
        if typ != "OK" or not data or not data[0]:
            return None
        uids = data[0].split()
        if not uids:
            return None
        typ, fetched = c.fetch(uids[-1], "(RFC822)")
        if typ != "OK" or not fetched:
            return None
        raw = None
        for part in fetched:
            if isinstance(part, tuple) and len(part) >= 2 and isinstance(part[1], (bytes, bytearray)):
                raw = bytes(part[1])
                break
        if raw is None:
            return None
        parsed = message_from_bytes(raw)
        # Pull out the plain-text body if there is one.
        body = ""
        if parsed.is_multipart():
            for sub in parsed.walk():
                if sub.get_content_type() == "text/plain":
                    body = sub.get_payload(decode=True).decode(
                        sub.get_content_charset() or "utf-8", errors="replace"
                    )
                    break
        else:
            payload = parsed.get_payload(decode=True)
            if isinstance(payload, (bytes, bytearray)):
                body = payload.decode(
                    parsed.get_content_charset() or "utf-8", errors="replace"
                )
            else:
                body = str(payload or "")
        return {
            "msgid": normalize_msgid(parsed.get("Message-ID", "")),
            "to": parsed.get("To", ""),
            "from": parsed.get("From", ""),
            "subject": parsed.get("Subject", ""),
            "date": parsed.get("Date", ""),
            "body": body,
        }
    finally:
        try:
            c.close()
        except Exception:
            pass
        try:
            c.logout()
        except Exception:
            pass


def imap_verify(cfg: dict, message_id: str, timeout_s: float = 15.0) -> bool:
    folder = cfg.get("sent_folder", "Sent")
    deadline = time.time() + timeout_s
    c = imap_connect(cfg)
    try:
        if not _folder_exists(c, folder):
            return False
        while time.time() < deadline:
            typ, _ = c.select(folder)
            if typ != "OK":
                return False
            typ, data = c.search(None, "HEADER", "Message-ID", message_id)
            if typ == "OK" and data and data[0]:
                return True
            time.sleep(2)
        return False
    finally:
        try:
            c.close()
        except Exception:
            pass
        try:
            c.logout()
        except Exception:
            pass


# -----------------------------------------------------------------------------
# Orchestrator (main loop)
# -----------------------------------------------------------------------------


def print_header(title: str) -> None:
    bar = "─" * max(0, 60 - len(title) - 2)
    sys.stdout.write(f"\n{C.BOLD}{C.ORANGE}── {title} {bar}{C.RESET}\n")


def ok(msg: str) -> None:
    sys.stdout.write(f"  {C.GREEN}✓{C.RESET} {msg}\n")


def warn(msg: str) -> None:
    sys.stdout.write(f"  {C.YELLOW}!{C.RESET} {msg}\n")


def fail(msg: str) -> None:
    sys.stdout.write(f"  {C.RED}x{C.RESET} {msg}\n")


def info(msg: str) -> None:
    sys.stdout.write(f"  {C.GRAY}•{C.RESET} {msg}\n")


def run_one(
    cfg: dict,
    idx: int,
    total: int,
    candidate: dict,
    agenda: str,
    spent: float,
    budget: float,
    contacted_domains: set[str],
    contacted_addrs: set[str],
    item: str = "stickers",
) -> tuple[bool, float]:
    name = candidate.get("name", "?")
    domain = candidate.get("domain", "")
    reason = candidate.get("reason", "")
    print_header(f"[{idx}/{total}] {name}")

    this_cost = 0.0
    with Spinner(f"searching web for {name}'s contact email"):
        addr, source, lookup_cost, source_url, note, searches = pick_address(
            cfg["anthropic_key"], name, domain
        )
    this_cost += lookup_cost
    if not addr:
        warn(f"skipping {name}: no real email found on the web ({note})")
        return False, this_cost

    addr_key = addr.strip().lower()
    resolved_domain = norm_domain(addr_key.split("@", 1)[1] if "@" in addr_key else domain)
    if addr_key in contacted_addrs:
        warn(f"skipping {name}: already emailed {addr} this session")
        return False, this_cost
    if resolved_domain and resolved_domain in contacted_domains:
        warn(f"skipping {name}: already emailed {resolved_domain} this session")
        return False, this_cost

    info(f"address: {C.CYAN}{addr}{C.RESET} {C.GRAY}({source}){C.RESET}")
    if source_url:
        info(f"source: {C.GRAY}{source_url}{C.RESET}")
    if searches:
        info(f"web searches used: {searches}")

    with Spinner("composing email"):
        try:
            subject, body, ccost = compose(
                cfg["anthropic_key"], name, reason, agenda, cfg["address"]["formatted"], item=item
            )
            this_cost += ccost
        except Exception as e:
            fail(f"compose failed: {e}")
            return False, this_cost
    ok(f"composed {C.GRAY}(${ccost:.4f}){C.RESET}")

    if spent + this_cost >= budget:
        warn(f"budget would be exceeded, stopping before send")
        return False, this_cost

    msg = build_message(cfg, addr, subject, body)

    with Spinner(f"sending to {addr}"):
        try:
            smtp_send(cfg, msg)
        except RateLimitError as e:
            fail(f"rate limit hit: {e}")
            raise
        except Exception as e:
            fail(f"send failed: {e}")
            return False, this_cost
    ok(f"sent {C.GRAY}msgid {msg['Message-ID']}{C.RESET}")
    append_sent_log(msg, to=addr, subject=subject, body=body, company=name)

    contacted_addrs.add(addr_key)
    if resolved_domain:
        contacted_domains.add(resolved_domain)

    with Spinner("saving to Sent folder"):
        try:
            imap_append_to_sent(cfg, msg)
            saved = True
        except Exception as e:
            warn(f"could not save to Sent: {e}")
            saved = False
    if saved:
        ok("saved to Sent folder")

    with Spinner("verifying via IMAP"):
        try:
            verified = imap_verify(cfg, msg["Message-ID"], timeout_s=15.0)
        except Exception as e:
            warn(f"verify error: {e}")
            verified = False
    if verified:
        ok("verified in Sent folder")
    else:
        warn("not verified within 15s (still counted as sent)")

    return True, this_cost


def run_bot(cfg: dict) -> None:
    sys.stdout.write(f"{C.BOLD}Run configuration{C.RESET}\n")
    agenda = ask("Agenda (company focus, blank for mix)", default="")
    item = ask("What to ask for", default="stickers") or "stickers"
    try:
        max_emails = int(ask("How many emails", default="5") or "5")
    except ValueError:
        max_emails = 5
    max_emails = max(1, min(500, max_emails))
    default_budget = f"{cfg.get('budget_usd', DEFAULT_BUDGET_USD):.2f}"
    try:
        budget = float(ask("Budget cap (USD)", default=default_budget) or default_budget)
    except ValueError:
        budget = cfg.get("budget_usd", DEFAULT_BUDGET_USD)

    est = max_emails * PER_EMAIL_COST
    over = est > budget
    est_color = C.YELLOW if over else C.GREEN
    sys.stdout.write(
        f"\n  {C.GRAY}estimate:{C.RESET} {est_color}${est:.4f}{C.RESET} for {max_emails} emails "
        f"{C.GRAY}(~${PER_EMAIL_COST:.4f} per email){C.RESET}\n"
    )
    if over:
        sys.stdout.write(
            f"  {C.YELLOW}!{C.RESET} estimate exceeds budget, run may stop early\n"
        )
    sys.stdout.write(
        f"  {C.GRAY}sending from:{C.RESET} {cfg['from_name']} <{cfg['email_user']}>\n"
    )
    sys.stdout.write(f"  {C.GRAY}return address:{C.RESET} {cfg['address']['formatted']}\n")
    sys.stdout.write(f"  {C.GRAY}asking for:{C.RESET} {item}\n\n")

    go = ask("Start? (Y/n)", default="y").lower()
    if go not in ("y", "yes"):
        sys.stdout.write(f"{C.GRAY}cancelled{C.RESET}\n")
        return

    # Session-only dedup: we do NOT carry over cfg["contacted"] from past runs,
    # so the user can freely re-email orgs across sessions. Within this session
    # we block exact-name, normalized-name, domain, and address collisions.
    contacted: set[str] = set()
    contacted_norm: set[str] = set()
    contacted_domains: set[str] = set()
    contacted_addrs: set[str] = set()
    queue: list[dict] = []
    spent = 0.0
    sent_count = 0
    idx = 0

    def _already_seen(c: dict) -> bool:
        nm = c.get("name") or ""
        n_norm = norm_org_name(nm)
        d_norm = norm_domain(c.get("domain") or "")
        if not nm:
            return True
        if nm in contacted:
            return True
        if n_norm and n_norm in contacted_norm:
            return True
        if d_norm and d_norm in contacted_domains:
            return True
        return False

    try:
        while sent_count < max_emails and spent < budget:
            if not queue:
                batch = min(5, max_emails - sent_count + 2)
                print_header("discovering companies")
                with Spinner(f"asking Claude for {batch} candidates"):
                    try:
                        companies, dcost = discover(
                            cfg["anthropic_key"], agenda, batch, sorted(contacted)[:40]
                        )
                        spent += dcost
                    except Exception as e:
                        fail(f"discovery failed: {e}")
                        # Seed list is a generic tech-company list. It has no
                        # connection to the agenda, so we only allow it as a
                        # fallback when the user gave no agenda at all. If the
                        # user specified an agenda, falling back would silently
                        # email Mozilla/GitHub/etc. — the bug the user reported.
                        if agenda:
                            fail(
                                "refusing to fall back to the generic seed list because "
                                "you specified an agenda. Fix the Anthropic API error above and re-run."
                            )
                            break
                        fallback = [
                            {"name": s["name"], "domain": s["domain"], "reason": "seed fallback"}
                            for s in SEED_COMPANIES
                            if not _already_seen({"name": s["name"], "domain": s["domain"]})
                        ]
                        companies, dcost = fallback, 0.0
                ok(
                    f"{len(companies)} candidates {C.GRAY}(${dcost:.4f}){C.RESET}"
                )
                for c in companies:
                    if not _already_seen(c):
                        queue.append(c)
                if not queue:
                    warn("no more candidates, stopping")
                    break

            if spent >= budget:
                warn(f"budget reached (${spent:.4f} / ${budget:.2f})")
                break

            cand = queue.pop(0)
            # Track name + normalized name at pop so repeat suggestions from
            # the next discovery batch get filtered out. Do NOT pre-add the
            # candidate's own domain to contacted_domains here — run_one
            # checks the resolved email domain against that set, and since
            # the resolved domain is usually the same as the discovery domain
            # (e.g. alabama.edu), pre-adding would make every candidate flag
            # itself as "already emailed". Only mark a domain contacted after
            # an actual successful send (handled inside run_one).
            contacted.add(cand["name"])
            n_norm = norm_org_name(cand["name"])
            if n_norm:
                contacted_norm.add(n_norm)
            idx += 1
            try:
                did_send, this_cost = run_one(
                    cfg, idx, max_emails, cand, agenda, spent, budget,
                    contacted_domains, contacted_addrs, item=item,
                )
            except RateLimitError as e:
                spent += 0  # compose cost already included if it got that far
                sys.stdout.write("\n")
                warn(
                    f"{C.YELLOW}mail server rate limit reached{C.RESET}"
                )
                info(f"{e}")
                info(
                    "Namecheap Private Email caps around 150 emails per hour."
                )
                info(
                    "Wait ~1 hour before the next run, or increase the send delay."
                )
                break
            except Exception as e:
                # Any other failure inside run_one (network blip, Anthropic
                # error during web search, SMTP hiccup, etc.) should NOT kill
                # the whole run — skip this candidate and continue.
                fail(f"unexpected error on {cand.get('name','?')}: {e}")
                did_send, this_cost = False, 0.0
            spent += this_cost
            if did_send:
                sent_count += 1
                remaining = budget - spent
                bar_width = 24
                filled = int(bar_width * sent_count / max_emails)
                bar = "█" * filled + "░" * (bar_width - filled)
                sys.stdout.write(
                    f"\n  {C.ORANGE}{bar}{C.RESET}  "
                    f"{C.BOLD}{sent_count}/{max_emails}{C.RESET} sent  "
                    f"{C.GRAY}spent ${spent:.4f}  |  remaining ${remaining:.4f}{C.RESET}\n"
                )
                if sent_count < max_emails and spent < budget:
                    # Countdown so the user sees the delay isn't a freeze.
                    for left in range(SEND_DELAY_SECONDS, 0, -1):
                        sys.stdout.write(
                            f"\r  {C.GRAY}waiting {left:>2}s before next send "
                            f"(rate-limit safety){C.RESET}   "
                        )
                        sys.stdout.flush()
                        time.sleep(1)
                    sys.stdout.write("\r\033[K")

    except KeyboardInterrupt:
        sys.stdout.write(f"\n{C.YELLOW}interrupted{C.RESET}\n")
    except Exception as e:
        # Last-resort guard: log whatever escaped the per-candidate try/except
        # so the user sees what happened instead of the process disappearing.
        import traceback
        sys.stdout.write(f"\n{C.RED}run loop crashed: {e}{C.RESET}\n")
        traceback.print_exc()

    cfg["contacted"] = sorted(contacted)
    try:
        save_config(cfg)
    except Exception as e:
        warn(f"could not save contacted list: {e}")

    sys.stdout.write("\n")
    print_header("summary")
    ok(f"sent {sent_count} emails")
    info(f"spent ${spent:.4f} of ${budget:.2f} budget")
    info(f"contacted list saved ({len(contacted)} total companies)")
    sys.stdout.write("\n")


# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------


def _print_email_record(rec: dict, source: str) -> None:
    sys.stdout.write(f"\n{C.BOLD}email found{C.RESET} {C.GRAY}(from {source}){C.RESET}\n\n")
    for label, key in (
        ("Message-ID", "msgid"),
        ("Date", "sent_at" if "sent_at" in rec else "date"),
        ("From", "from"),
        ("To", "to"),
        ("Company", "company"),
        ("Subject", "subject"),
    ):
        val = rec.get(key, "")
        if val:
            sys.stdout.write(f"  {C.GRAY}{label}:{C.RESET} {val}\n")
    sys.stdout.write(f"\n{C.BOLD}Body{C.RESET}\n")
    sys.stdout.write("-" * 60 + "\n")
    sys.stdout.write((rec.get("body") or "").rstrip() + "\n")
    sys.stdout.write("-" * 60 + "\n\n")


def cmd_lookup(msgid_arg: str) -> int:
    enable_vt()
    target = normalize_msgid(msgid_arg)
    if not target:
        sys.stdout.write(f"{C.RED}error: empty msgid{C.RESET}\n")
        return 2
    sys.stdout.write(f"{C.GRAY}looking up {target}{C.RESET}\n")

    rec = lookup_in_local_log(target)
    if rec:
        _print_email_record(rec, "local log")
        return 0

    cfg = load_config()
    if cfg is None:
        sys.stdout.write(
            f"{C.YELLOW}!{C.RESET} not in local log, and no config is saved so IMAP is unavailable.\n"
            f"  Run the bot once to complete setup, then try again.\n"
        )
        return 1

    sys.stdout.write(f"{C.GRAY}not in local log, checking Sent folder via IMAP...{C.RESET}\n")
    try:
        rec = imap_fetch_by_msgid(cfg, target)
    except Exception as e:
        sys.stdout.write(f"{C.RED}IMAP error: {e}{C.RESET}\n")
        return 1
    if rec:
        _print_email_record(rec, "Sent folder via IMAP")
        return 0

    sys.stdout.write(
        f"\n{C.YELLOW}not found{C.RESET} in local log or Sent folder.\n"
        f"  (The message may have been deleted, or the server may not have indexed it yet.)\n\n"
    )
    return 1


def main() -> int:
    # CLI subcommand: python stickerbot.py lookup <msgid>
    if len(sys.argv) >= 3 and sys.argv[1] in ("lookup", "--lookup", "-l"):
        return cmd_lookup(" ".join(sys.argv[2:]))

    enable_vt()
    clear_screen()
    print_logo()

    cfg = load_config()
    if cfg is None:
        cfg = setup_wizard()
    else:
        choice = select_menu(
            "Config found. What would you like to do?",
            [
                f"Use saved config  {C.GRAY}({cfg.get('email_user', '?')}){C.RESET}",
                "Re-run setup",
                "Quit",
            ],
            default=0,
        )
        if choice == 1:
            cfg = setup_wizard()
        elif choice == 2:
            return 0

    exit_code = 0
    try:
        run_bot(cfg)
    except KeyboardInterrupt:
        sys.stdout.write(f"\n{C.YELLOW}aborted{C.RESET}\n")
        exit_code = 130
    except Exception:
        # Show the traceback so a double-clicked terminal window doesn't
        # vanish before the user can read what went wrong.
        import traceback
        sys.stdout.write(f"\n{C.RED}unexpected crash:{C.RESET}\n")
        traceback.print_exc()
        exit_code = 1

    # Always pause at the end so the window stays open regardless of how
    # we got here (success, crash, Ctrl-C). Many users launch by
    # double-clicking the .py, and Windows auto-closes the console on exit.
    try:
        input(f"\n{C.GRAY}press Enter to exit...{C.RESET}")
    except (EOFError, KeyboardInterrupt):
        pass
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        show_cursor()
