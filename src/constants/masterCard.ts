/**
 * For now the master card is the only invitation design (decision for the testing round): it is the only template listed, and every
 * event's card is drawn from it, whatever template the event was made with. Nothing was deleted: set MASTER_CARD_ONLY=false in the
 * environment to bring the other templates and designs back. (The automated tests keep the full set of designs unless a test turns the
 * mode on with MASTER_CARD_ONLY=true.)
 */
export function masterCardOnly(): boolean {
  const v = process.env.MASTER_CARD_ONLY;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return process.env.NODE_ENV !== 'test';
}
