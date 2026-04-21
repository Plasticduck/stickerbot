import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5-20251001';

// Haiku 4.5 pricing (USD per million tokens)
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;

// Discovery uses a smarter model so agenda qualifiers (Group of Five,
// conference, geography, etc.) are interpreted correctly. Sonnet 4.6: $3 / $15.
export const DISCOVERY_MODEL = 'claude-sonnet-4-6';
const DISCOVERY_PRICE_IN = 3.0;
const DISCOVERY_PRICE_OUT = 15.0;

// Rough per-email cost estimate.
// Sonnet discovery batches ~5 companies per call (~$0.002/company share).
// Web-search lookup: 1-3 searches at $0.01 each + tokens ≈ $0.015 avg per company.
// Compose: one Haiku call per email ≈ $0.0015.
// Total: ~$0.019 per successful email. Round to $0.025 for headroom.
export const PER_EMAIL_COST_USD = 0.025;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function estimateCost(usage, model = MODEL) {
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  const pin = model === DISCOVERY_MODEL ? DISCOVERY_PRICE_IN : PRICE_IN;
  const pout = model === DISCOVERY_MODEL ? DISCOVERY_PRICE_OUT : PRICE_OUT;
  return (inTok * pin + outTok * pout) / 1_000_000;
}

export async function complete({ system, user, maxTokens = 512, temperature = 0.7, model = MODEL }) {
  const resp = await client.messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: resp.usage, cost: estimateCost(resp.usage, model) };
}

// Web search costs $10 per 1,000 searches = $0.01 per search.
const WEB_SEARCH_COST_PER_USE = 0.01;

// Call Claude with the native web_search tool enabled. The model will issue
// real searches against the live web and read result snippets before answering.
// Returns the concatenated final text + estimated cost (tokens + searches).
export async function completeWithWebSearch({
  system,
  user,
  maxTokens = 1024,
  temperature = 0.2,
  maxSearches = 3,
}) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxSearches,
      },
    ],
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  // Count how many times the search tool was actually invoked.
  const searchUses = resp.content.filter(
    (b) => b.type === 'server_tool_use' && b.name === 'web_search'
  ).length;
  const tokenCost = estimateCost(resp.usage);
  const searchCost = searchUses * WEB_SEARCH_COST_PER_USE;
  return {
    text,
    usage: resp.usage,
    searchUses,
    cost: tokenCost + searchCost,
  };
}

export { MODEL };
