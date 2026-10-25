import fs from 'node:fs';
import path from 'node:path';
import type { WorldMemory } from '../memory/store.ts';
import { shortId } from '../util.ts';
import { normalizeSpec, type BuildingSpec } from './spec.ts';

/**
 * 建筑师画好的图纸：玩的那个模型只要记住 draft ID，攒够材料后 build {"draft":"dr_…"} 就能照图施工，
 * 不必把整张字符画抄进每次决定里。
 */
export interface DesignDraft {
  id: string;
  name: string;
  purpose: string;
  brief: string;
  style?: string;
  spec: BuildingSpec;
  materials: Record<string, number>;
  size: { width: number; depth: number; height: number };
  notes: string[];
  createdAt: number;
  usedBy?: string;
  /** 建筑师按地形挑的施工位置（origin，旋转 0） */
  site?: { x: number; y: number; z: number };
  siteWhy?: string;
}

export class DraftStore {
  private drafts: DesignDraft[] = [];
  private file: string | null;
  constructor(directory: string | null) {
    this.file = directory ? path.join(directory, 'design-drafts.json') : null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(data?.drafts)) this.drafts = data.drafts.filter((d: any) => d?.id && d?.spec);
      } catch { /* 图纸文件坏了就当没有：不影响游玩 */ }
    }
  }
  private save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, drafts: this.drafts }, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch { /* 写不了就只留在内存里 */ }
  }
  add(input: Omit<DesignDraft, 'id' | 'createdAt'>): DesignDraft {
    const draft: DesignDraft = { ...input, id: shortId('dr_'), createdAt: Date.now() };
    this.drafts.push(draft);
    if (this.drafts.length > 30) this.drafts = this.drafts.slice(-30);
    this.save();
    return structuredClone(draft);
  }
  get(id: string): DesignDraft | undefined { const d = this.drafts.find((x) => x.id === id); return d ? structuredClone({ ...d, spec: normalizeSpec(structuredClone(d.spec)) }) : undefined; }
  markUsed(id: string, projectId: string) { const d = this.drafts.find((x) => x.id === id); if (d) { d.usedBy = projectId; this.save(); } }
  list(n = 6): DesignDraft[] { return structuredClone(this.drafts.slice(-n)); }
}

const stores = new WeakMap<WorldMemory, DraftStore>();
let active: DraftStore | null = null;
/** 当前世界记忆对应的图纸库（同时设为 build 技能校验参数时查找图纸的那一个） */
export function draftsFor(memory: WorldMemory): DraftStore {
  let store = stores.get(memory);
  if (!store) { store = new DraftStore(memory.dataDirectory); stores.set(memory, store); }
  active = store;
  return store;
}
export function activeDrafts(): DraftStore | null { return active; }
