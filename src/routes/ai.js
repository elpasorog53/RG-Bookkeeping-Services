import { Router } from 'express';
import { z } from 'zod';
import { query, getPool } from '../lib/db.js';
import { validateBody } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { rateLimit, userKey } from '../lib/rate-limit.js';
import { getConfig } from '../lib/config.js';
import { callAnthropic, AnthropicError, ANTHROPIC_MODEL } from '../lib/anthropic-client.js';
import {
  buildBrandVoiceBlock,
  SAFETY_RULES,
  OUTPUT_CONTRACT,
  outputArrayContract,
  platformGuidanceLine,
  parseAiJson,
  parseAiJsonArray,
} from '../lib/ai-prompt.js';

const router = Router();

// Spec section 18: 30 requests/hour/user on AI endpoints.
router.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyFn: userKey }));

const draftSchema = z.object({
  topic: z.string().min(1).max(2000),
  notes: z.string().max(2000).optional().nullable(),
  pillar_id: z.string().uuid().optional().nullable(),
  platforms: z.array(z.string()).min(1),
  post_id: z.string().uuid().optional().nullable(),
});

const rewriteSchema = z.object({
  caption: z.string().min(1).max(10000),
  instruction: z.string().min(1).max(1000),
  platforms: z.array(z.string()).optional().default([]),
  post_id: z.string().uuid().optional().nullable(),
});

const variantsSchema = z.object({
  caption: z.string().min(1).max(10000),
  count: z.number().int().min(1).max(5).optional().default(3),
  platforms: z.array(z.string()).optional().default([]),
  post_id: z.string().uuid().optional().nullable(),
});

async function requireAiConfigured(req, res, next) {
  try {
    const apiKey = await getConfig('ANTHROPIC_API_KEY');
    if (!apiKey) return res.status(400).json({ error: 'AI is not configured yet. Add an API key in Settings → AI.' });
    req.aiApiKey = apiKey;
    next();
  } catch (err) {
    next(err);
  }
}

// Returns the invalid keys (empty array if all valid) rather than throwing --
// the generic error handler in index.js discards a thrown error's message,
// so each route checks this list itself and writes its own 400 response.
async function invalidPlatformKeys(platforms) {
  if (!platforms || platforms.length === 0) return [];
  const { rows } = await query('SELECT key FROM platforms WHERE is_enabled = true');
  const valid = new Set(rows.map((r) => r.key));
  return platforms.filter((p) => !valid.has(p));
}

