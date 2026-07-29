import { Router } from 'express';
import { z } from 'zod';
import { query, getPool, withTransaction } from '../lib/db.js';
import { validateBody } from '../lib/validate.js';
import { writeAudit } from '../lib/audit.js';
import { requireOwner } from '../lib/auth-middleware.js';
import { computeDueOccurrences, lastOccurrenceBefore, toDateString } from '../lib/recurrence.js';

const recurrenceRuleSchema = z.object({
  template_id: z.string().uuid(),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  day_of_week: z.number().int().min(0).max(6).optional().nullable(),
  day_of_month: z.number().int().min(1).max(31).optional().nullable(),
  month_of_year: z.number().int().min(1).max(12).optional().nullable(),
  lead_time_days: z.number().int().min(0).max(365).optional().default(7),
  start_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  requires_review: z.boolean().optional().default(true),
  requires_date_verification: z.boolean().optional().default(false),
  is_paused: z.boolean().optional().default(false),
});

const recurrenceRuleUpdateSchema = recurrenceRuleSchema.partial();

const router = Router();

// Applied to both create and the merged (existing + patch) state on update,
// so a rule can never be left inconsistent with its own frequency.
function missingFieldsForFrequency(candidate) {
  const missing = [];
  if (candidate.frequency === 'weekly' && candidate.day_of_week == null) missing.push('day_of_week');
  if (['monthly', 'quarterly', 'yearly'].includes(candidate.frequency) && candidate.day_of_month == null) {
    missing.push('day_of_month');
  }
  if (candidate.frequency === 'yearly' && candidate.month_of_year == null) missing.push('month_of_year');
  return missing;
}

