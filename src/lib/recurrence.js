// Pure date math for recurrence_rules (spec section 17/32's Phase 2
// "recurrence rules" step). Everything works in UTC-midnight Date objects
// since these are calendar dates (planned_date), not clock times -- no
// timezone conversion needed, unlike ics.js's zonedWallTimeToUtc.

export function daysInMonth(year, month1based) {
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

// Clamps day-of-month to the last real day of that month (e.g. day_of_month
// 31 lands on Feb 28/29, Apr 30, ...) so a single rule value works year-round.
export function makeDate(year, month1based, day) {
  const clampedDay = Math.min(day, daysInMonth(year, month1based));
  return new Date(Date.UTC(year, month1based - 1, clampedDay));
}

export function parseDateString(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function stepMonths(date, dayOfMonth, monthStep) {
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1 + monthStep;
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return makeDate(year, month, dayOfMonth);
}

// The first occurrence on or after start_on -- the anchor every later
// occurrence is stepped from.
export function firstOccurrenceOnOrAfter(rule) {
  const start = parseDateString(rule.start_on);

  if (rule.frequency === 'weekly') {
    let d = start;
    while (d.getUTCDay() !== rule.day_of_week) d = addDays(d, 1);
    return d;
  }

  const monthStep = rule.frequency === 'quarterly' ? 3 : rule.frequency === 'yearly' ? 12 : 1;
  const monthOfYear = rule.frequency === 'yearly' ? rule.month_of_year : start.getUTCMonth() + 1;
  let candidate = makeDate(start.getUTCFullYear(), monthOfYear, rule.day_of_month);
  if (candidate < start) {
    candidate = stepMonths(candidate, rule.day_of_month, monthStep);
  }
  return candidate;
}

// The next occurrence strictly after `current` (which must itself already
// be a valid occurrence of this rule).
export function nextOccurrence(rule, current) {
  if (rule.frequency === 'weekly') return addDays(current, 7);
  const monthStep = rule.frequency === 'quarterly' ? 3 : rule.frequency === 'yearly' ? 12 : 1;
  return stepMonths(current, rule.day_of_month, monthStep);
}

const MAX_ITERATIONS = 10000;

// Occurrences strictly after rule.last_generated_for (or the first one on/
// after start_on if the rule has never generated anything), through
// today + lead_time_days, capped by end_on if set.
export function computeDueOccurrences(rule, todayStr) {
  if (rule.is_paused) return [];

  const windowEnd = addDays(parseDateString(todayStr), rule.lead_time_days);
  const hardEnd = rule.end_on ? parseDateString(rule.end_on) : null;

  let cursor = rule.last_generated_for
    ? nextOccurrence(rule, parseDateString(rule.last_generated_for))
    : firstOccurrenceOnOrAfter(rule);

  const results = [];
  let iterations = 0;
  while (cursor <= windowEnd && (!hardEnd || cursor <= hardEnd) && iterations < MAX_ITERATIONS) {
    results.push(toDateString(cursor));
    cursor = nextOccurrence(rule, cursor);
    iterations += 1;
  }
  return results;
}

// Used only when a rule is first created with a start_on already in the
// past: returns the last occurrence strictly before `referenceDateStr` (or
// null if the rule's first occurrence is today or later), so the caller can
// fast-forward last_generated_for and avoid generating a backlog of
// backdated drafts the moment the rule is saved.
export function lastOccurrenceBefore(rule, referenceDateStr) {
  const reference = parseDateString(referenceDateStr);
  let cursor = firstOccurrenceOnOrAfter(rule);
  if (cursor >= reference) return null;

  let last = null;
  let iterations = 0;
  while (cursor < reference && iterations < MAX_ITERATIONS) {
    last = cursor;
    cursor = nextOccurrence(rule, cursor);
    iterations += 1;
  }
  return last ? toDateString(last) : null;
}
