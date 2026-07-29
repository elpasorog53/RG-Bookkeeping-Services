import test from 'node:test';
import assert from 'node:assert/strict';
import {
  daysInMonth,
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  computeDueOccurrences,
  lastOccurrenceBefore,
  toDateString,
} from '../../src/lib/recurrence.js';

test('daysInMonth handles leap vs non-leap February', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});

test('weekly: first occurrence lands on the target weekday on/after start_on, then steps by 7 days', () => {
  const rule = { frequency: 'weekly', day_of_week: 1, start_on: '2026-01-01' }; // Thu -> next Monday
  const first = firstOccurrenceOnOrAfter(rule);
  assert.equal(toDateString(first), '2026-01-05');

  const second = nextOccurrence(rule, first);
  assert.equal(toDateString(second), '2026-01-12');
});

test('weekly: start_on already on the target weekday is its own first occurrence', () => {
  const rule = { frequency: 'weekly', day_of_week: 1, start_on: '2026-01-05' }; // already Monday
  assert.equal(toDateString(firstOccurrenceOnOrAfter(rule)), '2026-01-05');
});

test('monthly: day_of_month before start_on\'s day rolls to next month', () => {
  const rule = { frequency: 'monthly', day_of_month: 31, start_on: '2026-01-15' };
  const first = firstOccurrenceOnOrAfter(rule);
  assert.equal(toDateString(first), '2026-01-31', 'the 31st is still on/after the 15th');

  const second = nextOccurrence(rule, first);
  assert.equal(toDateString(second), '2026-02-28', 'clamped to the last day of February');
});

test('monthly: day_of_month before start_on\'s day-of-month rolls to the next month', () => {
  const rule = { frequency: 'monthly', day_of_month: 10, start_on: '2026-02-15' };
  assert.equal(toDateString(firstOccurrenceOnOrAfter(rule)), '2026-03-10');
});

test('quarterly: steps by 3 months, anchored to start_on\'s month', () => {
  const rule = { frequency: 'quarterly', day_of_month: 15, start_on: '2026-01-01' };
  const first = firstOccurrenceOnOrAfter(rule);
  assert.equal(toDateString(first), '2026-01-15');

  const second = nextOccurrence(rule, first);
  assert.equal(toDateString(second), '2026-04-15');
  const third = nextOccurrence(rule, second);
  assert.equal(toDateString(third), '2026-07-15');
  const fourth = nextOccurrence(rule, third);
  assert.equal(toDateString(fourth), '2026-10-15');
  const fifth = nextOccurrence(rule, fourth);
  assert.equal(toDateString(fifth), '2027-01-15', 'wraps into the next year');
});

test('yearly: clamps Feb 29 to Feb 28 in non-leap years and lands on the 29th in leap years', () => {
  const rule = { frequency: 'yearly', month_of_year: 2, day_of_month: 29, start_on: '2026-01-01' };
  const y2026 = firstOccurrenceOnOrAfter(rule);
  assert.equal(toDateString(y2026), '2026-02-28');

  const y2027 = nextOccurrence(rule, y2026);
  assert.equal(toDateString(y2027), '2027-02-28');

  const y2028 = nextOccurrence(rule, y2027);
  assert.equal(toDateString(y2028), '2028-02-29', 'leap year gets the real Feb 29');
});

test('computeDueOccurrences returns nothing due beyond the lead-time window', () => {
  const rule = {
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-01-01',
    lead_time_days: 7,
    last_generated_for: null,
    end_on: null,
    is_paused: false,
  };
  const due = computeDueOccurrences(rule, '2026-01-01');
  assert.deepEqual(due, ['2026-01-05'], 'only the first Monday falls within a 7-day lead window');
});

test('computeDueOccurrences skips occurrences already generated via last_generated_for', () => {
  const rule = {
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-01-01',
    lead_time_days: 7,
    last_generated_for: '2026-01-05',
    end_on: null,
    is_paused: false,
  };
  const due = computeDueOccurrences(rule, '2026-01-01');
  assert.deepEqual(due, [], 'already generated for the only occurrence in this window');
});

test('computeDueOccurrences respects end_on as a hard cutoff', () => {
  const rule = {
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2026-01-01',
    lead_time_days: 30,
    last_generated_for: null,
    end_on: '2026-01-10',
    is_paused: false,
  };
  const due = computeDueOccurrences(rule, '2026-01-01');
  assert.deepEqual(due, ['2026-01-05'], 'Jan 12 would otherwise be in the 30-day window but is past end_on');
});

test('computeDueOccurrences returns nothing for a paused rule', () => {
  const rule = {
    frequency: 'weekly',
    day_of_week: 1,
    start_on: '2020-01-01',
    lead_time_days: 3650,
    last_generated_for: null,
    end_on: null,
    is_paused: true,
  };
  assert.deepEqual(computeDueOccurrences(rule, '2026-01-01'), []);
});

test('lastOccurrenceBefore finds the most recent occurrence strictly before a reference date, for fast-forwarding a rule created with a past start_on', () => {
  const rule = { frequency: 'weekly', day_of_week: 1, start_on: '2020-01-06' };
  assert.equal(lastOccurrenceBefore(rule, '2026-01-01'), '2025-12-29');
});

test('lastOccurrenceBefore returns null when the rule has not started yet', () => {
  const rule = { frequency: 'weekly', day_of_week: 1, start_on: '2026-06-01' };
  assert.equal(lastOccurrenceBefore(rule, '2026-01-01'), null);
});
