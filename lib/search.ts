/**
 * アイデア検索（issue #38）: **技術 × 分野** で発明を探するための純関数群。
 *
 * 方針:
 * - 検索はブラウザ側だけで完結する（GitHub Pages = 静的ホスティング。
 *   **検索のたびに Workers AI を呼ばない・DBも検索サーバも新設しない**）。
 * - 検索対象は `data/offspring.json` から作る**軽いインデックス**
 *   （発明ID・タイトル・概要・詳細・技術・分野・キーワードなど必要な情報だけ）。
 *   メタデータ（`technologies` / `domains` / `keywords`）が無い既存データは、
 *   タイトル・概要・仕組み・利用シーンのテキストから検索できる。
 * - キーワードは空白区切りで **AND**。日英・英数の大文字小文字と全角半角を吸収する。
 * - 表記揺れは `config/search-taxonomy.json`（`domainAliases` / `technologyAliases`）で吸収。
 *   **技術名の同義語は慎重に**: 異なる技術を同一視しない（あり得ない対応は置かない）。
 * - 並び順は 技術タグ → 分野タグ → 発明名 → 概要 → キーワード → 詳細 の一致を優先。
 *   どの項目に一致したかは `SearchHit.fields` / `SearchHit.terms` で判別できる。
 *
 * このモジュールは純関数のみ（Node依存なし）。フロント・スクリプト・テストで共有する。
 */
import type { Offspring } from './types.ts';

// --- 分類（config/search-taxonomy.json） -------------------------------------

export interface SearchTaxonomy {
  schemaVersion: 1;
  /** 分野の固定候補（表示名そのまま。順序 = 表示順）。 */
  domains: string[];
  /** 技術の固定候補（表示名そのまま。実データに合わせて拡張できる）。 */
  technologies: string[];
  /** 分野の表記揺れ → 正規カテゴリ（キーは normalizeText 済みでよいが生のキーも受け付ける）。 */
  domainAliases: Record<string, string[]>;
  /** 技術の表記揺れ → 正規技術名。異なる技術を同一視する組み合わせは置かないこと。 */
  technologyAliases: Record<string, string[]>;
  /**
   * 既存データ向けの**ルール補完**（scripts/backfill-search-metadata.ts）が使う語。
   * テキストに明確に現れたときだけ分野を付与する（推測での乱付けを避ける）。
   */
  domainMatchTerms: Record<string, string[]>;
}

/** テキストの正規化（NFKC → 小文字 → 空白畳み込み）。検索・照合はすべてこれを通す。 */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 見出しとして使う上限（暴走・表示崩れの防止）。 */
const MAX_TERMS = 8;
export const MAX_QUERY_LENGTH = 100;
const MAX_TAG_LENGTH = 50;

/**
 * config/search-taxonomy.json の検証。
 * 不正なら読み込む側（scripts/process-breeding.ts / validate-data.ts）は exit 1。
 */
export type TaxonomyParseResult =
  | { ok: true; config: SearchTaxonomy }
  | { ok: false; reason: string };

function isStringArray(v: unknown, max: number): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= max &&
    v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= MAX_TAG_LENGTH)
  );
}

function isAliasMap(v: unknown): v is Record<string, string[]> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.length === 0 || k.length > MAX_TAG_LENGTH) return false;
    if (!isStringArray(val, 20)) return false;
  }
  return true;
}

export function parseSearchTaxonomy(x: unknown): TaxonomyParseResult {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    return { ok: false, reason: 'オブジェクトではありません' };
  }
  const o = x as Record<string, unknown>;
  if (o.schemaVersion !== 1) return { ok: false, reason: `未対応のschemaVersion: ${String(o.schemaVersion)}` };
  if (!isStringArray(o.domains, 50)) return { ok: false, reason: 'domains が不正です' };
  if (!isStringArray(o.technologies, 200)) return { ok: false, reason: 'technologies が不正です' };
  if (!isAliasMap(o.domainAliases)) return { ok: false, reason: 'domainAliases が不正です' };
  if (!isAliasMap(o.technologyAliases)) return { ok: false, reason: 'technologyAliases が不正です' };
  if (!isAliasMap(o.domainMatchTerms)) return { ok: false, reason: 'domainMatchTerms が不正です' };
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      domains: o.domains,
      technologies: o.technologies,
      domainAliases: o.domainAliases,
      technologyAliases: o.technologyAliases,
      domainMatchTerms: o.domainMatchTerms,
    },
  };
}

