import fs from 'node:fs';
import path from 'node:path';

/**
 * 控制台里的 .env 配置编辑。
 *
 * - 「有哪些配置、什么意思、默认值」以 .env.example 为准：按 `# ===== 标题 =====` 分组，紧挨着的注释就是说明，
 *   注释掉的 `# KEY=` 行算可选项。
 * - 写回时尽量保持 .env 原样：已有的行原地替换，注释掉的同名行原地启用，都没有才追加到末尾。
 * - 密钥类（API_KEY / SECRET / PASSWORD / COOKIE / TOKEN …）永远不回传给浏览器，只告诉它「设没设」。
 * - 改动只在重启 Curio 后生效（config.ts 启动时读一次）。
 */

export interface EnvItem {
  key: string;
  section: string;
  desc: string;
  /** .env.example 里的示例值 */
  example: string | null;
  /** 在 .env.example 里是注释掉的（可选项） */
  optional: boolean;
  secret: boolean;
}

export interface EnvSection {
  title: string;
  items: EnvItem[];
}

const SECRET = /(API_KEY|SECRET|PASSWORD|COOKIE|TOKEN|ACCESS_KEY|SESSDATA)/i;
export const isSecretKey = (k: string) => SECRET.test(k);

const KEY_LINE = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)\s*=(.*)$/;
const HEADER = /^\s*#\s*(?:={3,}|-{2,})\s*(.+?)\s*(?:={3,}|-{2,})?\s*$/;

/** 去掉未加引号的行内注释，去掉引号 */
function cleanValue(raw: string): { value: string; inline: string } {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return { value: v.slice(1, -1), inline: '' };
  }
  let inline = '';
  if (v.startsWith('#')) return { value: '', inline: v.replace(/^#\s?/, '').trim() };
  const m = v.match(/^(.*?)\s+#\s?(.*)$/);
  if (m) {
    v = m[1].trim();
    inline = m[2].trim();
  }
  return { value: v, inline };
}

export function parseSchema(text: string): EnvSection[] {
  const sections: EnvSection[] = [];
  let cur: EnvSection = { title: '通用', items: [] };
  sections.push(cur);
  const seen = new Set<string>();
  let desc: string[] = [];
  let lastWasKey = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      desc = [];
      lastWasKey = false;
      continue;
    }
    const k = line.match(KEY_LINE);
    if (k) {
      const key = k[2];
      const { value, inline } = cleanValue(k[3]);
      if (!seen.has(key)) {
        seen.add(key);
        cur.items.push({ key, section: cur.title, desc: [...desc, inline].filter(Boolean).join(' '), example: value || null, optional: !!k[1], secret: isSecretKey(key) });
      }
      desc = []; // 一段注释只算作紧跟着的第一项的说明，后面同组的项不再重复
      lastWasKey = true;
      continue;
    }
    const h = line.match(HEADER);
    if (h && /^\s*#\s*(={3,}|-{2,})/.test(line)) {
      cur = { title: h[1].replace(/[：:]\s*$/, ''), items: [] };
      sections.push(cur);
      desc = [];
      lastWasKey = false;
      continue;
    }
    if (/^\s*#/.test(line)) {
      desc.push(line.replace(/^\s*#\s?/, '').trim());
      lastWasKey = false;
    }
  }
  return sections.filter((s) => s.items.length);
}

/** 读 .env 里生效的键值（注释掉的不算） */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const k = line.match(KEY_LINE);
    if (!k || k[1]) continue;
    out.set(k[2], cleanValue(k[3]).value);
  }
  return out;
}

function formatValue(v: string): string {
  if (v === '') return '';
  if (/^\s|\s$|\s#|^#|^["']/.test(v)) return v.includes('"') ? `'${v}'` : `"${v}"`;
  return v;
}

export type EnvUpdates = Record<string, string | null>;

/**
 * 校验浏览器发来的修改：只允许改 .env.example 里有的键、或者 .env 里本来就有的键；
 * 值必须是单行字符串（null = 注释掉这一项，回到默认值）。
 */
export function validateUpdates(body: unknown, allowed: Set<string>): { ok: true; updates: EnvUpdates } | { ok: false; error: string } {
  const set = (body as any)?.set;
  if (!set || typeof set !== 'object' || Array.isArray(set)) return { ok: false, error: 'body.set 必须是对象' };
  const updates: EnvUpdates = {};
  const entries = Object.entries(set);
  if (!entries.length) return { ok: false, error: '没有要修改的项' };
  if (entries.length > 100) return { ok: false, error: '一次改太多了' };
  for (const [key, v] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) return { ok: false, error: `键名不合法：${key}` };
    if (!allowed.has(key)) return { ok: false, error: `未知配置项：${key}（先写进 .env.example）` };
    if (v === null) { updates[key] = null; continue; }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return { ok: false, error: `${key} 的值必须是字符串` };
    const s = String(v);
    if (/[\r\n\0]/.test(s)) return { ok: false, error: `${key} 的值不能换行` };
    if (s.length > 4000) return { ok: false, error: `${key} 的值太长` };
    if (s.includes('"') && s.includes("'") && formatValue(s) !== s) return { ok: false, error: `${key} 的值不能同时含单双引号和空白` };
    updates[key] = s;
  }
  return { ok: true, updates };
}

