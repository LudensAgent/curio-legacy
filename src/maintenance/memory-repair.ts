import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';
import { recallText } from '../memory/recollection.ts';
import type { Landmark } from '../memory/store.ts';

/** Offline projection only: callers own backups, quiescence, and atomic file replacement. */
export function repairMemoryData(input: unknown, options: { kind: 'world' | 'episodes' | 'mind'; worldId: string; worldMemory?: unknown; now?: number }) {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const dimensions = new Set(['overworld', 'the_nether', 'the_end']);
  if (!options.worldId.trim()) throw new Error('Expected an explicit world identity');
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid repair clock');
  const source = options.kind === 'world' ? input : options.worldMemory;
  if (!object(source) || source.version !== 3 || source.worldId !== options.worldId) throw new Error('Expected version 3 memory for the selected world');
  if (!object(source.chests ?? {}) || !Array.isArray(source.landmarks ?? [])) throw new Error('Invalid spatial memory collections');
  const readSite = (value: unknown) => {
    if (!object(value) || typeof value.worldId !== 'string' || !value.worldId || typeof value.dim !== 'string' || !dimensions.has(value.dim)
      || typeof value.ts !== 'number' || !Number.isFinite(value.ts) || !object(value.pos)
      || typeof value.pos.x !== 'number' || typeof value.pos.y !== 'number' || typeof value.pos.z !== 'number'
      || ![value.pos.x, value.pos.y, value.pos.z].every(Number.isFinite)) throw new Error('Invalid or unscoped historical location');
    return { worldId: value.worldId, dim: value.dim, ts: value.ts, pos: { x: value.pos.x, y: value.pos.y, z: value.pos.z } };
  };
  const sites: Landmark[] = [
    ...Object.entries(source.chests ?? {}).map(([id, value]) => ({ id, kind: 'discovery' as const, label: '箱子', ...readSite(value) })),
    ...((source.landmarks ?? []) as unknown[]).flatMap((value, index) => {
      if (!object(value) || typeof value.label !== 'string') throw new Error('Invalid landmark');
      const site = readSite(value);
      return isContainerLandmark(value.label) ? [{ id: `landmark:${index}`, kind: 'discovery' as const, label: value.label, ...site }] : [];
    }),
  ].filter((site) => site.worldId === options.worldId);
  // Projecting the locations here checks the same policy used by text recall, without rewriting sites.
  const locations = sites.map((site) => chestLocation(site, { now }));
  const memory = { chests: () => [], landmarks: () => sites };
  const changed = { texts: 0, quarantined: 0 };
  const quarantine: { path: string; reason: string; value: unknown }[] = [];
  const isolate = (path: string, reason: string, value: unknown) => {
    quarantine.push({ path, reason, value: structuredClone(value) }); changed.quarantined++;
  };
  const project = (text: string, dimension: string | undefined, observedAt: number) => {
    const projected = recallText(text, memory, dimension, observedAt, now);
    if (projected !== text) changed.texts++;
    return projected;
  };
  if (options.kind === 'episodes') {
    if (!Array.isArray(input)) throw new Error('Expected an episode array');
    const data = input.flatMap((value, index) => {
      const path = `episodes[${index}]`;
      if (!object(value) || typeof value.id !== 'string' || typeof value.text !== 'string' || typeof value.source !== 'string'
        || typeof value.ts !== 'number' || !Number.isFinite(value.ts) || !['experience', 'inference'].includes(String(value.kind))) {
        isolate(path, 'invalid_episode', value); return [];
      }
      if (value.worldId !== options.worldId) { isolate(path, 'unverified_world', value); return []; }
      if (typeof value.dimension !== 'string' || !dimensions.has(value.dimension)) { isolate(path, 'unverified_dimension', value); return []; }
      const distance = /首次看见[^\n。]*?[（(]\s*(\d+(?:\.\d+)?)\s*格外[）)]/.exec(value.text);
      if (distance && Number(distance[1]) > 64 && (value.source === 'discovery' || value.text.startsWith('首次看见'))) {
        isolate(path, 'discovery_beyond_64_blocks', value); return [];
      }
      return [{ ...structuredClone(value), text: project(value.text, value.dimension, value.kind === 'inference' ? 0 : value.ts) }];
    });
    return { data, changed, quarantine, locations };
  }
  if (!object(input)) throw new Error('Expected an object document');
  const data = structuredClone(input);
  const sections = options.kind === 'world'
    ? [{ key: 'notes', fields: ['text'] }, { key: 'goals', fields: ['goal', 'summary'] }, { key: 'lessons', fields: ['text'] }]
    : [{ key: 'knowHow', fields: ['text'] }, { key: 'diary', fields: ['text'] }, { key: 'thoughts', fields: ['text'] },
      { key: 'stream', fields: ['text'] }, { key: 'history', fields: ['what', 'summary'] }];
  sections.forEach(({ key, fields }) => {
    const collection = data[key];
    if (collection === undefined) return;
    if (!Array.isArray(collection)) throw new Error(`Expected an array: ${key}`);
    data[key] = collection.flatMap((value: unknown, index) => {
      if (!object(value)) throw new Error(`Invalid history record: ${key}[${index}]`);
      const texts = fields.flatMap((field) => {
        const text = value[field];
        if (text === undefined) return [];
        if (typeof text !== 'string') throw new Error(`Invalid history text: ${key}[${index}].${field}`);
        return [{ field, text }];
      });
      const dimension = value.dimension ?? value.dim;
      if (dimension !== undefined && (typeof dimension !== 'string' || !dimensions.has(dimension))) {
        isolate(`${key}[${index}]`, 'unverified_dimension', value); return [];
      }
      if (value.worldId !== undefined && value.worldId !== options.worldId) return [value];
      const timestamp = value.ts ?? value.at;
      if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp))) throw new Error(`Invalid history timestamp: ${key}[${index}]`);
      const inference = options.kind === 'world' ? key === 'notes' ? value.kind !== 'fact' : key === 'lessons' && value.source !== 'observed' : key !== 'history';
      return [{ ...value, ...Object.fromEntries(texts.map(({ field, text }) => [field, project(text, dimension, inference ? 0 : timestamp ?? 0)])) }];
    });
  });
  return { data, changed, quarantine, locations };
}
