import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bomEncoding, decodeBytes, decoderLabel, isAscii, isBinaryText, looksBinary } from '../src/textDecode';

const bytes = (...b: number[]) => Uint8Array.from(b);

test('bomEncoding: UTF-8, UTF-16LE and UTF-16BE marks', () => {
  assert.equal(bomEncoding(bytes(0xef, 0xbb, 0xbf, 0x61)), 'utf-8');
  assert.equal(bomEncoding(bytes(0xff, 0xfe, 0x61, 0)), 'utf-16le');
  assert.equal(bomEncoding(bytes(0xfe, 0xff, 0, 0x61)), 'utf-16be');
  assert.equal(bomEncoding(bytes(0x61, 0x62)), undefined);
  assert.equal(bomEncoding(bytes()), undefined);
});

test('decodeBytes: a byte order mark wins over the setting and is dropped', () => {
  assert.equal(decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('é')]), 'windows1252'), 'é');
  assert.equal(decodeBytes(Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide é\n', 'utf16le')]))), 'wide é\n');
  const be = Buffer.from('big é\n', 'utf16le').swap16();
  assert.equal(decodeBytes(Uint8Array.from(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), 'utf8'), 'big é\n');
});

test('decoderLabel: VS Code encoding ids map to TextDecoder labels', () => {
  assert.equal(decoderLabel('windows1252'), 'windows-1252');
  assert.equal(decoderLabel('iso88591'), 'iso-8859-1');
  assert.equal(decoderLabel('iso885915'), 'iso-8859-15');
  assert.equal(decoderLabel('shiftjis'), 'shift_jis');
  assert.equal(decoderLabel('eucjp'), 'euc-jp');
  assert.equal(decoderLabel('macroman'), 'macintosh');
  assert.equal(decoderLabel('utf8bom'), 'utf-8');
  assert.equal(decoderLabel('cp437'), undefined, 'an encoding TextDecoder lacks');
  assert.equal(decoderLabel(''), undefined);
  assert.equal(decoderLabel(undefined), undefined);
});

test('decodeBytes: the file encoding setting, else UTF-8', () => {
  const latin1 = Uint8Array.from(Buffer.from('café = 1\n', 'latin1'));
  assert.equal(decodeBytes(latin1, 'windows1252'), 'café = 1\n');
  assert.equal(decodeBytes(latin1, 'iso88591'), 'café = 1\n');
  assert.equal(decodeBytes(Uint8Array.from([0x80, 0x9f]), 'iso88591'), '\u0080\u009f', 'ISO-8859-1 is Latin-1, not windows-1252');
  assert.equal(decodeBytes(Uint8Array.from([0x80]), 'windows1252'), '€');
  assert.equal(decodeBytes(Uint8Array.from([0x82, 0xa0]), 'shiftjis'), 'あ');
  assert.equal(decodeBytes(Uint8Array.from(Buffer.from('café\n')), undefined), 'café\n');
  assert.equal(decodeBytes(Uint8Array.from(Buffer.from('café\n')), 'cp437'), 'café\n', 'an unknown encoding falls back to UTF-8');
  assert.equal(decodeBytes(latin1, 'utf8'), 'caf� = 1\n');
});

test('isBinaryText: a NUL in the first 8000 characters, after decoding', () => {
  assert.equal(isBinaryText('abc\u0000def'), true);
  assert.equal(isBinaryText('a'.repeat(8000) + '\u0000'), false);
  assert.equal(isBinaryText(decodeBytes(Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('text', 'utf16le')])))), false);
  assert.equal(isBinaryText(decodeBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0, 0))), true);
});

test('looksBinary: NUL bytes, except in UTF-16 with a byte order mark', () => {
  assert.equal(looksBinary(bytes(0x89, 0x50, 0, 1)), true);
  assert.equal(looksBinary(Uint8Array.from(Buffer.from('plain text'))), false);
  assert.equal(looksBinary(Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('text', 'utf16le')]))), false);
});

test('isAscii', () => {
  assert.equal(isAscii(Uint8Array.from(Buffer.from('plain\n'))), true);
  assert.equal(isAscii(Uint8Array.from(Buffer.from('café'))), false);
});
