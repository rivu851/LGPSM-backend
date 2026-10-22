import { CARD_DESIGNS, CardDesign } from '../../models/Template';

// Which invitation design an event gets. An organizer's explicit template choice always wins. Without one, the design
// follows the event type (its category, subcategory and, as a last resort, its title), so every event gets a card
// that suits the occasion even when nobody picked a template.

export interface EventTypeInfo {
  categoryName?: string;
  subcategoryName?: string;
  title?: string;
}

const RULES: Array<{ design: CardDesign; test: RegExp }> = [
  { design: 'BIRTHDAY', test: /\b(birthday|bday|b['’]day|janmadin|jonmodin)\b/i },
  { design: 'RICE_CEREMONY', test: /(rice\s*ceremony|annaprasan|annaprashan|mukhe\s*bhaat|mukhebhat|first\s*rice)/i },
  { design: 'WEDDING', test: /(wedding|reception|marriage|engagement|sangeet|haldi|mehend|mehndi|anniversary|bou\s*bhat|ring\s*ceremony|shaadi|sagai)/i },
  { design: 'CORPORATE_V1', test: /(award|recognition|felicitation|excellence|honou?r)/i },
];

export const DEFAULT_CARD_DESIGN: CardDesign = 'CORPORATE_V2';

function match(text: string): CardDesign | null {
  for (const rule of RULES) if (rule.test.test(text)) return rule.design;
  return null;
}

export function resolveCardDesign(options: EventTypeInfo & { templateDesign?: string | null }): CardDesign {
  const chosen = options.templateDesign;
  if (chosen && (CARD_DESIGNS as readonly string[]).includes(chosen)) return chosen as CardDesign;
  // The specific type (subcategory, then category) is a stronger signal than words that happen to be in a title
  return match(options.subcategoryName || '') || match(options.categoryName || '') || match(options.title || '') || DEFAULT_CARD_DESIGN;
}
