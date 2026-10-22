/**
 * Decodes file bytes the way the editor reads them when VS Code cannot do it
 * for us (`workspace.decode` arrived in 1.100): a byte order mark wins, then
 * the file's `files.encoding`, then UTF-8. Pure, so it runs without VS Code.
 */

/** How many leading characters (or bytes) are checked for a NUL, as git does. */
const BINARY_SNIFF = 8000;

/** VS Code encoding ids whose TextDecoder label is not just the id with dashes put back. */
const LABELS: Record<string, string> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  macroman: 'macintosh',
  cp866: 'ibm866',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  koi8ru: 'koi8-ru',
  gbk: 'gbk',
  gb2312: 'gb2312',
  gb18030: 'gb18030',
  cp950: 'big5',
  big5hkscs: 'big5',
  shiftjis: 'shift_jis',
  eucjp: 'euc-jp',
  euckr: 'euc-kr',
};

/** The encoding a byte order mark names, if the bytes start with one. */
export function bomEncoding(bytes: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** The TextDecoder label for a VS Code encoding id (`windows1252`, `shiftjis`), or undefined when it has none. */
export function decoderLabel(encoding: string | undefined): string | undefined {
  if (!encoding) return undefined;
  const id = encoding.toLowerCase();
  const label = LABELS[id] ?? id.replace(/^windows(\d+)$/, 'windows-$1').replace(/^iso8859(\d+)$/, 'iso-8859-$1');
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return undefined;
  }
}

/** Text of the bytes: by their byte order mark, else in `encoding` (a VS Code id), else UTF-8. The mark is dropped. */
export function decodeBytes(bytes: Uint8Array, encoding?: string): string {
  const label = bomEncoding(bytes) ?? decoderLabel(encoding) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // A Node without full ICU knows only UTF-8 and UTF-16LE.
    if (label === 'utf-16be') return new TextDecoder('utf-16le').decode(swapBytes(bytes));
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** True for decoded text that is binary: a NUL among its first characters. */
export function isBinaryText(text: string): boolean {
  return text.slice(0, BINARY_SNIFF).includes('\u0000');
}

/** The same test on raw bytes, for a file not worth decoding: UTF-16 with a byte order mark is text. */
export function looksBinary(bytes: Uint8Array): boolean {
  const bom = bomEncoding(bytes);
  if (bom === 'utf-16le' || bom === 'utf-16be') return false;
  return bytes.subarray(0, BINARY_SNIFF).includes(0);
}

/** True when every byte is ASCII, which every ASCII-compatible encoding reads the same. */
export function isAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
  return true;
}

function swapBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1];
    out[i + 1] = bytes[i];
  }
  return out;
}
