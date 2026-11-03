import zlib from 'zlib';

// An upload is checked before the spreadsheet library sees it. The library also reads HTML, CSV and other formats by content, so the
// declared type and file name prove nothing. An .xlsx is a zip whose parts inflate in memory, so a 5 MB upload could expand to gigabytes
// and take the process down: every part is inflated here under a hard total limit first (the sizes a zip declares can be false).
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 2000;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // legacy .xls

const refuse = (message: string) => ({ statusCode: 400, message });
const NOT_A_WORKBOOK = 'The file could not be read as an Excel sheet';
const TOO_LARGE = 'This workbook is too large to import. Keep only the invitee sheet and try again.';

export function assertSafeWorkbook(file: Buffer): void {
  if (file.length >= OLE_MAGIC.length && file.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) return; // not compressed: bounded by the upload limit
  if (file.length < 22 || !file.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) throw refuse(NOT_A_WORKBOOK);

  // End-of-central-directory record: at the end of the file, before an optional comment of at most 64 KB
  let end = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
    if (file.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw refuse(NOT_A_WORKBOOK);
  const entries = file.readUInt16LE(end + 10);
  const directoryOffset = file.readUInt32LE(end + 16);
  if (entries > MAX_ENTRIES) throw refuse(TOO_LARGE);

  let at = directoryOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > file.length || file.readUInt32LE(at) !== 0x02014b50) throw refuse(NOT_A_WORKBOOK);
    const method = file.readUInt16LE(at + 10);
    const compressed = file.readUInt32LE(at + 20);
    const declared = file.readUInt32LE(at + 24);
    const nameLen = file.readUInt16LE(at + 28);
    const extraLen = file.readUInt16LE(at + 30);
    const commentLen = file.readUInt16LE(at + 32);
    const localOffset = file.readUInt32LE(at + 42);
    at += 46 + nameLen + extraLen + commentLen;

    if (declared === 0xffffffff || compressed === 0xffffffff) throw refuse(TOO_LARGE); // zip64: no real workbook of this size needs it
    total += declared;
    if (total > MAX_INFLATED_BYTES) throw refuse(TOO_LARGE);

    if (localOffset + 30 > file.length || file.readUInt32LE(localOffset) !== 0x04034b50) throw refuse(NOT_A_WORKBOOK);
    const dataStart = localOffset + 30 + file.readUInt16LE(localOffset + 26) + file.readUInt16LE(localOffset + 28);
    if (method === 8) {
      const remaining = MAX_INFLATED_BYTES - (total - declared);
      let inflated: Buffer;
      try {
        inflated = zlib.inflateRawSync(file.subarray(dataStart, dataStart + compressed), { maxOutputLength: remaining });
      } catch (e: any) {
        throw refuse(e?.code === 'ERR_BUFFER_TOO_LARGE' ? TOO_LARGE : NOT_A_WORKBOOK);
      }
      total += inflated.length - declared; // what it really inflates to, not what it claimed
      if (total > MAX_INFLATED_BYTES) throw refuse(TOO_LARGE);
    } else if (method !== 0) {
      throw refuse(NOT_A_WORKBOOK);
    }
  }
}
