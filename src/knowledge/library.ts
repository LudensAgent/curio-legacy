import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_HIDDEN, SKILLS } from '../skills/index.ts';
import { isSkillDisabled } from '../skills/disabled.ts';

/** 搜索命中：文档 + 最相关章节（没有章节命中时只给文档摘要）。 */
export type KnowledgeMatch = { id: string; title: string; kind: 'mechanic' | 'tutorial' | 'control'; section?: string; sectionTitle?: string; excerpt: string };

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
    heading: normalize(`${section.id} ${section.title}`),
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
      if (!sections.length || sections.some((section) => !section.text) || new Set(sections.map((section) => section.id)).size !== sections.length)
        throw new Error(`知识文档 ${file} 需要非空且 ID 唯一的章节：## section-id | 标题`);
      return { id: metadata.id, title: metadata.title, kind: metadata.kind as 'mechanic' | 'tutorial', edition: 'java' as const,
        versions: metadata.versions, aliases: metadata.aliases, sources, sections,
        ...(typeof metadata.versionNote === 'string' ? { versionNote: metadata.versionNote } : {}),
        ...(typeof metadata.reviewedAt === 'string' ? { reviewedAt: metadata.reviewedAt } : {}) };
    });
    if (new Set(this.documents.map((document) => document.id)).size !== this.documents.length) throw new Error('知识库文档 ID 重复');
    this.index = indexDocuments(this.documents);
  }

  query(raw: unknown, maxBytes = 6000) {
    const reference = { source: 'minecraft_knowledge' as const, edition: 'java' as const, version: this.version,
      evidence: 'reference_not_current_state' as const, readOnly: true };
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const failure = (error: string, message: string) => ({ ...reference, action: 'error' as const, error, message });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('INVALID_QUERY', '用 {query} 搜索，{id,section?} 阅读，{} 浏览目录');
    const input = raw as Record<string, unknown>;
    if (['query', 'id', 'section'].some((key) => input[key] !== undefined && (typeof input[key] !== 'string' || (input[key] as string).length > (key === 'query' ? 300 : 120)))
      || input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 12)
      || ['offset', 'cursor'].some((key) => input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0)))
      return failure('INVALID_QUERY', 'query 最多300字符；id/section 最多120字符；limit为1–12，offset/cursor为非负整数');
    const query = ((input.query as string | undefined) ?? '').trim(), id = ((input.id as string | undefined) ?? '').trim();
    const sectionId = ((input.section as string | undefined) ?? '').trim();
    if (query && id || sectionId && !id || input.cursor !== undefined && !sectionId)
      return failure('INVALID_QUERY', '搜索用query；目录用id；正文用id和section，cursor用于续读正文');

    const controls: KnowledgeDocument = { id: 'agent-controls', title: '身体操作手册', kind: 'control', edition: 'java', versions: [this.version],
      aliases: ['操作', '接口', '动作', '身体', '工具参数', 'controls', 'mineflayer', 'mineflyer'],
      sources: [
        { url: 'repo:src/skills/index.ts', title: '当前注册技能接口' },
        { url: 'repo:src/spatial/retention.ts', title: '宿主空间记忆保留策略' },
      ],
      versionNote: '按当前注册接口生成，包含基础操作和已有复合动作；接口存在不代表 Agent 已学会对应策略。moves/mechanics 可继续查询参数，recipes 可查结构化配方。',
      sections: [...Object.values(SKILLS).filter((skill) => !LLM_HIDDEN.has(skill.name) && !isSkillDisabled(skill.name)).map((skill) => ({ id: skill.name, title: skill.name,
        text: `${skill.description}\n参数：${skill.argsDoc}\n移动型：${skill.movement ? '是' : '否'}；只读：${skill.readOnly === true ? '是' : '否'}；时限：${skill.timeoutMs} 毫秒。` })),
        { id: 'spatial-memory-retention', title: '空间记忆的保留与遗忘',
          text: '空间库只保留有限数量的已观测 Section。保存达到容量水位后，宿主会遗忘一部分最旧、且不在基地/资源点/容器/传送门/自建方块/热点区域/当前路线附近的已提交 Section。被遗忘的区域回到“未记录”（UNKNOWN）：不代表空气，不代表可通行，也不代表不可通行；再次经过时会重新观察。事实、容器账本、地标和经历不会被删除；这些地点的已观测格子若被遗忘，通往它们的旧路线也不再保留。遗忘由宿主按资源预算执行，不是游戏机制，也不改变你已选择的目标。' },
      ] };
    const documents = [...this.documents.filter((document) => document.versions.includes(this.version)), controls];
    const offset = Number(input.offset ?? 0);
    const budget = Math.min(maxBytes, id && sectionId ? 6000 : 2400);

    if (id) {
      const document = documents.find((candidate) => candidate.id === id);
      if (!document) return failure('NOT_FOUND', '当前版本没有这篇资料；可搜索或浏览目录');
      const metadata = { id: document.id, title: document.title, kind: document.kind, versions: document.versions };
      if (!sectionId) {
        const result = { ...reference, action: 'read' as const, document: { ...metadata, sources: [], sections: [],
          contents: document.sections.slice(offset, offset + Number(input.limit ?? 12)).map(({ id, title }) => ({ id, title })),
          totalSections: document.sections.length, nextOffset: undefined as number | undefined } };
        while (result.document.contents.length && bytes(result) > budget) result.document.contents.pop();
        if (offset < document.sections.length && !result.document.contents.length) return failure('BUDGET_TOO_SMALL', '剩余额度不足以返回章节目录');
        if (offset + result.document.contents.length < document.sections.length) result.document.nextOffset = offset + result.document.contents.length;
        // Include the pagination marker in the same budget as the entries.
        while (result.document.contents.length && bytes(result) > budget) {
          result.document.contents.pop(); result.document.nextOffset = offset + result.document.contents.length;
        }
        return bytes(result) <= budget && (offset >= document.sections.length || result.document.contents.length) ? result : failure('BUDGET_TOO_SMALL', '剩余额度不足以返回章节目录');
      }
      const section = document.sections.find((candidate) => candidate.id === sectionId);
      if (!section) return failure('SECTION_NOT_FOUND', '没有这个章节；先读取文档目录');
      const cursor = Number(input.cursor ?? 0);
      if (cursor >= section.text.length) return failure('INVALID_CURSOR', '游标超出正文范围');
      const cited = document.sources.filter((source) => section.text.includes(source.url));
      const sources = [...new Map((cited.length ? cited : document.sources).map((source) => [source.url, source])).values()];
      const result = { ...reference, action: 'read' as const, document: { ...metadata, sources,
        ...(document.versionNote ? { versionNote: document.versionNote } : {}),
        sections: [{ id: section.id, title: section.title, text: '', truncated: true }], nextCursor: section.text.length as number | undefined } };
      if (bytes(result) >= budget) return failure('BUDGET_TOO_SMALL', '剩余额度不足以保留来源和版本条件；请在下一次思考继续阅读');
      let low = 0, high = section.text.length - cursor;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        result.document.sections[0].text = section.text.slice(cursor, cursor + middle);
        result.document.sections[0].truncated = cursor + middle < section.text.length;
        result.document.nextCursor = cursor + middle < section.text.length ? cursor + middle : undefined;
        if (bytes(result) <= budget) low = middle; else high = middle - 1;
      }
      if (!low) return failure('BUDGET_TOO_SMALL', '剩余额度不足以返回正文；请在下一次思考继续阅读');
      result.document.sections[0].text = section.text.slice(cursor, cursor + low);
      result.document.sections[0].truncated = cursor + low < section.text.length;
      result.document.nextCursor = cursor + low < section.text.length ? cursor + low : undefined;
      return result;
    }
    if (!query) {
      const limit = Number(input.limit ?? 12);
      const result = { ...reference, action: 'catalog' as const, documents: documents.slice(offset, offset + limit).map(({ id, title, kind }) => ({ id, title, kind })),
        totalDocuments: documents.length, nextOffset: undefined as number | undefined };
      if (offset + result.documents.length < documents.length) result.nextOffset = offset + result.documents.length;
      while (result.documents.length && bytes(result) > budget) { result.documents.pop(); result.nextOffset = offset + result.documents.length; }
      return bytes(result) <= budget && (offset >= documents.length || result.documents.length) ? result : failure('BUDGET_TOO_SMALL', '剩余额度不足以返回目录');
    }

    const normalized = normalize(query), terms = termsOf(query), limit = Math.min(3, Number(input.limit ?? 2));
    const groups = new Map<KnowledgeDocument, typeof this.index>();
    this.index.filter((entry) => entry.document.versions.includes(this.version)).forEach((entry) => {
      const entries = groups.get(entry.document) ?? [];
      entries.push(entry); groups.set(entry.document, entries);
    });
    const candidates = [...groups].flatMap(([document, entries]) => {
      const exact = [document.id, document.title, ...document.aliases].some((name) => normalize(name) === normalized);
      // 别名只负责“找到这篇文档”，不参与挑章节：英文机制词通常只在别名里，
      // 用它选章节会让所有章节同分、按 id 排出一个不相干的章节。
      const coverage = (count: number) => count / Math.max(1, terms.length);
      const aliasText = normalize(document.aliases.join(' '));
      const aliasHit = coverage(terms.filter((term) => aliasText.includes(term)).length) >= 0.3;
      const chapters = entries.map((entry) => {
        const matches = terms.filter((term) => entry.heading.includes(term) || entry.body.includes(term));
        const score = matches.reduce((total, term) => total + (entry.heading.includes(term) ? 8 : 0) + (entry.body.includes(term) ? 2 : 0), 0) * coverage(matches.length);
        return { ...entry, score: coverage(matches.length) >= 0.3 ? score : 0 };
      }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.section.id.localeCompare(b.section.id));
      if (!chapters.length && !exact && !aliasHit) return [];
      // 有章节命中时取最高分章节（同分按章节 id 稳定取舍）；只有别名命中时给文档摘要，
      // 由阅读目录再选章节，不把“文档命中”冒充成“这一章最相关”。
      const chapter = normalized.length > 1 && chapters[0] ? chapters[0].section : undefined;
      const excerpt = chapter ? chapter.text.split(/\n\s*\n/)[0].slice(0, 120) : document.sections.map((section) => section.title).slice(0, 3).join('；').slice(0, 120);
      return [{ score: (chapters[0]?.score ?? 0) + (exact ? 16 : 0) + (aliasHit && !chapters.length ? 4 : 0) + (normalize(document.title).includes(normalized) ? 6 : 0), id: document.id, title: document.title, kind: document.kind,
        ...(chapter ? { section: chapter.id, sectionTitle: chapter.title } : {}), excerpt } satisfies KnowledgeMatch & { score: number }];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const relevant = candidates.filter((candidate) => candidate.score >= (candidates[0]?.score ?? 0) * 0.5);
    const result = { ...reference, action: 'search' as const, query, totalMatches: relevant.length, hasMore: relevant.length > limit,
      matches: relevant.slice(0, limit).map(({ score, ...match }) => match) };
    while (result.matches.length && bytes(result) > budget) { result.matches.pop(); result.hasMore = true; }
    return bytes(result) <= budget && (!relevant.length || result.matches.length) ? result : failure('BUDGET_TOO_SMALL', '剩余额度不足以返回搜索候选');
  }
}