/** 既定の分類（= config/search-taxonomy.json と同内容。読み込み失敗時のフォールバック）。 */
export const DEFAULT_SEARCH_TAXONOMY: SearchTaxonomy = {
  schemaVersion: 1,
  domains: [
    '業務・ビジネス',
    '教育・学習',
    'アウトドア',
    '観光・地域',
    '医療・ヘルスケア',
    'エンターテインメント',
    '日常生活',
    'その他',
  ],
  technologies: ['Dify', 'LINE', 'Node-RED', 'IoT', '生成AI', 'Bluetooth', 'GPS'],
  domainAliases: {
    業務: ['業務・ビジネス'],
    仕事: ['業務・ビジネス'],
    ビジネス: ['業務・ビジネス'],
    業務効率化: ['業務・ビジネス'],
    職場: ['業務・ビジネス'],
    社内: ['業務・ビジネス'],
    教育: ['教育・学習'],
    学習: ['教育・学習'],
    授業: ['教育・学習'],
    研修: ['教育・学習'],
    学校: ['教育・学習'],
    教室: ['教育・学習'],
    アウトドア: ['アウトドア'],
    屋外: ['アウトドア'],
    登山: ['アウトドア'],
    キャンプ: ['アウトドア'],
    観光: ['観光・地域'],
    旅行: ['観光・地域'],
    地域: ['観光・地域'],
    街歩き: ['観光・地域'],
    医療: ['医療・ヘルスケア'],
    ヘルスケア: ['医療・ヘルスケア'],
    健康: ['医療・ヘルスケア'],
    看護: ['医療・ヘルスケア'],
    介護: ['医療・ヘルスケア'],
    エンタメ: ['エンターテインメント'],
    エンターテインメント: ['エンターテインメント'],
    娯楽: ['エンターテインメント'],
    遊び: ['エンターテインメント'],
    生活: ['日常生活'],
    日常: ['日常生活'],
    家事: ['日常生活'],
    暮らし: ['日常生活'],
  },
  technologyAliases: {
    ライン: ['LINE'],
    nodered: ['Node-RED'],
    'node red': ['Node-RED'],
    アイオーティー: ['IoT'],
    ディファイ: ['Dify'],
    ディフイ: ['Dify'],
    ジーエーピーエー: ['GPS'],
    'bluetooth low energy': ['Bluetooth'],
    ble: ['Bluetooth'],
    生成ai: ['生成AI'],
  },
  domainMatchTerms: {
    '業務・ビジネス': ['業務', '職場', '事務', 'ビジネス', '効率化', '社内'],
    '教育・学習': ['教育', '学習', '授業', '教室', '学校', '生徒', '学生', 'カリキュラム'],
    アウトドア: ['アウトドア', '屋外', '登山', 'キャンプ', '散歩', '公園'],
    '観光・地域': ['観光', '旅行', '地域', '街歩き', '名所', '歴史散歩'],
    '医療・ヘルスケア': ['医療', '健康管理', '介護', '看護', '診療', '症状'],
    エンターテインメント: ['エンタメ', '娯楽', 'ゲーム', '音楽', '物語'],
    日常生活: ['日常生活', '家事', '台所', '暮らし', '自宅', '生活'],
    その他: [],
  },
};

// --- インデックス -------------------------------------------------------------

/** 検索用インデックスの1件（発見に必要な情報だけ。本文全文は持たない）。 */
export interface SearchDoc {
  id: string;
  title: string;
  summary: string;
  /** concept + mechanism + 利用シーン（まとめて「詳細」として検索する）。 */
  detail: string;
  technologies: string[];
  domains: string[];
  keywords: string[];
  generation: number;
  mode: string;
  /** 並び替え用（新しい順）。 */
  createdAt: string;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    if (!s) continue;
    const key = normalizeText(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * `data/offspring.json` から検索インデックスを作る（**ビルド時に読み込むJSONから生成** =
 * ブラウザは追加のリクエストもAI呼び出しもしない）。
 * メタデータが無い既存データも、テキスト（タイトル・概要・詳細）だけで検索対象になる。
 */
export function buildSearchIndex(list: readonly Offspring[]): SearchDoc[] {
  return list.map((c) => ({
    id: c.id,
    title: c.title ?? '',
    summary: c.summary ?? '',
    detail: [c.concept ?? '', c.mechanism ?? '', ...(c.useCases ?? [])]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .join(' '),
    technologies: cleanTags(c.technologies),
    domains: cleanTags(c.domains),
    keywords: cleanTags(c.keywords),
    generation: typeof c.generation === 'number' ? c.generation : 0,
    mode: typeof c.mode === 'string' ? c.mode : '',
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
  }));
}

// --- クエリ -------------------------------------------------------------------

export interface SearchQuery {
  /** 自由入力キーワード（空白区切り = AND）。空文字列は「入力なし」。 */
  q: string;
  /** 技術で絞り込み（正規カテゴリ名。URLにはエンコードされて入る）。 */
  tech: string;
  /** 分野で絞り込み。 */
  domain: string;
}

export const EMPTY_QUERY: SearchQuery = { q: '', tech: '', domain: '' };

/** URLSearchParams（?q=…&tech=…&domain=…）→ 検索クエリ（長さ上限・空白整理）。 */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const cut = (v: string | null, max: number): string =>
    v === null ? '' : v.replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    q: cut(params.get('q'), MAX_QUERY_LENGTH),
    tech: cut(params.get('tech'), MAX_TAG_LENGTH),
    domain: cut(params.get('domain'), MAX_TAG_LENGTH),
  };
}

