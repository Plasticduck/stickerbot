import { complete, DISCOVERY_MODEL } from './anthropic.js';

const SYSTEM = `You generate lists of real organizations the user wants to contact for free stickers or swag. The user's agenda defines the EXACT kind of organization to target, INCLUDING any narrowing qualifier in it (conference, division, geography, size, era, genre, etc.). Every entry must BE an instance of the agenda category and must individually satisfy every qualifier. Sponsors, suppliers, partners, parent companies, and other tangentially related organizations never qualify. If the agenda is empty or general, pick well-known companies with sticker programs.

Output format: respond with ONLY a JSON object. No preamble, no thinking aloud, no explanation, no markdown fences. Your entire response must start with \`{\` and end with \`}\`. Do your reasoning internally and emit only the final JSON.`;

function extractJsonObject(text) {
  if (!text) return null;
  let stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const results = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push(stripped.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  for (let i = results.length - 1; i >= 0; i--) {
    try { return JSON.parse(results[i]); } catch { /* try next */ }
  }
  return null;
}

function buildUserPrompt({ agenda, preferences, count, exclude, extra }) {
  const excludeBlock = exclude?.length
    ? `\nDo NOT include any of these already-contacted organizations: ${exclude.join(', ')}.`
    : '';
  const extraBlock = extra && String(extra).trim()
    ? `\nAdditional discovery guidance from the active skill (apply on top of the rules above, do not override them):\n${String(extra).trim()}\n`
    : '';
  const agendaBlock = agenda
    ? `AGENDA (read this literally, including every qualifier): ${agenda}

Two hard rules:
1. KIND match: every entry must BE an instance of the agenda category, not a sponsor, supplier, partner, parent, or related industry.
2. QUALIFIER match: any narrowing qualifier in the agenda (conference, division, state, size, era, genre, etc.) must be satisfied by EACH entry individually, as the category currently stands. If you are not certain an entry satisfies the qualifier as of today, DO NOT include it, replace it.

Worked examples:
  agenda "Group of Five FBS football programs" -> Group of Five = American, Conference USA, MAC, Mountain West, Sun Belt. Valid: Memphis, Tulane, Boise State, Appalachian State, Coastal Carolina. INVALID: Texas (Big 12, Power conference), Houston (Big 12 since 2023, Power conference), Alabama (SEC), Ohio State (Big Ten), Presbyterian (FCS Pioneer League, not FBS at all), any FCS program.
  agenda "Power Four conference football programs" -> SEC, Big Ten, Big 12, ACC only. Texas, Houston, Alabama, Ohio State all valid. Memphis, Tulane, Boise State INVALID.
  agenda "FBS D1 football teams" (FBS only, no narrowing) -> any FBS program qualifies. INVALID: any FCS school (Presbyterian, Dartmouth, Yale, Montana, NDSU are FCS — do NOT include them).
  agenda "indie bookstores" -> Powell's Books, The Strand, Parnassus Books. INVALID: Penguin Random House, Amazon, chain stores.
  agenda "craft breweries in Texas" -> Saint Arnold, Jester King, Austin Beerworks. INVALID: Anheuser-Busch, non-Texas breweries, distributors.

College football subdivision reminder: FBS and FCS are DIFFERENT subdivisions of Division I. Agendas that mention "FBS", "Group of Five", "Group of Six", "Power Four/Five", or any FBS conference name (AAC, CUSA, MAC, Mountain West, Sun Belt, SEC, Big Ten, Big 12, ACC) exclude all FCS programs. If you are not sure whether a specific program is FBS or FCS this season, DO NOT include it.

Before emitting JSON, verify both rules AND the subdivision/conference as of the current season for every entry. If unsure about any entry, replace it. Fewer well-vetted entries beats one wrong entry.`
    : `No specific agenda. Pick a varied mix of tech, hardware, dev tools, and open-source friendly companies known for sticker programs.`;
  const prefBlock = preferences
    ? `\nGeneral user preferences: ${preferences}`
    : '';
  const tailReminder = agenda
    ? `\n\nFinal check: for the agenda \`${agenda}\`, each entry must satisfy every qualifier in that phrase. Conference/division/geographic/size qualifiers are not decorative, they exclude everything outside the set.`
    : '';

  return `${agendaBlock}${prefBlock}${excludeBlock}${extraBlock}

Return exactly ${count} organizations as JSON in this shape:
{"companies":[{"name":"OrganizationName","domain":"example.com","reason":"short phrase explaining how this entry satisfies the agenda"}]}

Rules:
- Real organizations only, matching the agenda category literally and satisfying every qualifier.
- "domain" is the organization's own primary website (e.g. "alabama.edu" for University of Alabama, not a sponsor's site).
- "reason" under 12 words and must explain how this entry IS the agenda category.
- No duplicates.
- JSON only.${tailReminder}`;
}

export async function discoverCompanies({ agenda, preferences, count = 5, exclude = [], extra = '' }) {
  const { text, cost, usage } = await complete({
    system: SYSTEM,
    user: buildUserPrompt({ agenda, preferences, count, exclude, extra }),
    maxTokens: 1200,
    temperature: 0.2,
    model: DISCOVERY_MODEL,
  });

  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error(`discover: bad JSON from model: ${text.slice(0, 200)}`);
  }
  const companies = Array.isArray(parsed.companies) ? parsed.companies : [];
  return { companies, cost, usage };
}
