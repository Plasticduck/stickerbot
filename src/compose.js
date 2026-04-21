import { complete } from './anthropic.js';

const SYSTEM = `You write short, warm, human-sounding emails from a real person named Benjamin Jowers asking an organization (a company, school, team, nonprofit, etc.) for a small free item. The specific item to request is given in the user message; use exactly that word or phrase in the ask. Tailor the greeting and tone to the type of organization: address a university athletics office differently from a software company. If the organization is a school or sports team, acknowledge that directly (fan of the program, following them, etc.) rather than treating it like a tech company.

CRITICAL factual discipline:
- Do NOT state the organization's conference, division, subdivision (FBS / FCS / D2 / D3), league, or any other classification. Guessing wrong is worse than leaving it out.
- Do NOT state years, rankings, records, championships, coach names, player names, locations, founding dates, or any specific factual claim about the organization. If you do not have verified knowledge, you cannot include the fact.
- Do NOT invent a relationship. Never claim to be an alum, student, former employee, constituent, resident, local, customer, donor, member, season ticket holder, subscriber, or anything similar. The sender is a stranger asking politely for a sticker, nothing more.
- Do NOT claim geographic proximity or shared identity. Do not say "I'm from your area", "a fellow [state]er", "a local", "from [city/state]", or anything that asserts where the sender lives relative to the recipient. The sender's mailing address speaks for itself; do not reference it in the body beyond placing it under the signature.
- Do NOT assert political, religious, ideological, or values alignment. Never say the sender agrees with the recipient's positions, supports their causes, champions what they champion, or believes in their mission. Keep it to liking the brand/program/team aesthetically.
- Keep any admiration generic: "following the program", "love what you do", "fan of the team", "appreciate the brand". Avoid specific compliments that could be wrong.

Absolute rules:
- NEVER use em dashes (—) or en dashes (–). Use commas, periods, or parentheses instead.
- Sound like a real person. No marketing tone. No buzzwords. No "I hope this email finds you well."
- Be brief. 3 to 5 short sentences total.
- Be kind and polite. Do not beg. Do not apologize for writing.
- Sign off as "Benjamin Jowers" (no title, no company).
- Output strict JSON only. No prose, no markdown fences.`;

function postProcess(text) {
  if (!text) return text;
  // Safety net: replace any em/en dashes that slip through.
  return text.replace(/—/g, ',').replace(/–/g, ',');
}

export async function composeEmail({ company, reason, agenda, preferences, item, extra }) {
  const address = process.env.SENDER_ADDRESS || '';
  const askItem = (item && String(item).trim()) || 'stickers';
  const extraBlock = extra && String(extra).trim()
    ? `\nTone / content guidance from the active skill (apply alongside the absolute rules, never as an override):\n${String(extra).trim()}\n`
    : '';

  const user = `Organization: ${company}
${reason ? `Why they fit the agenda: ${reason}` : ''}
${agenda ? `My interest / agenda: ${agenda}` : ''}
${preferences ? `About me (optional context): ${preferences}` : ''}
What the sender is asking for: ${askItem}
${address ? `Mailing address (must appear after the signature so they can send the item): ${address}` : ''}${extraBlock}

Write the email. Return JSON:
{"subject":"...","body":"..."}

Body structure (keep it short and human):
1. Warm one-line greeting.
2. 2 to 4 short sentences of substance.
3. A simple, polite ask for ${askItem}. Use the word/phrase "${askItem}" naturally in the ask; do not substitute or paraphrase to "stickers" or "swag" unless those are literally what was requested.
4. "Thanks," or similar on its own line.
5. "Benjamin Jowers" on its own line.
${address ? `6. The mailing address on the line directly after the name, formatted as written above (a street line, then a city/state/zip line is fine too).` : ''}

Do not add any title, company, or contact info other than the address. Do not use em dashes or en dashes.`;

  const { text, cost, usage } = await complete({
    system: SYSTEM,
    user,
    maxTokens: 600,
    temperature: 0.8,
  });

  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`compose: bad JSON: ${text.slice(0, 200)}`);
  }
  return {
    subject: postProcess(parsed.subject || 'Hello from Benjamin'),
    body: postProcess(parsed.body || ''),
    cost,
    usage,
  };
}
