import { buildTemplateTexts } from '../src/services/cardTemplates/content';

// The place on the card is the Event Location exactly as the organizer wrote it, whatever separators it holds
describe('venue text on the card', () => {
  const designs = ['CORPORATE_V1', 'CORPORATE_V2', 'WEDDING', 'RICE_CEREMONY', 'BIRTHDAY'] as const;
  const venues = ['Tollygunge, West Bengal, Kolkata - 700033, India', 'Tollygunge West Bengal Kolkata - 700033 India', 'Hall 4; Science City / Kolkata'];

  it.each(designs)('%s prints the whole location, never just its last parts', (design) => {
    for (const venue of venues) {
      expect(buildTemplateTexts({ design, title: 'Gala', venue } as any).address).toBe(venue);
    }
  });

  it('only falls back to the city when no location was given, and says Online event for virtual events', () => {
    expect(buildTemplateTexts({ design: 'CORPORATE_V2', title: 'Gala', venue: '', locationSub: 'Kolkata' } as any).address).toBe('Kolkata');
    expect(buildTemplateTexts({ design: 'CORPORATE_V2', title: 'Gala', venue: 'x', isVirtual: true } as any).address).toBe('Online event');
  });
});
