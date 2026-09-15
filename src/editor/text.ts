export interface TextEdit { from: number; to: number; insert: string }

/** Find a single replacement without splitting UTF-16 surrogate pairs. */
export function textChange(before: string, after: string): TextEdit | undefined {
  if (before === after) return undefined;
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  if (from > 0 && isLowSurrogate(before.charCodeAt(from))) from--;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (isLowSurrogate(before.charCodeAt(endBefore))) { endBefore++; endAfter++; }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

export function utf16ToByte(text: string, column: number): number {
  return Buffer.byteLength(text.slice(0, column), "utf8");
}

export function byteToUtf16(text: string, column: number): number {
  let bytes = 0;
  let offset = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > column) break;
    bytes += size;
    offset += char.length;
  }
  return offset;
}

export function nextChar(text: string, offset: number): number {
  return Math.min(text.length, offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1));
}
