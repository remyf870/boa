// A.8.7: file-type allowlist by MAGIC BYTES, never by extension or declared
// content type. Allowed: pdf, jpg, png, xlsx.
// Honest limit: xlsx is a ZIP container, so any ZIP passes the byte check —
// the import paths additionally prove the file parses as a real workbook, and
// everything is virus-scanned before it is retrievable either way.

export type AllowedKind = 'pdf' | 'jpg' | 'png' | 'xlsx';

export interface DetectedFile {
  kind: AllowedKind;
  contentType: string;
}

export function detectFileKind(buffer: Buffer): DetectedFile | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { kind: 'pdf', contentType: 'application/pdf' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { kind: 'png', contentType: 'image/png' };
  }
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return {
      kind: 'xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  return null;
}
