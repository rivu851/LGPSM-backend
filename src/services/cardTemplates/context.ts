import { Template } from '../../models/Template';
import { Category } from '../../models/Category';
import { resolveCardDesign } from './designs';

export interface CardContext {
  cardDesign: ReturnType<typeof resolveCardDesign>;
  categoryName?: string;
  subcategoryName?: string;
}

interface EventLike {
  title?: string;
  templateId?: unknown;
  categoryId?: unknown;
  subcategoryId?: unknown;
}

/**
 * Everything about an event's *type* that card rendering needs, looked up once per send rather than per guest:
 * the category and subcategory names, and the design (the chosen template's, else the one that suits the type).
 */
export async function loadCardContext(event: EventLike): Promise<CardContext> {
  const [template, category] = await Promise.all([
    event.templateId ? Template.findById(event.templateId as never).select('cardDesign').lean() : null,
    event.categoryId ? Category.findById(event.categoryId as never).select('name subcategories').lean() : null
  ]);
  const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
  const categoryName = category?.name;
  const subcategoryName = subcategory?.name;
  return {
    cardDesign: resolveCardDesign({ templateDesign: template?.cardDesign, categoryName, subcategoryName, title: event.title }),
    categoryName,
    subcategoryName
  };
}
