const assert = require('assert');
const path = require('path');
const R = path.join(__dirname, '..');
require(path.join(R, 'exif.js'));
require(path.join(R, 'backup.js'));
const { parseExifDate } = globalThis.EvoluExif;
const { createBackup, readBackup } = globalThis.EvoluBackup;

// little/big endian の EXIF付きJPEGを組み立てる
function jpeg({ little, original, ifd0Date, leadingApp0 = true }) {
  const w16 = (b, o, v) => little ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
  const w32 = (b, o, v) => little ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
  const t = Buffer.alloc(200);
  t.write(little ? 'II' : 'MM', 0, 'latin1'); w16(t, 2, 42); w32(t, 4, 8);
  const entries = [];
  if (ifd0Date) entries.push([0x0132, 2, 20, 100]);
  if (original) entries.push([0x8769, 4, 1, 50]);
  w16(t, 8, entries.length);
  entries.forEach(([tag, ty, c, v], i) => { const o = 10 + i * 12; w16(t, o, tag); w16(t, o + 2, ty); w32(t, o + 4, c); w32(t, o + 8, v); });
  if (original) { w16(t, 50, 1); w16(t, 52, 0x9003); w16(t, 54, 2); w32(t, 56, 20); w32(t, 60, 130); t.write(original + '\0', 130, 'latin1'); }
  if (ifd0Date) t.write(ifd0Date + '\0', 100, 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const app1 = Buffer.alloc(4); app1[0] = 0xFF; app1[1] = 0xE1; app1.writeUInt16BE(payload.length + 2, 2);
  const app0 = leadingApp0 ? Buffer.from([0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]) : Buffer.alloc(0);
  const b = Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, app1, payload, Buffer.from([0xFF, 0xDA, 0, 2])]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

assert.equal(parseExifDate(jpeg({ little: true, original: '2024:03:15 10:20:30' })), '2024-03-15');
assert.equal(parseExifDate(jpeg({ little: false, original: '2023:12:01 00:00:00' })), '2023-12-01');
assert.equal(parseExifDate(jpeg({ little: true, ifd0Date: '2022:01:02 03:04:05' })), '2022-01-02');
assert.equal(parseExifDate(jpeg({ little: true, original: '2021:05:06 00:00:00', ifd0Date: '2022:01:02 03:04:05' })), '2021-05-06');
assert.equal(parseExifDate(jpeg({ little: true, original: '0000:00:00 00:00:00' })), null);
assert.equal(parseExifDate(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer), null); // PNG
assert.equal(parseExifDate(new ArrayBuffer(0)), null);
// 壊れたデータ・途中で切れたデータで例外を投げないか
const full = jpeg({ little: true, original: '2024:03:15 10:20:30' });
for (let n = 0; n < full.byteLength; n++) {
  const r = parseExifDate(full.slice(0, n));
  assert.ok(r === null || r === '2024-03-15', `truncated at ${n}`);
}
console.log('exif ok');

(async () => {
  const records = [
    { image: new Blob([Buffer.alloc(5000, 7)], { type: 'image/jpeg' }), date: '2024-01-02', memo: '最初の記録🌱' },
    { image: new Blob([Buffer.from('png-bytes')], { type: 'image/png' }), date: '2024-02-03', memo: '' },
    { image: new Blob([Buffer.alloc(100, 9)], { type: '' }), date: '2024-03-04', memo: '改行\nあり' },
  ];
  const zip = await createBackup(records);
  const back = await readBackup(zip);
  assert.equal(back.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(back[i].date, records[i].date);
    assert.equal(back[i].memo, records[i].memo);
    assert.deepEqual(Buffer.from(await back[i].image.arrayBuffer()), Buffer.from(await records[i].image.arrayBuffer()));
  }
  assert.equal(back[1].image.type, 'image/png');

  await assert.rejects(readBackup(new Blob(['not a zip at all, sorry, definitely not'])), /バックアップファイルではありません/);
  console.log('backup ok');
})().catch((e) => { console.error(e); process.exit(1); });
