// Brand-voice system prompt assembly and response parsing for the AI
// drafting suite (routes/ai.js). Kept separate from the route file so the
// prompt text and JSON-contract parsing can be unit tested without hitting
// a database or the network.

export function buildBrandVoiceBlock(brandSettings) {
  const b = brandSettings || {};
  const lines = [];
  if (b.business_name) lines.push(`Business name: ${b.business_name}`);
  if (b.business_description) lines.push(`About the business: ${b.business_description}`);
  if (b.services) lines.push(`Services offered: ${b.services}`);
  if (b.target_audience) lines.push(`Target audience: ${b.target_audience}`);
  if (b.geographic_area) lines.push(`Service area: ${b.geographic_area}`);
  if (b.tone) lines.push(`Preferred tone/voice: ${b.tone}`);
  if (b.preferred_terms) lines.push(`Preferred terms/phrases to use: ${b.preferred_terms}`);
  if (b.avoid_terms) lines.push(`Terms/phrases to avoid: ${b.avoid_terms}`);
  if (Array.isArray(b.default_ctas) && b.default_ctas.length > 0) {
    lines.push(`Go-to calls to action: ${b.default_ctas.join('; ')}`);
  }
  if (b.website_url) lines.push(`Website: ${b.website_url}`);
  if (b.contact_info) lines.push(`Contact info: ${b.contact_info}`);
  if (b.post_length_pref) lines.push(`Preferred post length: ${b.post_length_pref}`);
  if (Array.isArray(b.example_posts) && b.example_posts.length > 0) {
    lines.push("Example posts written in this business's voice (match this style, do not copy verbatim):");
    b.example_posts.forEach((ex, i) => lines.push(`  ${i + 1}. ${ex}`));
  }
  return lines.length > 0
    ? lines.join('\n')
    : 'No brand voice details are configured yet -- write in a friendly, professional, small-business tone.';
}

// Bookkeeping/accounting content carries real compliance risk if AI-written
// copy states specific figures or gives individualized advice -- this is
// the "advice-flag safety check" called for in the spec's Phase 2 order.
export const SAFETY_RULES = `Safety rules for this bookkeeping/accounting business (must always follow):
- Never state specific tax figures, deduction amounts, dollar-value savings claims, or filing deadlines as fact -- these vary by individual situation and change yearly.
- Never give definitive legal, tax, or financial advice ("you should", "you qualify for", "this guarantees") -- keep content educational and general, and invite the reader to consult the business directly.
- If the requested topic pushes toward specific numeric tax/financial claims or individualized advice despite the above, still write reasonable general-education content, but set "needsReview" to true and explain why in "reviewReason".
- If the content makes any claim that could be read as tax/financial guidance (even general), set "disclaimerRequired" to true.`;

export const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object (no markdown fences, no commentary before or after), matching exactly this shape:
{"caption": string, "hashtags": string, "cta": string or null, "needsReview": boolean, "reviewReason": string or null, "disclaimerRequired": boolean}`;

export function outputArrayContract(count) {
  return `Respond with ONLY a JSON array of exactly ${count} objects (no markdown fences, no commentary before or after), each matching exactly this shape:
{"caption": string, "hashtags": string, "cta": string or null, "needsReview": boolean, "reviewReason": string or null, "disclaimerRequired": boolean}`;
}

export function platformGuidanceLine(platformRows) {
  if (!platformRows || platformRows.length === 0) return null;
  const parts = platformRows.map(
    (p) => `${p.label} (soft ~${p.char_soft_limit ?? 'n/a'}, hard ${p.char_hard_limit ?? 'n/a'})`
  );
  return `Character guidance per platform: ${parts.join('; ')}.`;
}

function stripFence(text) {
  const cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : cleaned;
}

function normalizeItem(item) {
  return {
    caption: typeof item?.caption === 'string' ? item.caption : '',
    hashtags: typeof item?.hashtags === 'string' ? item.hashtags : '',
    cta: typeof item?.cta === 'string' ? item.cta : null,
    needsReview: Boolean(item?.needsReview),
    reviewReason: typeof item?.reviewReason === 'string' ? item.reviewReason : null,
    disclaimerRequired: Boolean(item?.disclaimerRequired),
  };
}

export function parseAiJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    throw new Error('The AI response could not be parsed. Try again.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The AI response could not be parsed. Try again.');
  }
  return normalizeItem(parsed);
}

export function parseAiJsonArray(text, expectedCount) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    throw new Error('The AI response could not be parsed. Try again.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('The AI response could not be parsed. Try again.');
  }
  return parsed.slice(0, expectedCount).map(normalizeItem);
}
