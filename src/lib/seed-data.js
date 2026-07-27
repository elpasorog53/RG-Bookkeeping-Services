// Seeded once per organization at onboarding (section 16 of the spec).
// Editable afterward in Settings > Pillars; this is only the starting set.
export const DEFAULT_PILLARS = [
  {
    name: 'Bookkeeping Education',
    description: 'Teach small-business owners one useful thing.',
    color: '#2f5d50',
    requires_review: true,
  },
  {
    name: 'Deadlines and Reminders',
    description: 'Time-sensitive nudges: quarterly estimates, 1099 season, year-end docs.',
    color: '#a8542c',
    requires_review: true,
  },
  {
    name: 'Common Mistakes and Tips',
    description: 'Relatable problem/solution content.',
    color: '#4a6fa5',
    requires_review: true,
  },
  {
    name: 'Services and FAQs',
    description: 'Explain what RG does and answer real questions.',
    color: '#6b6b6b',
    requires_review: false,
  },
  {
    name: 'Trust, Local, and Encouragement',
    description: 'Credibility and humanity: client wins (anonymized), local shoutouts, encouragement.',
    color: '#8a5fb0',
    requires_review: true,
  },
  {
    name: 'Book a Consultation',
    description: 'Direct ask with a clear offer and scheduling link.',
    color: '#c2872f',
    requires_review: false,
  },
];