async function loadContext(orgId, { pillarId, platforms }) {
  const [brandRows, platformRows, pillarRows] = await Promise.all([
    query('SELECT * FROM brand_settings WHERE org_id = $1', [orgId]),
    platforms && platforms.length > 0
      ? query('SELECT key, label, char_soft_limit, char_hard_limit FROM platforms WHERE key = ANY($1)', [platforms])
      : Promise.resolve({ rows: [] }),
    pillarId
      ? query('SELECT name, description FROM content_pillars WHERE id = $1 AND org_id = $2', [pillarId, orgId])
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    brandSettings: brandRows.rows[0] || null,
    platformRows: platformRows.rows,
    pillar: pillarRows.rows[0] || null,
  };
}

async function logGeneration({ orgId, actorId, postId, action, usage }) {
  const { rows } = await query(
    `INSERT INTO ai_generations (org_id, post_id, actor_id, action, model, input_tokens, output_tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [orgId, postId || null, actorId, action, ANTHROPIC_MODEL, usage.inputTokens, usage.outputTokens]
  );
  return rows[0].id;
}

router.post('/draft', requireAiConfigured, validateBody(draftSchema), async (req, res, next) => {
  try {
    const { topic, notes, pillar_id: pillarId, platforms, post_id: postId } = req.body;
    const invalidPlatforms = await invalidPlatformKeys(platforms);
    if (invalidPlatforms.length > 0) {
      return res.status(400).json({ error: `Unknown or disabled platform(s): ${invalidPlatforms.join(', ')}` });
    }

    const { brandSettings, platformRows, pillar } = await loadContext(req.orgId, { pillarId, platforms });
    const platformLabels = platformRows.map((p) => p.label).join(', ') || platforms.join(', ');

    const system = [
      'You are a social media copywriter for a small bookkeeping/accounting business.',
      '',
      buildBrandVoiceBlock(brandSettings),
      '',
      SAFETY_RULES,
      '',
      OUTPUT_CONTRACT,
    ].join('\n');

    const prompt = [
      'Task: Write a new social media post.',
      `Topic/brief: ${topic}`,
      notes ? `Additional notes: ${notes}` : null,
      pillar ? `Content pillar: ${pillar.name}${pillar.description ? ` — ${pillar.description}` : ''}` : null,
      `Platforms: ${platformLabels}`,
      platformGuidanceLine(platformRows),
      'Write one primary caption suited to all listed platforms (aim for the tightest soft character limit among them), a short hashtags string (3-6 relevant hashtags, space separated), and a short call-to-action.',
    ]
      .filter(Boolean)
      .join('\n');

    let result;
    try {
      result = await callAnthropic({ apiKey: req.aiApiKey, system, prompt, maxTokens: 700 });
    } catch (err) {
      if (err instanceof AnthropicError) return res.status(502).json({ error: err.message });
      throw err;
    }

    let draft;
    try {
      draft = parseAiJson(result.text);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const generationId = await logGeneration({
      orgId: req.orgId,
      actorId: req.user.id,
      postId,
      action: 'draft',
      usage: result.usage,
    });

    res.json({ generationId, draft, usage: result.usage });
  } catch (err) {
    next(err);
  }
});

router.post('/rewrite', requireAiConfigured, validateBody(rewriteSchema), async (req, res, next) => {
  try {
    const { caption, instruction, platforms, post_id: postId } = req.body;
    const invalidPlatforms = await invalidPlatformKeys(platforms);
    if (invalidPlatforms.length > 0) {
      return res.status(400).json({ error: `Unknown or disabled platform(s): ${invalidPlatforms.join(', ')}` });
    }

    const { brandSettings, platformRows } = await loadContext(req.orgId, { platforms });
    const platformLabels = platformRows.map((p) => p.label).join(', ') || 'not specified';

    const system = [
      'You are a social media copywriter for a small bookkeeping/accounting business.',
      '',
      buildBrandVoiceBlock(brandSettings),
      '',
      SAFETY_RULES,
      '',
      OUTPUT_CONTRACT,
    ].join('\n');

    const prompt = [
      'Task: Rewrite the following existing caption per the instruction given, keeping it in the business’s voice.',
      'Existing caption:',
      '"""',
      caption,
      '"""',
      `Instruction: ${instruction}`,
      `Platforms: ${platformLabels}`,
      platformGuidanceLine(platformRows),
      'Return the rewritten caption plus hashtags and CTA (carry over reasonable hashtags/CTA if the instruction does not ask to change them).',
    ]
      .filter(Boolean)
      .join('\n');

    let result;
    try {
      result = await callAnthropic({ apiKey: req.aiApiKey, system, prompt, maxTokens: 700 });
    } catch (err) {
      if (err instanceof AnthropicError) return res.status(502).json({ error: err.message });
      throw err;
    }

    let rewritten;
    try {
      rewritten = parseAiJson(result.text);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const generationId = await logGeneration({
      orgId: req.orgId,
      actorId: req.user.id,
      postId,
      action: 'rewrite',
      usage: result.usage,
    });

    res.json({ generationId, draft: rewritten, usage: result.usage });
  } catch (err) {
    next(err);
  }
});

router.post('/variants', requireAiConfigured, validateBody(variantsSchema), async (req, res, next) => {
  try {
    const { caption, count, platforms, post_id: postId } = req.body;
    const invalidPlatforms = await invalidPlatformKeys(platforms);
    if (invalidPlatforms.length > 0) {
      return res.status(400).json({ error: `Unknown or disabled platform(s): ${invalidPlatforms.join(', ')}` });
    }

    const { brandSettings, platformRows } = await loadContext(req.orgId, { platforms });
    const platformLabels = platformRows.map((p) => p.label).join(', ') || 'not specified';

    const system = [
      'You are a social media copywriter for a small bookkeeping/accounting business.',
      '',
      buildBrandVoiceBlock(brandSettings),
      '',
      SAFETY_RULES,
      '',
      outputArrayContract(count),
    ].join('\n');

    const prompt = [
      `Task: Generate ${count} distinct alternative versions of the following caption, each in the business's voice but with a different angle/opening/hook. Keep the same core message.`,
      'Existing caption:',
      '"""',
      caption,
      '"""',
      `Platforms: ${platformLabels}`,
      platformGuidanceLine(platformRows),
    ]
      .filter(Boolean)
      .join('\n');

    let result;
    try {
      result = await callAnthropic({ apiKey: req.aiApiKey, system, prompt, maxTokens: 400 * count });
    } catch (err) {
      if (err instanceof AnthropicError) return res.status(502).json({ error: err.message });
      throw err;
    }

    let variants;
    try {
      variants = parseAiJsonArray(result.text, count);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const generationId = await logGeneration({
      orgId: req.orgId,
      actorId: req.user.id,
      postId,
      action: 'variants',
      usage: result.usage,
    });

    res.json({ generationId, variants, usage: result.usage });
  } catch (err) {
    next(err);
  }
});

router.post('/generations/:id/accept', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Not found' });

    const { rows } = await query(
      'UPDATE ai_generations SET accepted = true WHERE id = $1 AND org_id = $2 RETURNING id',
      [Number(req.params.id), req.orgId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'ai.accept',
      recordType: 'ai_generation',
      recordId: rows[0].id,
      before: null,
      after: { accepted: true },
      req,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
