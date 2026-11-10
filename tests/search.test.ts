/**
 * アイデア検索（issue #38）: 技術 × 分野の掛け合わせ検索。
 * 純関数のみのため environment 指定は不要（Node）。
 *
 * 守りたいこと:
 * - ブラウザ内完結（追加リクエスト・AI呼び出しなし）＝純関数の組み合わせで足りる
 * - キーワードは AND、表記揺れは taxonomy の同義語で吸収
 * - 並びは 技術 → 分野 → 発明名 → 概要 → キーワード → 詳細 のスコア順
 * - 絞り込み候補には「実データに存在しない条件」を出さない
 * - ルール補完は明示された語しか検出しない（推測でタグを付けない）
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_TAXONOMY,
  EMPTY_QUERY,
  MATCH_FIELD_LABELS,
  MAX_QUERY_LENGTH,
  buildSearchIndex,
  facetOptions,
  isEmptyQuery,
  normalizeText,
  parseSearchQuery,
  parseSearchTaxonomy,
  searchHref,
  searchIdeas,
  searchQueryString,
  suggestDomains,
  suggestTechnologies,
  type SearchQuery,
} from '../lib/search.ts';
import type { Offspring } from '../lib/types.ts';
import rawTaxonomy from '../config/search-taxonomy.json';

function idea(id: string, overrides: Partial<Offspring> = {}): Offspring {
  return {
    id,
    schemaVersion: 1,
    title: `${id}の発明`,
    summary: '概要',
    concept: '',
    mechanism: '',
    inheritedTraits: [],
    parents: ['protopedia:1', 'protopedia:2'],
    generation: 1,
    mode: 'fusion',
    sourceIssue: 1,
    slot: '2026-11-09T12',
    createdAt: '2026-11-09T12:00:00Z',
    model: 'test/model',
    status: 'idea',
    ...overrides,
  };
}

function index(...list: Offspring[]) {
  return buildSearchIndex(list);
}

function q(partial: Partial<SearchQuery>): SearchQuery {
  return { ...EMPTY_QUERY, ...partial };
}

describe('正規化とクエリ', () => {
  it('normalizeText は NFKC → 小文字 → 空白畳み込み（全角・大小を吸収）', () => {
    expect(normalizeText('　Ｄｉｆｙ　業務　')).toBe('dify 業務');
    expect(normalizeText('Ｎｏｄｅ－ＲＥＤ')).toBe('node-red');
    expect(normalizeText('  A\n\tB  ')).toBe('a b');
  });

  it('parseSearchQuery は欠損を空に、長すぎる入力を切り詰める', () => {
    const empty = parseSearchQuery(new URLSearchParams());
    expect(empty).toEqual(EMPTY_QUERY);
    expect(isEmptyQuery(empty)).toBe(true);

    const long = 'x'.repeat(MAX_QUERY_LENGTH + 40);
    const parsed = parseSearchQuery(new URLSearchParams({ q: long, tech: 'Dify' }));
    expect(parsed.q.length).toBe(MAX_QUERY_LENGTH);
    expect(parsed.tech).toBe('Dify');
    expect(parsed.domain).toBe('');
  });

  it('クエリ文字列と一覧URLは往復できる（共有リンク）', () => {
    const query = q({ q: 'Dify 業務', tech: '生成AI', domain: '業務・ビジネス' });
    const qs = searchQueryString(query);
    expect(parseSearchQuery(new URLSearchParams(qs))).toEqual(query);
    expect(searchHref('/', query)).toBe(`/ideas/?${qs}`);
    expect(searchHref('../', { ...EMPTY_QUERY })).toBe('../ideas/');
    expect(searchQueryString({ ...EMPTY_QUERY })).toBe('');
    expect(isEmptyQuery({ ...EMPTY_QUERY })).toBe(true);
    expect(isEmptyQuery({ ...EMPTY_QUERY, q: 'x' })).toBe(false);
  });

  it('MATCH_FIELD_LABELS は全一致項目を網羅した日本語ラベルを持つ', () => {
    const fields = ['technology', 'domain', 'keyword', 'title', 'summary', 'detail'] as const;
    for (const f of fields) expect(MATCH_FIELD_LABELS[f]).toBeTruthy();
    expect(Object.keys(MATCH_FIELD_LABELS).length).toBe(fields.length);
  });
});

describe('インデックス', () => {
  it('発明名・概要・詳細（concept+mechanism+利用シーン）とタグを持つ', () => {
    const [doc] = index(
      idea('mashup-000001', {
        title: '光る散歩デバイス',
        summary: '歴史散歩が光で変わる',
        concept: '利用場面の説明',
        mechanism: 'GPSで現在地を知る',
        useCases: ['観光ツアーで使う', '授業で使う'],
        technologies: ['GPS'],
        domains: ['観光・地域'],
        keywords: ['歴史'],
      }),
    );
    expect(doc.title).toBe('光る散歩デバイス');
    expect(doc.detail).toContain('利用場面の説明');
    expect(doc.detail).toContain('GPSで現在地を知る');
    expect(doc.detail).toContain('観光ツアーで使う');
    expect(doc.technologies).toEqual(['GPS']);
    expect(doc.domains).toEqual(['観光・地域']);
    expect(doc.keywords).toEqual(['歴史']);
  });

  it('タグが無い既存データは空配列（テキスト検索の対象には残る）', () => {
    const [doc] = index(idea('mashup-000002'));
    expect(doc.technologies).toEqual([]);
    expect(doc.domains).toEqual([]);
    expect(doc.keywords).toEqual([]);
    expect(doc.summary).toBe('概要');
  });

  it('タグの汚れ（非文字列・空白・重複）を掃除する', () => {
    const [doc] = index(
      idea('mashup-000003', {
        technologies: ['Dify', ' dify ', 42, ''] as unknown as string[],
        domains: ['日常生活', '日常生活'],
      }),
    );
    expect(doc.technologies).toEqual(['Dify']);
    expect(doc.domains).toEqual(['日常生活']);
  });
});

describe('キーワード検索（AND）', () => {
  const list = [
    idea('mashup-000001', {
      title: '授業を変える点呼システム',
      summary: '出席と理解度を同時にとる',
      concept: '教室で先生が使う',
      createdAt: '2026-11-09T12:00:00Z',
    }),
    idea('mashup-000002', {
      title: '点呼で始まる散歩会',
      summary: '集合を確認して出発する',
      createdAt: '2026-11-08T12:00:00Z',
    }),
  ];
  const idx = index(...list);

  it('空白区切りは AND（全部当たったものだけ）', () => {
    const hits = searchIdeas(idx, q({ q: '点呼' }));
    expect(hits.map((h) => h.doc.id)).toEqual(['mashup-000001', 'mashup-000002']);

    const both = searchIdeas(idx, q({ q: '点呼 授業' }));
    expect(both.map((h) => h.doc.id)).toEqual(['mashup-000001']);

    expect(searchIdeas(idx, q({ q: '点呼 学校' }))).toHaveLength(0);
    expect(searchIdeas(idx, { ...EMPTY_QUERY })).toHaveLength(2);
  });

  it('一致した項目（fields）と語ごとの一致（terms）を返す', () => {
    const [hit] = searchIdeas(idx, q({ q: '授業' }));
    expect(hit.fields).toContain('title');
    expect(hit.fields).toContain('summary');
    expect(hit.terms[0]).toEqual({ term: '授業', fields: expect.arrayContaining(['title']) });
  });

  it('大文字小文字・全角を区別しない（Dify と ｄｉｆｙ が一致）', () => {
    const idx2 = index(idea('mashup-000010', { concept: 'Difyで組む業務フロー' }));
    expect(searchIdeas(idx2, q({ q: 'ｄｉｆｙ' }))).toHaveLength(1);
    expect(searchIdeas(idx2, q({ q: 'DIFY' }))).toHaveLength(1);
  });
});

describe('技術 × 分野の掛け合わせ', () => {
  const list = [
    idea('mashup-000001', {
      title: '業務のDify自動化',
      technologies: ['Dify'],
      domains: ['業務・ビジネス'],
      createdAt: '2026-11-09T12:00:00Z',
    }),
    idea('mashup-000002', {
      title: '授業のDify教材',
      technologies: ['Dify'],
      domains: ['教育・学習'],
      createdAt: '2026-11-09T11:00:00Z',
    }),
    idea('mashup-000003', {
      title: '業務のLINE通知',
      technologies: ['LINE'],
      domains: ['業務・ビジネス'],
      createdAt: '2026-11-09T10:00:00Z',
    }),
  ];
  const idx = index(...list);

  it('技術と分野は AND で掛け合わせる', () => {
    const both = searchIdeas(idx, q({ tech: 'Dify', domain: '業務・ビジネス' }));
    expect(both.map((h) => h.doc.id)).toEqual(['mashup-000001']);

    const all = searchIdeas(idx, q({ tech: 'Dify' }));
    expect(all.map((h) => h.doc.id)).toEqual(['mashup-000001', 'mashup-000002']);

    const dom = searchIdeas(idx, q({ domain: '業務・ビジネス' }));
    expect(dom.map((h) => h.doc.id)).toEqual(['mashup-000001', 'mashup-000003']);
  });

  it('キーワードと絞り込みも同時に使える', () => {
    const hits = searchIdeas(idx, q({ q: '教材', tech: 'Dify', domain: '教育・学習' }));
    expect(hits.map((h) => h.doc.id)).toEqual(['mashup-000002']);
    expect(searchIdeas(idx, q({ q: '教材', tech: 'LINE' }))).toHaveLength(0);
  });

  it('表記揺れ（同義語）で絞り込める（ディファイ→Dify / 教育→教育・学習）', () => {
    expect(searchIdeas(idx, q({ tech: 'ディファイ' })).map((h) => h.doc.id)).toEqual([
      'mashup-000001',
      'mashup-000002',
    ]);
    expect(searchIdeas(idx, q({ domain: '教育' })).map((h) => h.doc.id)).toEqual([
      'mashup-000002',
    ]);
    // キーワード側の同義語展開（ライン → LINE）
    expect(searchIdeas(idx, q({ q: 'ライン' })).map((h) => h.doc.id)).toEqual([
      'mashup-000003',
    ]);
  });

  it('該当なしは空配列（エラーにしない）', () => {
    expect(searchIdeas(idx, q({ tech: 'Node-RED' }))).toEqual([]);
  });
});

describe('並び順とスコア', () => {
  it('発明名 > 概要 > 詳細 の順に並ぶ（同じ語が複数の項目にあっても）', () => {
    const list = [
      idea('mashup-000001', { title: 'A', summary: 'B', mechanism: '散歩の仕組み' }), // 詳細のみ
      idea('mashup-000002', { title: '散歩の発明', summary: '説明' }), // 発明名
      idea('mashup-000003', { title: 'C', summary: '散歩が変わる' }), // 概要
      idea('mashup-000004', { title: 'D', summary: 'E', mechanism: '関係ない' }), // 不一致
    ];
    const hits = searchIdeas(index(...list), q({ q: '散歩' }));
    expect(hits.map((h) => h.doc.id)).toEqual(['mashup-000002', 'mashup-000003', 'mashup-000001']);
    expect(hits.map((h) => h.score)).toEqual([60, 40, 20]);
  });

  it('分野タグの一致はキーワード検索より上位に置ける（掛けると1件に絞れる）', () => {
    const list = [
      idea('mashup-000001', { title: '散歩A', summary: '概要', domains: ['観光・地域'] }),
      idea('mashup-000002', { title: '散歩B', summary: '概要', domains: ['教育・学習'] }),
    ];
    const hits = searchIdeas(index(...list), q({ q: '散歩', domain: '観光・地域' }));
    expect(hits.map((h) => h.doc.id)).toEqual(['mashup-000001']);
    expect(hits[0].score).toBe(60); // 発明名一致（分野タグは絞り込み条件なので語の一致ではない）
  });

  it('技術タグ一致のスコアは発明名一致より高い', () => {
    const list = [
      idea('mashup-000001', { title: 'Difyで組む発明', summary: 'x' }),
      idea('mashup-000002', { title: '別の発明', summary: 'y', technologies: ['Dify'] }),
    ];
    const hits = searchIdeas(index(...list), q({ q: 'Dify' }));
    expect(hits.map((h) => h.doc.id)).toEqual(['mashup-000002', 'mashup-000001']);
    expect(hits[0].fields[0]).toBe('technology');
  });

  it('同点なら新しい順（createdAt降順）', () => {
    const list = [
      idea('mashup-000001', { title: '同じ題', createdAt: '2026-11-01T00:00:00Z' }),
      idea('mashup-000002', { title: '同じ題', createdAt: '2026-11-09T00:00:00Z' }),
    ];
    expect(searchIdeas(index(...list), q({ q: '同じ題' })).map((h) => h.doc.id)).toEqual([
      'mashup-000002',
      'mashup-000001',
    ]);
  });
});

describe('絞り込み候補（facets）', () => {
  it('固定候補のうち実データにあるものだけを先頭に、データ固有の値は追加する', () => {
    const idx = index(
      idea('mashup-000001', { technologies: ['Dify', '画像生成AI'], domains: ['教育・学習'] }),
      idea('mashup-000002', { technologies: ['LINE'], domains: ['その他'] }),
    );
    const f = facetOptions(idx);
    // 実在分は taxonomy の順序どおり
    expect(f.technologies).toEqual(['Dify', 'LINE', '画像生成AI']);
    // 実在しない候補（IoT等）は出さない
    expect(f.technologies).not.toContain('IoT');
    expect(f.domains).toEqual(['教育・学習', 'その他']);
    expect(f.domains).not.toContain('医療・ヘルスケア');
  });

  it('タグが無いデータだけなら候補も空（存在しない条件で絞らせない）', () => {
    const f = facetOptions(index(idea('mashup-000001')));
    expect(f.technologies).toEqual([]);
    expect(f.domains).toEqual([]);
  });

  it('表記が違っても同一視できる（"LINE" と "line" は同じ候補にならない）', () => {
    const f = facetOptions(index(idea('mashup-000001', { technologies: ['line'] })));
    expect(f.technologies).toEqual(['line']); // 元の表記を保つ（大文字小文字は変えない）
  });
});

describe('ルール補完（既存データ向け）', () => {
  it('suggestTechnologies は明示された技術名だけ検出する', () => {
    expect(suggestTechnologies('Difyで業務を自動化し、GPSで位置を知る')).toEqual(['Dify', 'GPS']);
    // パートとして含まれるだけでは付けない（outline → LINE を誤検出しない）
    expect(suggestTechnologies('フチをoutlineのように描く')).toEqual([]);
    // どこにも書かれていない技術は推測で付けない
    expect(suggestTechnologies('歴史的な場所を歩く体験')).toEqual([]);
    expect(suggestTechnologies('')).toEqual([]);
  });

  it('suggestTechnologies は正規名が本文にあるときだけ拾う（同義語展開はしない）', () => {
    // 同義語（アイオーティー→IoT）は検索時の展開だけに使う。補完は本文に書かれた語だけ。
    expect(suggestTechnologies('アイオーティーのセンサーを使う')).toEqual([]);
    expect(suggestTechnologies('IoTのセンサーを使う')).toEqual(['IoT']);
    expect(suggestTechnologies('ノードレッドで組む')).toEqual([]);
    expect(suggestTechnologies('Node-REDで組む')).toEqual(['Node-RED']);
  });

  it('suggestDomains は分野の語が明確に現れたときだけ分類する', () => {
    expect(suggestDomains('授業と教室で使う点呼')).toEqual(['教育・学習']);
    expect(suggestDomains('登山中の体験')).toEqual(['アウトドア']);
    expect(suggestDomains('ふたつの発明が出会う')).toEqual([]);
    expect(suggestDomains('')).toEqual([]);
  });
});

describe('taxonomy の読み込み', () => {
  it('config/search-taxonomy.json は規定の形式でパースできる', () => {
    const parsed = parseSearchTaxonomy(rawTaxonomy);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.domains.length).toBeGreaterThan(0);
      expect(parsed.config.technologies.length).toBeGreaterThan(0);
    }
  });

  it('不正なtaxonomyは ok:false（読み込む側は AI を呼ばず終了する）', () => {
    expect(parseSearchTaxonomy(null).ok).toBe(false);
    expect(parseSearchTaxonomy([]).ok).toBe(false);
    expect(parseSearchTaxonomy({ ...rawTaxonomy, schemaVersion: 2 }).ok).toBe(false);
    expect(parseSearchTaxonomy({ ...rawTaxonomy, domains: 'x' }).ok).toBe(false);
    expect(parseSearchTaxonomy({ ...rawTaxonomy, domainAliases: [] }).ok).toBe(false);
  });

  it('既定のtaxonomyは config ファイルと同じ内容（フォールバックも同じ分類）', () => {
    expect(DEFAULT_SEARCH_TAXONOMY.domains).toEqual(rawTaxonomy.domains);
    expect(DEFAULT_SEARCH_TAXONOMY.technologies).toEqual(rawTaxonomy.technologies);
  });
});
