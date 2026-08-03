import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarFeed, zonedWallTimeToUtc } from '../../src/lib/ics.js';

test('zonedWallTimeToUtc converts Eastern wall-clock time to the correct UTC instant (EDT, UTC-4)', () => {
  // 2026-08-03 09:00 in America/New_York is summer (EDT, UTC-4) -> 13:00 UTC.
  const utc = zonedWallTimeToUtc('2026-08-03', '09:00:00', 'America/New_York');
  assert.equal(utc.toISOString(), '2026-08-03T13:00:00.000Z');
});

test('zonedWallTimeToUtc handles the winter (EST, UTC-5) offset correctly', () => {
  // 2026-01-15 09:00 in America/New_York is winter (EST, UTC-5) -> 14:00 UTC.
  const utc = zonedWallTimeToUtc('2026-01-15', '09:00:00', 'America/New_York');
  assert.equal(utc.toISOString(), '2026-01-15T14:00:00.000Z');
});

test('zonedWallTimeToUtc handles a non-Eastern timezone (America/Los_Angeles)', () => {
  const utc = zonedWallTimeToUtc('2026-07-04', '10:00:00', 'America/Los_Angeles');
  // Summer in LA is PDT (UTC-7) -> 17:00 UTC.
  assert.equal(utc.toISOString(), '2026-07-04T17:00:00.000Z');
});

test('buildCalendarFeed produces a valid VCALENDAR wrapper with the org name and timezone', () => {
  const ics = buildCalendarFeed({ orgName: 'RG Bookkeeping Services', timezone: 'America/New_York', posts: [] });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.match(ics, /X-WR-CALNAME:RG Bookkeeping Services - Scheduled Posts/);
  assert.match(ics, /X-WR-TIMEZONE:America\/New_York/);
});

test('buildCalendarFeed emits one VEVENT per post with the correct UTC DTSTART', () => {
  const posts = [
    {
      id: 'abc-123',
      title: 'Q3 estimated tax payments due Sept 15',
      caption_main: 'Reminder to clients.',
      platforms: ['facebook', 'linkedin'],
      planned_date: '2026-08-03',
      planned_time: '09:00:00',
      updated_at: '2026-07-29T16:15:22.810Z',
    },
  ];
  const ics = buildCalendarFeed({ orgName: 'RG Bookkeeping Services', timezone: 'America/New_York', posts });

  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /UID:post-abc-123@rg-social-planner/);
  assert.match(ics, /DTSTART:20260803T130000Z/);
  assert.match(ics, /SUMMARY:Post: Q3 estimated tax payments due Sept 15/);
  assert.match(ics, /Platforms: facebook\\, linkedin/);
  assert.match(ics, /END:VEVENT/);
});

test('buildCalendarFeed escapes commas, semicolons, and newlines in text fields', () => {
  const posts = [
    {
      id: 'esc-1',
      title: 'Tip: reconcile, review; repeat',
      caption_main: 'Line one.\nLine two, with; punctuation.',
      platforms: ['facebook'],
      planned_date: '2026-08-03',
      planned_time: '09:00:00',
      updated_at: '2026-07-29T16:15:22.810Z',
    },
  ];
  const ics = buildCalendarFeed({ orgName: 'Org', timezone: 'America/New_York', posts });
  assert.match(ics, /SUMMARY:Post: Tip: reconcile\\, review\\; repeat/);
  assert.match(ics, /Line one\.\\nLine two\\, with\\; punctuation\./);
});

test('buildCalendarFeed omits VALARM when reminderMinutes is 0 (the default)', () => {
  const posts = [
    {
      id: 'noalarm-1',
      title: 'No reminder',
      caption_main: '',
      platforms: [],
      planned_date: '2026-08-03',
      planned_time: '09:00:00',
      updated_at: '2026-07-29T16:15:22.810Z',
    },
  ];
  const ics = buildCalendarFeed({ orgName: 'Org', timezone: 'America/New_York', posts });
  assert.doesNotMatch(ics, /BEGIN:VALARM/);
});

test('buildCalendarFeed adds a VALARM that triggers reminderMinutes before DTSTART', () => {
  const posts = [
    {
      id: 'alarm-1',
      title: 'Remind me',
      caption_main: '',
      platforms: [],
      planned_date: '2026-08-03',
      planned_time: '09:00:00',
      updated_at: '2026-07-29T16:15:22.810Z',
    },
  ];
  const ics = buildCalendarFeed({ orgName: 'Org', timezone: 'America/New_York', posts, reminderMinutes: 30 });
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Remind me\r\nTRIGGER:-PT30M\r\nEND:VALARM/);
});

test('buildCalendarFeed folds long lines at 75 octets per RFC 5545', () => {
  const longTitle = 'A'.repeat(120);
  const posts = [
    {
      id: 'long-1',
      title: longTitle,
      caption_main: 'short',
      platforms: [],
      planned_date: '2026-08-03',
      planned_time: '09:00:00',
      updated_at: '2026-07-29T16:15:22.810Z',
    },
  ];
  const ics = buildCalendarFeed({ orgName: 'Org', timezone: 'America/New_York', posts });
  const summaryLine = ics.split('\r\n').find((l) => l.startsWith('SUMMARY:'));
  assert.ok(summaryLine.length <= 75, 'the first physical line of a folded property must be <=75 chars');
  assert.match(ics, /SUMMARY:Post: A+\r\n A+/);
});