async function templateExistsInOrg(templateId, orgId) {
  const { rows } = await query('SELECT id FROM templates WHERE id = $1 AND org_id = $2', [templateId, orgId]);
  return rows.length > 0;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.*, t.name AS template_name FROM recurrence_rules r
       JOIN templates t ON t.id = r.template_id
       WHERE r.org_id = $1 ORDER BY r.created_at`,
      [req.orgId]
    );
    res.json({ rules: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireOwner, validateBody(recurrenceRuleSchema), async (req, res, next) => {
  try {
    if (!(await templateExistsInOrg(req.body.template_id, req.orgId))) {
      return res.status(400).json({ error: 'Template not found' });
    }
    const missing = missingFieldsForFrequency(req.body);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing field(s) for ${req.body.frequency} frequency: ${missing.join(', ')}` });
    }
    if (req.body.end_on && req.body.end_on < req.body.start_on) {
      return res.status(400).json({ error: 'end_on cannot be before start_on' });
    }

    const {
      template_id,
      frequency,
      day_of_week,
      day_of_month,
      month_of_year,
      lead_time_days,
      start_on,
      end_on,
      requires_review,
      requires_date_verification,
      is_paused,
    } = req.body;

    const { rows } = await query(
      `INSERT INTO recurrence_rules (
         org_id, template_id, frequency, day_of_week, day_of_month, month_of_year,
         lead_time_days, start_on, end_on, requires_review, requires_date_verification, is_paused
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.orgId,
        template_id,
        frequency,
        day_of_week ?? null,
        day_of_month ?? null,
        month_of_year ?? null,
        lead_time_days,
        start_on,
        end_on ?? null,
        requires_review,
        requires_date_verification,
        is_paused,
      ]
    );
    let rule = rows[0];

    // A rule created with a start_on already in the past shouldn't spew a
    // backlog of backdated drafts the moment it's saved -- fast-forward past
    // everything that would already be due, so /run only picks up from here.
    const today = toDateString(new Date());
    const fastForwardTo = lastOccurrenceBefore(rule, today);
    if (fastForwardTo) {
      const { rows: updRows } = await query(
        'UPDATE recurrence_rules SET last_generated_for = $1 WHERE id = $2 RETURNING *',
        [fastForwardTo, rule.id]
      );
      rule = updRows[0];
    }

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'recurrence_rule.create',
      recordType: 'recurrence_rule',
      recordId: rule.id,
      before: null,
      after: rule,
      req,
    });
    res.status(201).json({ rule });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireOwner, validateBody(recurrenceRuleUpdateSchema), async (req, res, next) => {
  try {
    const { rows: existingRows } = await query('SELECT * FROM recurrence_rules WHERE id = $1 AND org_id = $2', [
      req.params.id,
      req.orgId,
    ]);
    if (existingRows.length === 0) return res.status(404).json({ error: 'Not found' });
    const before = existingRows[0];

    if (req.body.template_id && !(await templateExistsInOrg(req.body.template_id, req.orgId))) {
      return res.status(400).json({ error: 'Template not found' });
    }

    const merged = { ...before, ...req.body };
    const missing = missingFieldsForFrequency(merged);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing field(s) for ${merged.frequency} frequency: ${missing.join(', ')}` });
    }
    if (merged.end_on && merged.end_on < merged.start_on) {
      return res.status(400).json({ error: 'end_on cannot be before start_on' });
    }

    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.json({ rule: before });

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => fields[k]);
    const { rows } = await query(
      `UPDATE recurrence_rules SET ${setClauses.join(', ')} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}
       RETURNING *`,
      [...values, req.params.id, req.orgId]
    );
    const after = rows[0];

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'recurrence_rule.update',
      recordType: 'recurrence_rule',
      recordId: after.id,
      before,
      after,
      req,
    });
    res.json({ rule: after });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireOwner, async (req, res, next) => {
  try {
    const { rows } = await query('DELETE FROM recurrence_rules WHERE id = $1 AND org_id = $2 RETURNING *', [
      req.params.id,
      req.orgId,
    ]);
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });

    await writeAudit(getPool(), {
      orgId: req.orgId,
      actorId: req.user.id,
      action: 'recurrence_rule.delete',
      recordType: 'recurrence_rule',
      recordId: req.params.id,
      before: rows[0],
      after: null,
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// The zero-cost stand-in for a cron job (see README: free-tier Render has
// no scheduler): the frontend calls this once whenever the Dashboard loads.
// Idempotent thanks to last_generated_for, so calling it repeatedly, or from
// multiple sessions, never double-generates a post for the same occurrence.
router.post('/run', async (req, res, next) => {
  try {
    const { rows: rules } = await query(
      `SELECT r.*, t.name AS template_name, t.pillar_id AS template_pillar_id,
              t.body AS template_body, t.platforms AS template_platforms
       FROM recurrence_rules r JOIN templates t ON t.id = r.template_id
       WHERE r.org_id = $1 AND r.is_paused = false`,
      [req.orgId]
    );

    const today = toDateString(new Date());
    const generated = [];

    for (const rule of rules) {
      const occurrences = computeDueOccurrences(rule, today);
      for (const occurrenceDate of occurrences) {
        const note = rule.requires_date_verification
          ? 'Recurrence-generated: this references a date/deadline that can shift year to year (e.g., filing deadlines moving around weekends and holidays) -- verify the specific date before approving.'
          : `Recurrence-generated from "${rule.template_name}".`;

        const post = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO posts (
               org_id, title, status, pillar_id, platforms, caption_main,
               needs_review, notes, planned_date, created_by, updated_by
             ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
            [
              req.orgId,
              `${rule.template_name} (${occurrenceDate})`,
              rule.template_pillar_id,
              rule.template_platforms,
              rule.template_body,
              rule.requires_review || rule.requires_date_verification,
              note,
              occurrenceDate,
              req.user.id,
            ]
          );
          const created = rows[0];
          await client.query(
            'INSERT INTO status_history (post_id, from_status, to_status, actor_id, note) VALUES ($1, NULL, $2, $3, $4)',
            [created.id, created.status, req.user.id, `auto: recurrence rule ${rule.id}`]
          );
          await client.query('UPDATE recurrence_rules SET last_generated_for = $1 WHERE id = $2', [
            occurrenceDate,
            rule.id,
          ]);
          await writeAudit(client, {
            orgId: req.orgId,
            actorId: req.user.id,
            action: 'post.recurrence_generate',
            recordType: 'post',
            recordId: created.id,
            before: null,
            after: created,
            req,
          });
          return created;
        });

        generated.push({ ruleId: rule.id, postId: post.id, plannedDate: occurrenceDate });
      }
    }

    res.json({ generated });
  } catch (err) {
    next(err);
  }
});

export default router;
