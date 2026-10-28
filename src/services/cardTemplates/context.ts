import { Template } from '../../models/Template';
import { Category } from '../../models/Category';
import { User } from '../../models/User';
import { resolveCardDesign } from './designs';
import { DesignSpec, safeParseDesignSpec } from './designSpec';

export interface CardContext {
  cardDesign: ReturnType<typeof resolveCardDesign>;
  categoryName?: string;
  subcategoryName?: string;
  /** Set when the event's template is an AI/custom design that may be used for this event: the design to render */
  designSpec?: DesignSpec;
  organizerName?: string;
}

interface EventLike {
  title?: string;
  templateId?: unknown;
  organizerId?: unknown;
  categoryId?: unknown;
  subcategoryId?: unknown;
}

/**
 * Everything about an event's *type* that card rendering needs, looked up once per send rather than per guest:
 * the category and subcategory names, and the design (the chosen template's, else the one that suits the type).
 */
/** The host printed on invitation cards: the organiser's organisation, never the person's own name (blank when unset). */
export function cardHostName(organizer: { profile?: { organizationName?: string } } | null | undefined): string | undefined {
  return organizer?.profile?.organizationName?.trim() || undefined;
}

export async function loadCardContext(event: EventLike): Promise<CardContext> {
  const [template, category] = await Promise.all([
    event.templateId ? Template.findById(event.templateId as never).select('cardDesign designSpec ownerId isSystemTemplate isPublished isActive').lean() : null,
    event.categoryId ? Category.findById(event.categoryId as never).select('name subcategories').lean() : null
  ]);
  const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
  const categoryName = category?.name;
  const subcategoryName = subcategory?.name;

  // A custom design is only drawn for an event it may serve: the designers'/admin's published templates for anyone,
  // an organizer's own template for that organizer's events. Anything else (another organizer's design, a deleted or
  // unreadable one) falls back to the design that suits the event type, so a card is always produced.
  let designSpec: DesignSpec | undefined;
  let templateDesign: string | null | undefined = template?.cardDesign;
  if (template?.cardDesign === 'CUSTOM') {
    const usable =
      template.isActive !== false &&
      (!template.ownerId || (template.isSystemTemplate && template.isPublished !== false) || String(template.ownerId) === String(event.organizerId));
    const parsed = usable ? safeParseDesignSpec(template.designSpec) : null;
    if (parsed?.ok && parsed.spec.kind === 'INVITATION') designSpec = parsed.spec;
    else {
      templateDesign = undefined;
      console.warn('[cards] A custom template could not be used for an event; using the default design for its type');
    }
  }
  const organizer = designSpec && event.organizerId ? await User.findById(event.organizerId as never).select('profile.organizationName').lean() : null;
  return {
    cardDesign: designSpec ? 'CUSTOM' : resolveCardDesign({ templateDesign, categoryName, subcategoryName, title: event.title }),
    categoryName,
    subcategoryName,
    designSpec,
    organizerName: cardHostName(organizer)
  };
}