export function isEmptyQuery(q: SearchQuery): boolean {
  return q.q === '' && q.tech === '' && q.domain === '';
}

/** 検索クエリ → URLクエリ文字列（共有用。値は URLSearchParams がエンコードする）。 */
export function searchQueryString(q: SearchQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.tech) p.set('tech', q.tech);
  if (q.domain) p.set('domain', q.domain);
  return p.toString();
}

/** サイト内の検索付き一覧URL（個別ページのタグから飛ぶ先 / base はサイトルートへの基点）。 */
export function searchHref(base: string, q: SearchQuery): string {
  const qs = searchQueryString(q);
  return qs ? `${base}ideas/?${qs}` : `${base}ideas/`;
}

// --- 検索 ---------------------------------------------------------------------

export type MatchField = 'technology' | 'domain' | 'keyword' | 'title' | 'summary' | 'detail';

/** 一致した項目の表示名（UIで「どこに一致したか」を示す）。 */
export const MATCH_FIELD_LABELS: Record<MatchField, string> = {
  technology: '技術タグ',
  domain: '分野タグ',
  keyword: 'キーワード',
  title: '発明名',
  summary: '概要',
  detail: '詳細',
};

/** 一致スコア（大きいほど上。並び順はこの順 = 技術・分野タグを最優先）。 */
const FIELD_SCORE: Record<MatchField, number> = {
  technology: 100,
  domain: 90,
  title: 60,
  summary: 40,
  keyword: 30,
  detail: 20,
};

export interface SearchTermHit {
  /** 入力されたキーワード（正規化前）。 */
  term: string;
  /** その語が一致した項目。 */
  fields: MatchField[];
}

export interface SearchHit {
  doc: SearchDoc;
  score: number;
  /** すべての一致項目（重複なし・スコア順）。 */
  fields: MatchField[];
  /** キーワードごとの一致項目（「どの語がどこに当たったか」）。 */
  terms: SearchTermHit[];
}

/** 表記揺れの展開（入力語 + 同義語 → 候補文字列。すべて正規化済み）。 */
function expandTerm(term: string, aliasMaps: Record<string, string[]>[]): string[] {
  const n = normalizeText(term);
  const out = new Set<string>([n]);
  for (const map of aliasMaps) {
    for (const [key, targets] of Object.entries(map)) {
      if (normalizeText(key) !== n) continue;
      for (const t of targets) out.add(normalizeText(t));
    }
  }
  return [...out];
}

function hitFields(
  variants: string[],
  fields: { field: MatchField; text: string | string[] }[],
): MatchField[] {
  const out: MatchField[] = [];
  for (const { field, text } of fields) {
    const haystacks = Array.isArray(text) ? text.map(normalizeText) : [normalizeText(text)];
    if (haystacks.some((h) => variants.some((v) => v !== '' && h.includes(v)))) out.push(field);
  }
  return out;
}

/**
 * キーワード（AND）+ 技術・分野フィルタで絞り込む。
 * - フィルタはタグの**正規化一致**（表記揺れは taxonomy の同義語で解決）。
 * - キーワードは「その語のどこかの項目に一致」が必要（AND）。全語一致才算点。
 * - 並び: スコア降順 → 新しい順。
 */
