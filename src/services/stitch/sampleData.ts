import type { SpecTexts } from '../cardTemplates/specRenderer';

// Sample event details for template previews and the converter's quality check. Clearly generic: they are never
// stored in a template, only drawn into a preview image.

export const SAMPLE_TEXTS: Record<'INVITATION' | 'POSTER', SpecTexts> = {
  INVITATION: {
    title: 'Annual Leadership Summit',
    description: 'An evening of talks, awards and networking for our community.',
    date: '7th November, 2026',
    time: '6:00 PM – 10:00 PM',
    dateTime: 'Saturday, 7th November, 2026 · 6:00 PM',
    venue: 'The Grand Ballroom, 24 Park Street, Kolkata',
    organizer: 'Your Organization',
    inviteeName: 'Guest Name',
    inviteeMeta: 'Company Name'
  },
  POSTER: {
    title: 'Annual Leadership Summit',
    description: 'An evening of talks, awards and networking for our community.',
    date: '7th November, 2026',
    time: '6:00 PM – 10:00 PM',
    dateTime: 'Saturday, 7th November, 2026 · 6:00 PM',
    venue: 'The Grand Ballroom, 24 Park Street, Kolkata',
    organizer: 'Your Organization'
  }
};
