import { withCurrentLayout } from './uploadedTemplate';
import { Template } from '../../models/Template';
import { Category } from '../../models/Category';
import { User } from '../../models/User';
import { resolveCardDesign } from './designs';
import { DesignSpec, safeParseDesignSpec } from './designSpec';
import { masterCardOnly } from '../../constants/masterCard';

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
  const [rawTemplate, category] = await Promise.all([
    event.templateId ? Template.findById(event.templateId as never).select('cardDesign designSpec ownerId isSystemTemplate isPublished isActive templateData').lean() : null,
    event.categoryId ? Category.findById(event.categoryId as never).select('name subcategories').lean() : null
  ]);
  // (an old admin upload has its wording read once, so real sends and the event's card preview replace it just like the form's preview)
  const template = await withCurrentLayout(rawTemplate as any) as typeof rawTemplate;
  const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
  const categoryName = category?.name;
  const subcategoryName = subcategory?.name;

  // A custom design is only drawn for an event it may serve: the designers'/admin's published templates for anyone,
  // an organizer's own template for that organizer's events. Anything else (another organizer's design, a deleted or
  // unreadable one) falls back to the design that suits the event type, so a card is always produced.
  let designSpec: DesignSpec | undefined;
  let templateDesign: string | null | undefined = template?.cardDesign;
  // (while the master card is the only shared design, only an organizer's own uploaded design is drawn besides it, for that organizer's events)
  if (template?.cardDesign === 'CUSTOM' && (!masterCardOnly() || (!!template.ownerId && String(template.ownerId) === String(event.organizerId)))) {
    // (a "retired" template is no longer offered in the template list, but the events that already use it keep their card)
    const usable =
      (template.isActive !== false || (template as any).templateData?.retired === true) &&
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

/**
 * Does the card itself carry the guest's entry QR? Not when the organizer turned the QR off on the card, and not on an organizer's own
 * static design (the picture is sent exactly as it is). Then the guest's email and invitation page show the QR on its own.
 */
export const cardCarriesQr = (event: { cardDisplay?: { qr?: boolean } | null }, context: { designSpec?: { meta?: { plain?: boolean } } | null }): boolean =>
  event.cardDisplay?.qr !== false && !context.designSpec?.meta?.plain;