export function searchIdeas(
  index: readonly SearchDoc[],
  query: SearchQuery,
  taxonomy: SearchTaxonomy = DEFAULT_SEARCH_TAXONOMY,
): SearchHit[] {
  const techVariants = query.tech ? expandTerm(query.tech, [taxonomy.technologyAliases]) : null;
  const domainVariants = query.domain ? expandTerm(query.domain, [taxonomy.domainAliases]) : null;
  const terms = query.q
    ? query.q
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .slice(0, MAX_TERMS)
        .map((t) => ({
          raw: t,
          variants: expandTerm(t, [taxonomy.technologyAliases, taxonomy.domainAliases]),
        }))
    : [];

  const hits: SearchHit[] = [];
  for (const doc of index) {
    // フィルタ（技術 × 分野はANDで掛け合わせる）
    const docTech = doc.technologies.map(normalizeText);
    const docDom = doc.domains.map(normalizeText);
    if (techVariants && !docTech.some((t) => techVariants.includes(t))) continue;
    if (domainVariants && !docDom.some((d) => domainVariants.includes(d))) continue;

    const perField: { field: MatchField; text: string | string[] }[] = [
      { field: 'technology', text: doc.technologies },
      { field: 'domain', text: doc.domains },
      { field: 'title', text: doc.title },
      { field: 'summary', text: doc.summary },
      { field: 'keyword', text: doc.keywords },
      { field: 'detail', text: doc.detail },
    ];

    let score = 0;
    const fieldSet = new Set<MatchField>();
    const termHits: SearchTermHit[] = [];
    let allMatched = true;
    for (const t of terms) {
      const fields = hitFields(t.variants, perField);
      if (fields.length === 0) {
        allMatched = false;
        break;
      }
      score += Math.max(...fields.map((f) => FIELD_SCORE[f]));
      for (const f of fields) fieldSet.add(f);
      termHits.push({ term: t.raw, fields });
    }
    if (!allMatched) continue;

    hits.push({
      doc,
      score,
      fields: [...fieldSet].sort((a, b) => FIELD_SCORE[b] - FIELD_SCORE[a]),
      terms: termHits,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.doc.createdAt !== b.doc.createdAt) return a.doc.createdAt < b.doc.createdAt ? 1 : -1;
    return a.doc.id < b.doc.id ? -1 : 1;
  });
  return hits;
}

// --- 絞り込み候補 --------------------------------------------------------------

export interface FacetOptions {
  technologies: string[];
  domains: string[];
}

/**
 * 絞り込みの選択肢。
 * - 固定候補（config/search-taxonomy.json）を**実データに存在するものだけ**先頭に並べる
 *   （存在しない条件を大量に出さない）。
 * - データにあって固定候補に無い値は後ろに追加（= データに応じて拡張できる）。
 * - 表示は元の表記（大文字小文字・全角はそのまま）。
 */
export function facetOptions(
  index: readonly SearchDoc[],
  taxonomy: SearchTaxonomy = DEFAULT_SEARCH_TAXONOMY,
): FacetOptions {
  const pick = (canonical: string[], present: string[]): string[] => {
    const presentNorm = new Map<string, string>(); // 正規化 → 元の表記
    for (const p of present) {
      const key = normalizeText(p);
      if (!presentNorm.has(key)) presentNorm.set(key, p);
    }
    const out: string[] = [];
    const used = new Set<string>();
    for (const c of canonical) {
      const key = normalizeText(c);
      const actual = presentNorm.get(key);
      if (actual !== undefined && !used.has(key)) {
        out.push(actual);
        used.add(key);
      }
    }
    for (const p of present) {
      const key = normalizeText(p);
      if (used.has(key)) continue;
      used.add(key);
      out.push(p);
    }
    return out;
  };

  return {
    technologies: pick(taxonomy.technologies, index.flatMap((d) => d.technologies)),
    domains: pick(taxonomy.domains, index.flatMap((d) => d.domains)),
  };
}

/**
 * ルールベースの分野判定（既存データ向けの補完 / scripts/backfill-search-metadata.ts）。
 * **明確に語が現れたときだけ**分類し、判断できない場合は空を返す（推測しない）。
 */
export function suggestDomains(
  text: string,
  taxonomy: SearchTaxonomy = DEFAULT_SEARCH_TAXONOMY,
): string[] {
  const n = normalizeText(text);
  const out: string[] = [];
  for (const domain of taxonomy.domains) {
    const terms = taxonomy.domainMatchTerms[domain] ?? [];
    if (terms.some((t) => t.length > 0 && n.includes(normalizeText(t)))) out.push(domain);
  }
  return out;
}

/**
 * ルールベースの技術抽出（既存データ向けの補完）。
 * タクソノミー上の技術名が**本文に明示されているときだけ**付ける
 * （ラテン文字は単語境界を確認し、部分一致での誤検出を避ける。
 *  「Difyを使わない発明にDifyタグを付けない」を守るため、技術名が書かれていなければ付けない）。
 */
export function suggestTechnologies(
  text: string,
  taxonomy: SearchTaxonomy = DEFAULT_SEARCH_TAXONOMY,
): string[] {
  const n = normalizeText(text);
  const out: string[] = [];
  for (const tech of taxonomy.technologies) {
    const key = normalizeText(tech);
    if (!key) continue;
    let found: boolean;
    if (/^[a-z0-9.+-]+$/.test(key)) {
      // ラテン文字は単語境界を確認（"line" が "outline" に当たらないように）
      const re = new RegExp(`(?<![a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`);
      found = re.test(n);
    } else {
      found = n.includes(key);
    }
    if (found) out.push(tech);
  }
  return out;
}
