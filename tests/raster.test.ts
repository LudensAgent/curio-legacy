import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { encodePng, renderVisionPng } from '../src/perception/raster.ts';
import { CATS, DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('raycast view PNG is a standard bounded RGBA image carrying the actual observed frame', () => {
  const adapter = new FakeAdapter(), vision = new Vision(adapter, { ...DEFAULT_VISION, cols: 16, rows: 12, range: 20, bandCols: 0, bandRows: 0 });
  vision.scan();
  const frame = vision.frame!;
  assert.ok(frame.cats.includes(CATS.indexOf('sky')));
  const png = renderVisionPng(frame, 2);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 24);
  assert.equal(png[25], 6, 'PNG color type must be RGBA');
  let compressed = Buffer.alloc(0);
  for (let cursor = 8; cursor < png.length;) {
    const length = png.readUInt32BE(cursor), name = png.toString('ascii', cursor + 4, cursor + 8);
    if (name === 'IDAT') compressed = Buffer.concat([compressed, png.subarray(cursor + 8, cursor + 8 + length)]);
    cursor += length + 12;
  }
  const pixels = inflateSync(compressed);
  assert.equal(pixels.length, 24 * (32 * 4 + 1));
  assert.throws(() => encodePng(1, 1, new Uint8Array(3)), /Invalid/);
  assert.throws(() => renderVisionPng({ ...frame, cats: [] }), /Invalid/);
});
