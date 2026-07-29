// Lightweight, dependency-free "does this caption look like one I already
// wrote" check for topic-repetition warnings (spec's Phase 2 order, last
// step). Not real NLP -- just normalized word-set overlap -- but that's
// enough to catch an accidentally-rewritten near-duplicate post.

const MIN_WORD_LENGTH = 4; // cheap stopword filter: skips "the", "and", "for", ...

function normalizeWords(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= MIN_WORD_LENGTH);
  return new Set(words);
}

// Jaccard similarity (intersection / union) of the two captions' word
// sets. Returns 0 for empty/blank input on either side.
export function captionSimilarity(a, b) {
  const setA = normalizeWords(a);
  const setB = normalizeWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
