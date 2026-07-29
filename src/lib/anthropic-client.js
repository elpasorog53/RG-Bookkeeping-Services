// Thin wrapper around the Anthropic Messages API (raw fetch, no SDK
// dependency -- consistent with the rest of this project's minimal-deps
// approach). Mirrors the shape of the one-off call in routes/settings.js's
// ai-config/test endpoint.
const ANTHROPIC_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicError extends Error {}

export async function callAnthropic({ apiKey, system, prompt, maxTokens = 700 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new AnthropicError(errBody.error?.message || `Anthropic API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = (data.content || []).map((block) => block.text || '').join('');
  return {
    text,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    },
  };
}

export { ANTHROPIC_MODEL };
