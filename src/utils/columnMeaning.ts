// What a column heading or a custom title MEANS, not just what it says: "Ph No", "Contact no.", "telephone", "Mobile Number" and a
// mistyped "Telphone" all mean the guest's mobile number. The invitee Excel always has a Name, an Email and a Mobile column, so a custom
// title that means one of them must not create a second column for the same thing. This file is copied word for word into the web and
// the mobile apps (src/utils/columnMeaning.ts), so the sample Excel, the import and the card always agree.

export type ColumnMeaning = 'name' | 'email' | 'mobile' | 'company';

const WORDS: Record<ColumnMeaning, string[]> = {
  mobile: ['phone', 'phones', 'mobile', 'mobiles', 'mob', 'cell', 'cellphone', 'cellular', 'telephone', 'telephon', 'tel', 'telno', 'ph', 'phn', 'phno', 'whatsapp', 'whatsap', 'wa', 'landline', 'contact', 'contacts', 'msisdn', 'mobno', 'smartphone', 'handphone', 'dial'],
  email: ['email', 'emails', 'mail', 'mails', 'gmail', 'emailid', 'mailid', 'emailaddress', 'inbox'],
  name: ['name', 'names', 'fullname', 'firstname', 'lastname', 'surname', 'fname', 'lname', 'guest', 'guests', 'invitee', 'invitees', 'attendee', 'attendees', 'participant', 'visitor', 'delegate', 'person', 'naam', 'invited', 'title'],
  company: ['company', 'companies', 'organisation', 'organization', 'org', 'firm', 'employer', 'business', 'institution', 'institute', 'corporation', 'enterprise', 'workplace'],
};
// words that say "which kind of value" without saying what it is about
const FILLER = new Set(['no', 'nos', 'number', 'numbers', 'num', 'nr', 'id', 'ids', 'of', 'the', 'a', 'an', 'your', 'my', 'our', 'their', 'for', 'address', 'addr', 'details', 'detail', 'info', 'information', 'field', 'column', 'primary', 'secondary', 'additional', 'sample', 'value', 'please', 'enter', 'full', 'first', 'last', 'middle', 'given', 'family', 'complete', 'legal']);
// words that are close to a standard word but are details of their own: never matched by spelling
const NOT_TYPOS = new Set(['employee', 'employees', 'role', 'team', 'area', 'time', 'date', 'type', 'city', 'state', 'zone', 'seat', 'unit', 'pass', 'tag', 'age', 'sex', 'dob', 'hall', 'gate', 'room', 'floor', 'batch', 'class', 'grade', 'post', 'main', 'meal', 'food', 'table', 'badge', 'group', 'level', 'rank', 'code', 'country', 'pin', 'pincode', 'zip', 'gender', 'blood', 'diet', 'size', 'shirt', 'tshirt', 'branch', 'dept', 'department', 'designation', 'position']);
// "person" words: with "contact" they make a person's name ("Contact Person"), not a phone number
const PERSON = new Set(['person', 'guest', 'guests', 'invitee', 'invitees', 'attendee', 'attendees', 'participant', 'visitor', 'delegate']);

const LOOKUP = new Map<string, ColumnMeaning>();
(Object.keys(WORDS) as ColumnMeaning[]).forEach((m) => WORDS[m].forEach((w) => { if (!LOOKUP.has(w)) LOOKUP.set(w, m); }));
// "title" alone is an honorific column elsewhere, but as a custom title "Name Title" means the name: kept out of the table above on purpose
LOOKUP.delete('title');
const WORD_LIST = [...LOOKUP.keys()];

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // edit distance where two letters swapped ("emial") count as one slip
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The meaning of one word, allowing a typo in the longer words ("telphone", "emial", "mobil") */
function wordMeaning(word: string): ColumnMeaning | null {
  const exact = LOOKUP.get(word);
  if (exact) return exact;
  if (word.length < 3 || NOT_TYPOS.has(word)) return null;
  const allowed = word.length >= 8 ? 2 : 1;
  let best: { m: ColumnMeaning; d: number } | null = null;
  for (const w of WORD_LIST) {
    if (w.length < 4 || (word.length === 3 && w.length !== 4)) continue; // a three-letter slip only against four-letter words ("nme" -> "name")
    const dist = distance(word, w, allowed);
    if (dist <= allowed && (!best || dist < best.d)) best = { m: LOOKUP.get(w)!, d: dist };
  }
  return best ? best.m : null;
}

/** "mobileno" -> ["mobile", "no"], "phonenumber" -> ["phone", "number"]: a heading written as one run-together word */
function split(word: string): string[] {
  if (LOOKUP.has(word) || FILLER.has(word)) return [word];
  for (const w of [...WORD_LIST, ...FILLER].sort((a, b) => b.length - a.length)) {
    if (w.length < 2 || word.length <= w.length) continue;
    if (word.startsWith(w)) { const rest = split(word.slice(w.length)); if (rest.every((r) => LOOKUP.has(r) || FILLER.has(r))) return [w, ...rest]; }
    if (word.endsWith(w)) { const rest = split(word.slice(0, -w.length)); if (rest.every((r) => LOOKUP.has(r) || FILLER.has(r))) return [...rest, w]; }
  }
  return [word];
}

/**
 * Every standard column this heading means (usually one, none when it is its own thing such as "Badge No." or "Designation").
 * A heading with a word of its own ("Guest Type", "Employee ID") means none of them.
 */
export function meaningsOf(title: string | null | undefined): ColumnMeaning[] {
  const text = (title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\be[\s._-]*mail\b/g, 'email')
    .replace(/\bph[\s._-]*no\b/g, 'phone')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!text) return [];
  const words = text.split(' ').flatMap((w) => split(w.replace(/\d+/g, ''))).filter(Boolean);
  const content = words.filter((w) => !FILLER.has(w) && w !== 'and');
  if (content.length === 0) return [];
  const found: ColumnMeaning[] = [];
  for (const w of content) {
    const m = wordMeaning(w);
    if (!m) return []; // a word that is not about a standard column: this is a detail of its own
    if (!found.includes(m)) found.push(m);
  }
  // "Contact Person" / "Guest Contact Name" are names; "Company Name" / "Email Name" are about the first word
  if (found.includes('mobile') && content.includes('contact') && content.some((w) => PERSON.has(w) || w === 'name') && !content.some((w) => LOOKUP.get(w) === 'mobile' && w !== 'contact')) {
    return found.filter((m) => m !== 'mobile').concat('name').filter((m, i, a) => a.indexOf(m) === i);
  }
  if (found.length > 1 && found.includes('name')) return found.filter((m) => m !== 'name');
  return found;
}

/** The one standard column a heading means, or null (a heading about two things counts as none: it needs a human) */
export function meaningOf(title: string | null | undefined): ColumnMeaning | null {
  const all = meaningsOf(title);
  return all.length === 1 ? all[0] : null;
}
