import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';

type KnowledgeDocument = {
  id: string;
  title: string;
  kind: 'mechanic' | 'tutorial' | 'control';
  edition: 'java';
  versions: string[];
  aliases: string[];
  sources: { url: string; title: string; revision?: string }[];
  versionNote?: string;
  reviewedAt?: string;
  sections: { id: string; title: string; text: string }[];
};

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../../knowledge/minecraft-java-1.20.1/', import.meta.url));
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'with', 'how', 'why', 'what', 'does', 'do', 'is', 'are', 'can', 'i', 'minecraft', '为什', '什么', '怎么', '如何', '怎样', '哪些', '这个', '一个', '可以', '需要', '查询']);
const termsOf = (text: string) => [...new Set((normalize(text).match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [])
  .flatMap((word) => /^[a-z0-9]+$/.test(word) || word.length <= 2 ? [word] : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)))
  .filter((word) => !STOP_WORDS.has(word)))];

function indexDocuments(documents: KnowledgeDocument[]) {
  return documents.flatMap((document) => document.sections.map((section) => ({
    document, section,
    heading: normalize(`${document.id} ${document.title} ${section.id} ${section.title}`),
    aliases: document.aliases.map(normalize),
    body: normalize(section.text),
  })));
}

/** Local references only: no adapter, world memory, network client or skill registration. */
export class KnowledgeBase {
  private documents: KnowledgeDocument[];
  private index: ReturnType<typeof indexDocuments>;