/** 把修改写进 .env 文本，尽量不动其他行 */
export function applyUpdates(text: string, updates: EnvUpdates): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const appended: string[] = [];
  for (const [key, v] of Object.entries(updates)) {
    const active = lines.findIndex((l) => { const m = l.match(KEY_LINE); return !!m && !m[1] && m[2] === key; });
    if (v === null) {
      if (active >= 0) lines[active] = '# ' + lines[active].replace(/^\s+/, '');
      continue;
    }
    const line = `${key}=${formatValue(v)}`;
    if (active >= 0) { lines[active] = line; continue; }
    const commented = lines.findIndex((l) => { const m = l.match(KEY_LINE); return !!m && !!m[1] && m[2] === key; });
    if (commented >= 0) { lines[commented] = line; continue; }
    appended.push(line);
  }
  if (appended.length) {
    if (!lines.some((l) => l.includes('控制台添加的配置'))) lines.push('', '# ---- 控制台添加的配置 ----');
    lines.push(...appended);
  }
  return lines.join(eol) + eol;
}

export interface EnvStoreOptions {
  file?: string;
  example?: string;
  backupDir?: string;
}

/** 控制台用的读写封装 */
export function envStore(opts: EnvStoreOptions = {}) {
  const file = path.resolve(opts.file ?? '.env');
  const example = path.resolve(opts.example ?? '.env.example');
  const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const startedWith = parseEnv(read(file));
  const mode = path.basename(file) === '.env.live' || startedWith.get('CURIO_MODE')?.trim() === 'live' ? 'live' : 'local';
  const backupDir = path.resolve(opts.backupDir ?? path.join(startedWith.get('DATA_DIR')?.trim() || path.join('data', mode), 'env-backups'));

  function schema() {
    return parseSchema(read(example));
  }

  function allowedKeys() {
    const keys = new Set<string>();
    for (const s of schema()) for (const i of s.items) keys.add(i.key);
    for (const k of parseEnv(read(file)).keys()) keys.add(k);
    return keys;
  }

  /** 给浏览器的视图：密钥只给「设没设」 */
  function view() {
    const env = parseEnv(read(file));
    const known = new Set<string>();
    const show = (key: string) => {
      const secret = isSecretKey(key);
      const has = env.has(key);
      const value = env.get(key) ?? null;
      const changed = (startedWith.get(key) ?? null) !== value;
      return { set: has && value !== '', value: secret ? null : value, changed };
    };
    const sections = schema().map((s) => ({
      title: s.title,
      items: s.items.map((i) => { known.add(i.key); return { ...i, example: i.secret ? null : i.example, ...show(i.key) }; }),
    }));
    const extra = [...env.keys()].filter((k) => !known.has(k)).map((key) => ({ key, section: '其他', desc: '', example: null, optional: true, secret: isSecretKey(key), ...show(key) }));
    if (extra.length) sections.push({ title: '其他（.env 里有、.env.example 里没写）', items: extra });
    return { file: path.basename(file), exists: fs.existsSync(file), restartNeeded: sections.some((s) => s.items.some((i) => i.changed)), sections };
  }

  function update(body: unknown) {
    const v = validateUpdates(body, allowedKeys());
    if (!v.ok) return v;
    const before = read(file);
    if (before) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, `.env.${new Date().toISOString().replace(/[:.]/g, '-')}`), before);
    }
    const after = applyUpdates(before, v.updates);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, after);
    fs.renameSync(tmp, file);
    return { ok: true as const, changed: Object.keys(v.updates) };
  }

  return { view, update, schema };
}
