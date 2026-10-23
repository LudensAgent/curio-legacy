import { deflateSync } from 'node:zlib';
import type { Eye } from '../adapter/types.ts';
import { CATS, type Cat, type VisionFrame } from './vision.ts';

export interface VisualCapture {
  png: Uint8Array;
  source: 'voxel_raycast';
  worldId: string;
  dimension: string;
  sessionId: string;
  observationId: number;
  eye: Eye;
}

const colors: Record<Cat, [number, number, number]> = {
  unknown: [45, 45, 55], sky: [125, 185, 230], dark: [10, 12, 18], water: [45, 95, 170], lava: [245, 95, 15],
  leaves: [65, 115, 45], wood: [115, 85, 50], grass: [85, 135, 60], dirt: [125, 90, 65], sand: [215, 200, 145],
  stone: [125, 125, 130], ore: [130, 150, 150], snow: [225, 235, 245], plant: [80, 145, 55], built: [165, 125, 80], other: [145, 135, 135],
};
function crc32(buffer: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data: Buffer) {
  const name = Buffer.from(kind), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1024 || height > 1024 || rgba.length !== width * height * 4) throw new Error('Invalid PNG dimensions');
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

/** A visualization of actual first-hit raycast observations; semantic colors are not game textures. */
export function renderVisionPng(frame: VisionFrame, scale = 4): Buffer {
  if (!Number.isInteger(scale) || scale < 1 || scale > 8 || frame.cols < 1 || frame.rows < 1 || frame.cols > 128 || frame.rows > 128 || frame.cats.length !== frame.cols * frame.rows || frame.dists.length !== frame.cats.length) throw new Error('Invalid observed frame');
  const width = frame.cols * scale, height = frame.rows * scale;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = Math.floor(y / scale) * frame.cols + Math.floor(x / scale);
    const cat = CATS[frame.cats[source]] ?? 'unknown';
    const color = colors[cat], shade = cat === 'sky' ? 1 : 0.65 + 0.35 * (1 - Math.min(255, Math.max(0, frame.dists[source])) / 255);
    pixels.set([...color.map((c) => Math.round(c * shade)), 255], (y * width + x) * 4);
  }
  return encodePng(width, height, pixels);
}