  constructor(readonly version: string, directory = DEFAULT_DIRECTORY) {
    this.documents = fs.readdirSync(directory).filter((file) => file.endsWith('.md')).sort().map((file) => {
      const text = fs.readFileSync(path.join(directory, file), 'utf8');
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
      if (!match) throw new Error(`知识文档 ${file} 缺少元数据`);
      const metadata: Record<string, unknown> = Object.fromEntries(match[1].split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const colon = line.indexOf(':');
        if (colon < 1) throw new Error(`知识文档 ${file} 的元数据须为 key: JSON值`);
        return [line.slice(0, colon).trim(), JSON.parse(line.slice(colon + 1)) as unknown];
      }));
      const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
      if (typeof metadata.id !== 'string' || !/^[a-z][a-z0-9-]{1,80}$/.test(metadata.id) || metadata.id === 'agent-controls'
        || typeof metadata.title !== 'string' || !metadata.title.trim()
        || !['mechanic', 'tutorial'].includes(String(metadata.kind)) || metadata.edition !== 'java'
        || !strings(metadata.versions) || !metadata.versions.length || !strings(metadata.aliases)
        || !Array.isArray(metadata.sources) || !metadata.sources.length
        || metadata.versionNote !== undefined && typeof metadata.versionNote !== 'string'
        || metadata.reviewedAt !== undefined && typeof metadata.reviewedAt !== 'string') throw new Error(`知识文档 ${file} 的元数据无效`);
      const sources = metadata.sources.map((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`知识文档 ${file} 的来源无效`);
        const source = raw as Record<string, unknown>;
        if (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url) || typeof source.title !== 'string' || !source.title.trim()
          || source.revision !== undefined && typeof source.revision !== 'string') throw new Error(`知识文档 ${file} 的来源无效`);
        return { url: source.url, title: source.title, ...(typeof source.revision === 'string' ? { revision: source.revision } : {}) };
      });
      const headings = [...match[2].matchAll(/^## ([a-z0-9-]+) \| (.+)\r?$/gm)];
      const sections = headings.map((heading, i) => ({ id: heading[1], title: heading[2].trim(),
        text: match[2].slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? match[2].length).trim() }));
      if (!sections.length || sections.some((section) => !section.text || section.text.length > 4200) || new Set(sections.map((section) => section.id)).size !== sections.length)
        throw new Error(`知识文档 ${file} 需要非空、最多 4200 字符且 ID 唯一的章节：## section-id | 标题`);
      return { id: metadata.id, title: metadata.title, kind: metadata.kind as 'mechanic' | 'tutorial', edition: 'java' as const,
        versions: metadata.versions, aliases: metadata.aliases, sources, sections,
        ...(typeof metadata.versionNote === 'string' ? { versionNote: metadata.versionNote } : {}),
        ...(typeof metadata.reviewedAt === 'string' ? { reviewedAt: metadata.reviewedAt } : {}) };
    });
    if (new Set(this.documents.map((document) => document.id)).size !== this.documents.length) throw new Error('知识库文档 ID 重复');
    this.index = indexDocuments(this.documents);
  }

  query(raw: unknown) {
    const reference = { source: 'minecraft_knowledge' as const, edition: 'java' as const, version: this.version,
      evidence: 'reference_not_current_state' as const, readOnly: true,
      note: '资料不是现场观测或个人实战证据；教程为可选参考，查询不会执行动作或学会技能。' };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...reference, action: 'error' as const, error: 'INVALID_QUERY', message: '需要查询对象：{query} 搜索，{id,section?} 阅读，{} 浏览目录' };
    const input = raw as Record<string, unknown>;
    if (['query', 'id', 'section'].some((key) => input[key] !== undefined && (typeof input[key] !== 'string' || (input[key] as string).length > (key === 'query' ? 300 : 120)))
      || input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 12)
      || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0))
      return { ...reference, action: 'error' as const, error: 'INVALID_QUERY', message: 'query 最多 300 字符；id/section 最多 120 字符；limit 为 1–12，offset 为非负整数' };
    const query = ((input.query as string | undefined) ?? '').trim(), id = ((input.id as string | undefined) ?? '').trim();
    const sectionId = ((input.section as string | undefined) ?? '').trim();
    if (query && id || sectionId && !id) return { ...reference, action: 'error' as const, error: 'INVALID_QUERY', message: '搜索用 query；阅读用 id 和可选 section，二者分开查询' };

    const controls: KnowledgeDocument = { id: 'agent-controls', title: '身体操作手册', kind: 'control', edition: 'java', versions: [this.version],
      aliases: ['操作', '接口', '动作', '身体', '工具参数', 'controls', 'mineflayer', 'mineflyer'],
      sources: [{ url: 'repo:src/skills/index.ts', title: '当前注册技能接口' }],
      versionNote: '按当前注册接口生成，包含基础操作和已有复合动作；接口存在不代表 Agent 已学会对应策略。moves/mechanics 可继续查询参数，recipes 可查结构化配方。',
      sections: Object.values(SKILLS).filter((skill) => !LLM_HIDDEN.has(skill.name)).map((skill) => ({ id: skill.name, title: skill.name,
        text: `${skill.description}\n参数：${skill.argsDoc}\n移动型：${skill.movement ? '是' : '否'}；只读：${skill.readOnly === true ? '是' : '否'}；时限：${skill.timeoutMs} 毫秒。` })) };
    const documents = [...this.documents.filter((document) => document.versions.includes(this.version)), controls];
    const availableVersions = [...new Set(this.documents.flatMap((document) => document.versions))].sort();
    const coverage = { availableVersions, corpus: 'local_curated_sections', complete: false };
    const offset = Number(input.offset ?? 0);

    if (id) {
      const document = documents.find((candidate) => candidate.id === id);
      if (!document) return { ...reference, ...coverage, action: 'error' as const, error: 'NOT_FOUND', message: `当前版本知识库没有文档 ${id}；可先搜索或浏览目录` };
      const selected = sectionId ? document.sections.filter((section) => section.id === sectionId) : document.sections.slice(offset);
      if (!selected.length) return { ...reference, action: 'error' as const, error: 'SECTION_NOT_FOUND', message: `没有章节 ${sectionId || offset}；先读取文档目录或搜索章节` };
      let remaining = 4200;
      const sections = selected.flatMap((section) => {
        if (!remaining) return [];
        const text = section.text.slice(0, remaining);
        remaining -= text.length;
        return [{ id: section.id, title: section.title, text, truncated: text.length < section.text.length }];
      });
      const { sections: all, ...metadata } = document;
      return { ...reference, ...coverage, action: 'read' as const, document: { ...metadata, sections,
        contents: all.slice(0, 24).map(({ id, title }) => ({ id, title })), totalSections: all.length,
        ...(selected.length > sections.length ? { nextSection: selected[sections.length].id } : {}) } };
    }
    if (!query) {
      const limit = Number(input.limit ?? 12);
      return { ...reference, ...coverage, action: 'catalog' as const, documents: documents.slice(offset, offset + limit).map(({ sections, aliases, ...metadata }) => ({ ...metadata,
        sections: sections.slice(0, 12).map(({ id, title }) => ({ id, title })), totalSections: sections.length })),
        totalDocuments: documents.length, ...(offset + limit < documents.length ? { nextOffset: offset + limit } : {}) };
    }

    const normalized = normalize(query), terms = termsOf(query), limit = Math.min(5, Number(input.limit ?? 4));
    const index = [...this.index.filter((entry) => entry.document.versions.includes(this.version)), ...indexDocuments([controls])];
    const candidates = index.map((entry) => {
      const matches = terms.filter((term) => entry.heading.includes(term) || entry.body.includes(term) || entry.aliases.some((alias) => alias.includes(term)));
      const score = matches.reduce((total, term) => total + (entry.heading.includes(term) ? 6 : 0) + (entry.body.includes(term) ? 2 : 0)
        + (entry.aliases.some((alias) => alias === term) ? 4 : 0), 0)
        + (entry.heading.includes(normalized) ? 12 : 0) + (entry.body.includes(normalized) ? 5 : 0)
        + (entry.aliases.includes(normalized) ? 12 : 0);
      return { ...entry, score: matches.length ? score * (matches.length / Math.max(1, terms.length)) : 0 };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id) || a.section.id.localeCompare(b.section.id));
    return { ...reference, ...coverage, action: 'search' as const, query, totalMatches: candidates.length, hasMore: candidates.length > limit,
      matches: candidates.slice(0, limit).map(({ document, section }) => {
        const blocks = section.text.split(/\n\s*\n/);
        const relevant = blocks.map((text) => ({ text, score: terms.filter((term) => normalize(text).includes(term)).length })).sort((a, b) => b.score - a.score)[0];
        const excerpt = section.text.length <= 700 ? section.text : (relevant?.text ?? section.text).slice(0, 700);
        return { id: document.id, title: document.title, kind: document.kind, section: section.id, sectionTitle: section.title, excerpt,
          truncated: excerpt !== section.text, versions: document.versions, sources: document.sources,
          ...(document.versionNote ? { versionNote: document.versionNote } : {}), ...(document.reviewedAt ? { reviewedAt: document.reviewedAt } : {}) };
      }) };
  }
}
