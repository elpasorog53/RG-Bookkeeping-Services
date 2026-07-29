// Minimal RFC 5545 (iCalendar) generation for the subscribable calendar
// feed. No new dependency: timezone conversion uses only the built-in Intl
// API, and the format itself is simple enough to hand-write correctly.

// Converts a wall-clock date+time as understood in `timeZone` (e.g. a post
// scheduled for "2026-08-03 09:00" in America/New_York) into the correct
// UTC instant, DST included. This is the same "format, diff, correct"
// technique libraries like date-fns-tz use under the hood.
function zonedWallTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss || 0));

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(guess).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  const diff = guess.getTime() - asIfUtc;
  return new Date(guess.getTime() + diff);
}

function toIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// Escapes text per RFC 5545 3.3.11 (backslash, semicolon, comma, newline).
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Folds a content line at 75 octets per RFC 5545 3.1, required for strict
// parsers even though most modern calendar apps tolerate long lines anyway.
function foldLine(line) {
  const max = 75;
  if (line.length <= max) return line;
  let result = line.slice(0, max);
  let rest = line.slice(max);
  while (rest.length > 0) {
    result += '\r\n ' + rest.slice(0, max - 1);
    rest = rest.slice(max - 1);
  }
  return result;
}

export function buildCalendarFeed({ orgName, timezone, posts }) {
  const now = toIcsUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RG Bookkeeping Social Planner//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(orgName)} - Scheduled Posts`,
    'X-WR-TIMEZONE:' + timezone,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const post of posts) {
    const start = zonedWallTimeToUtc(post.planned_date, post.planned_time, timezone);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-minute placeholder block
    const platforms = (post.platforms || []).join(', ');
    // A real newline here, not a pre-escaped one -- escapeText() below is
    // what turns it into the RFC 5545 "\n" escape sequence. Escaping it
    // ourselves first would just get double-escaped.
    const description = [post.caption_main, platforms ? `Platforms: ${platforms}` : null]
      .filter(Boolean)
      .join('\n\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:post-${post.id}@rg-social-planner`,
      `DTSTAMP:${now}`,
      `DTSTART:${toIcsUtc(start)}`,
      `DTEND:${toIcsUtc(end)}`,
      `LAST-MODIFIED:${toIcsUtc(new Date(post.updated_at))}`,
      foldLine(`SUMMARY:Post: ${escapeText(post.title)}`),
      foldLine(`DESCRIPTION:${escapeText(description)}`),
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export { zonedWallTimeToUtc };
