import fs from 'node:fs';
import path from 'node:path';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';

/** Buttons and queries, rather than a list of activities the player ought to do. */
export const BASIC_CONTROLS = [
  'look_around', 'goto', 'inspect_block', 'use_item', 'interact_block', 'interact', 'hit_entity',
  'dig', 'pickup_items', 'craft', 'equip', 'eat', 'ride', 'dismount', 'climb_up', 'assess_landings', 'descend', 'wait',
  'query_resource', 'method_catalog', 'experiment_method', 'record_ability_gap',
] as const;

/** Routine choices need buttons and the interfaces in use, not the entire method authoring DSL. */
export const ROUTINE_CONTROLS = BASIC_CONTROLS.filter((name) => !['method_catalog', 'experiment_method', 'record_ability_gap'].includes(name));

export function controlCatalog(disclosed: string[] = [], descriptionChars = 120, base: readonly string[] = BASIC_CONTROLS): string {
  const names = [...new Set([...base, ...disclosed])];
  return names.flatMap((name) => {
    const skill = SKILLS[name];
    if (!skill || LLM_HIDDEN.has(name)) return [];
    return [`- ${skill.name} ${skill.argsDoc}${descriptionChars ? `：${skill.description.slice(0, descriptionChars)}` : ''}`];
  }).join('\n');
}

/** Knowing an interface is not evidence that its effect has been learned. */
export class ControlKnowledge {
  private worlds = new Map<string, string[]>();
  constructor(private file: string | null) {
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version === 1 && Array.isArray(saved.worlds)) for (const entry of saved.worlds.slice(-8)) {
        if (typeof entry.worldId !== 'string' || !Array.isArray(entry.names)) continue;
        this.worlds.set(entry.worldId, entry.names.filter((n: unknown) => typeof n === 'string').slice(-100));
      }
    } catch { /* Invalid interface history grants no capability or effect evidence. */ }
  }
  names(worldId: string): string[] {
    return (this.worlds.get(worldId) ?? []).filter((n) => !!SKILLS[n] && !LLM_HIDDEN.has(n));
  }
  expose(worldId: string, names: string[]): void {
    if (!worldId) return;
    const previous = this.names(worldId);
    const next = [...new Set([...previous, ...names.filter((n) => !!SKILLS[n] && !LLM_HIDDEN.has(n))])].slice(-100);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.worlds.delete(worldId); this.worlds.set(worldId, next);
    while (this.worlds.size > 8) this.worlds.delete(this.worlds.keys().next().value!);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, worlds: [...this.worlds].map(([worldId, names]) => ({ worldId, names })) }));
      fs.renameSync(this.file + '.tmp', this.file);
    }
  }
}
