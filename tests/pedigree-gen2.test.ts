// @vitest-environment happy-dom
/**
 * 系譜図の第2世代表示（issue #36 — 生成アイデアの再配合）。
 *
 * data/offspring.json を「第1世代 → その子が第2世代」のフィクスチャに差し替え、
 * - 親がAI生成アイデアでもノード・接続線が出ること（系譜が途切れない）
 * - 世代ごとに列が分かれること（第2世代は3列目）
 * - 次世代への接続線（第1世代ノードの右端 → 第2世代ノード）が引かれること
 * - 個別ページ（/ideas/）へたどれること
 * を確認する。実データの件数には依存しない。
 */
import { expect, it, vi } from 'vitest';
import { installMemoryStorage } from './helpers/memory-storage.ts';

vi.mock('../data/offspring.json', () => ({
  default: [
    {
      id: 'mashup-000001',
      schemaVersion: 1,
      title: '第1世代の発明',
      summary: '系譜図テスト用の第1世代（AI生成アイデア・未実装）',
      concept: 'テスト用の利用場面',
      mechanism: 'テスト用の仕組み',
      inheritedTraits: [
        { parentId: 'protopedia:93', trait: '回す仕組み' },
        { parentId: 'protopedia:3676', trait: '対話の体験' },
      ],
      parents: ['protopedia:93', 'protopedia:3676'],
      generation: 1,
      mode: 'fusion',
      sourceIssue: 101,
      slot: '2026-11-09T12',
      createdAt: '2026-11-09T12:07:00Z',
      model: 'test/model',
      status: 'idea',
    },
    {
      id: 'mashup-000002',
      schemaVersion: 1,
      title: '第2世代の発明',
      summary: 'AI生成アイデアを親にした第2世代（未実装）',
      concept: 'テスト用の利用場面2',
      mechanism: 'テスト用の仕組み2',
      inheritedTraits: [
        { parentId: 'mashup-000001', trait: '回して遊ぶリズム' },
        { parentId: 'protopedia:2', trait: '身近な道具' },
      ],
      parents: ['mashup-000001', 'protopedia:2'],
      generation: 2,
      mode: 'genetic',
      sourceIssue: 102,
      slot: '2026-11-09T13',
      createdAt: '2026-11-09T13:07:00Z',
      model: 'test/model',
      status: 'idea',
    },
  ],
}));

// 候補ファイルは実データ（build-time import）に依存させない（issue #44の教訓）。
// フィクスチャの第2世代が子候補カードに出る状態へ固定する（isCandidatesFile で
// はじかれない完全な形）。
vi.mock('../data/current-candidates.json', () => ({
  default: {
    schemaVersion: 1,
    slot: '2026-11-09T1200',
    nextSlot: '2026-11-09T1215',
    generatedAt: '2026-11-09T12:05:00Z',
    source: 'data/sample-prototypes.json',
    candidates: [
      {
        id: 'protopedia:93',
        title: '系譜図テスト用の候補作品',
        sourceUrl: 'https://protopedia.net/prototype/93',
        summary: 'テスト用の親作品',
        generation: 0,
      },
    ],
    offspringCandidates: ['mashup-000002'],
  },
}));

const SVG_NS = 'http://www.w3.org/2000/svg';
const COL_W = 300;
const NODE_W = 240;

async function boot() {
  vi.resetModules();
  installMemoryStorage();
  document.documentElement.classList.remove('has-float');
  document.body.innerHTML = '<div id="app"></div>';
  await import('../public/main.ts');
  const nodeIds = () =>
    Array.from(document.querySelectorAll('.pedigree-scroll .node'))
      .map((n) => /（([^（）]+)）$/.exec(n.getAttribute('aria-label') ?? '')?.[1] ?? '')
      .filter((id) => id !== '');
  const nodeOf = (id: string) =>
    Array.from(document.querySelectorAll<SVGGElement>('.pedigree-scroll .node')).find((n) =>
      (n.getAttribute('aria-label') ?? '').endsWith(`（${id}）`),
    );
  return { nodeIds, nodeOf };
}

it('第2世代のノードとその親（第1世代・ProtoPedia）がすべて系譜図に出る', async () => {
  const { nodeIds } = await boot();
  for (const id of [
    'mashup-000001',
    'mashup-000002',
    'protopedia:93',
    'protopedia:3676',
    'protopedia:2',
  ]) {
    expect(nodeIds(), `${id} が系譜図に無い`).toContain(id);
  }
  // 辺は子ごとに親2本（フィクスチャ2件 = 4本）。4本とも両端が解決している＝接続欠けなし
  expect(document.querySelectorAll('.pedigree-scroll .edge').length).toBe(4);
});

it('世代ごとに列が分かれ、第2世代は3列目（parent → child の向き）', async () => {
  const { nodeOf } = await boot();
  const xOf = (id: string) => Number(nodeOf(id)?.querySelector('rect')?.getAttribute('x'));
  expect(xOf('protopedia:93')).toBe(30 + 0 * COL_W); // 第0世代
  expect(xOf('mashup-000001')).toBe(30 + 1 * COL_W); // 第1世代
  expect(xOf('mashup-000002')).toBe(30 + 2 * COL_W); // 第2世代
});

it('第1世代ノードから第2世代ノードへの接続線が引かれる', async () => {
  await boot();
  const ds = Array.from(document.querySelectorAll('.pedigree-scroll .edge')).map((e) =>
    e.getAttribute('d') ?? '',
  );
  const fromGen1 = 30 + 1 * COL_W + NODE_W; // 第1世代ノードの右端 x = 570
  const toGen2 = 30 + 2 * COL_W; // 第2世代ノードの左端 x = 630
  const fromGen2 = toGen2 + NODE_W; // 第2世代ノードの右端 x = 870
  // 始点＝第1世代の右端、終点＝第2世代の左端 の接続線が1本でもある
  expect(ds.some((d) => new RegExp(`^M ${fromGen1} .* ${toGen2} `).test(d))).toBe(true);
  // 自己参照の辺は無い（循環が描かれない）
  expect(ds.some((d) => new RegExp(`^M ${toGen2} .* ${toGen2} `).test(d))).toBe(false);
  expect(ds.every((d) => !d.startsWith(`M ${fromGen2} `))).toBe(true); // child→parent の辻は引かない
});

it('ノードはAI生成＝破線（child）、ProtoPedia＝実線（proto）として区別される', async () => {
  const { nodeOf } = await boot();
  expect(nodeOf('mashup-000002')?.getAttribute('class')).toContain('child');
  expect(nodeOf('mashup-000001')?.getAttribute('class')).toContain('child');
  expect(nodeOf('protopedia:93')?.getAttribute('class')).toContain('proto');
  expect(document.querySelector('.pedigree-legend')?.textContent).toContain('AI生成アイデア');
  expect(document.querySelector('.pedigree-legend')?.textContent).toContain('ProtoPedia作品');
});

it('第2世代の詳細に継承した特徴・親・子が出て、個別ページへたどれる', async () => {
  const { nodeOf } = await boot();
  (nodeOf('mashup-000002') as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const detail = document.querySelector('.detail');
  expect(detail?.textContent).toContain('第2世代の発明');
  expect(detail?.textContent).toContain('継承した特徴');
  expect(detail?.textContent).toContain('回して遊ぶリズム');
  expect(detail?.textContent).toContain('配合タイプ'); // 遺伝子配合
  // 親（第1世代）と子のたどり行き
  expect(detail?.textContent).toContain('親');
  // 個別ページへの導線（AI生成＝サイト内、ProtoPediaとは出典先を区別）
  const ideaLink = detail?.querySelector<HTMLAnchorElement>('a[href*="ideas/"]');
  expect(ideaLink?.getAttribute('href')).toContain('ideas/mashup-000002');
});

it('最近誕生した発明の一覧に世代表記が出て、候補カード側と選択が同期する', async () => {
  const { nodeOf } = await boot();
  const li = Array.from(document.querySelectorAll<HTMLElement>('ul.offspring li')).find((n) =>
    (n.textContent ?? '').includes('mashup-000002'),
  );
  expect(li?.textContent).toContain('第2世代');
  expect(li?.textContent).toContain('mashup-000001 × protopedia:2');

  // 候補側（child-card）で選んでも、一覧の行が同じ状態になる（issue #36 pickRegistry）
  const card = document.querySelector<HTMLElement>('.candidate.child-card');
  expect(card?.dataset.id).toBe('mashup-000002');
  card?.querySelector<HTMLButtonElement>('button.pick')?.click();
  expect(card?.classList.contains('is-a')).toBe(true);
  expect(li?.classList.contains('is-a')).toBe(true);
  // SVGノードも click で詳細が切り替わること（描画の生存確認）
  (nodeOf('mashup-000001') as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(document.querySelector('.detail')?.textContent).toContain('第1世代の発明');
});

it('系譜図SVGにonload等の属性が付かない（XSS）', async () => {
  await boot();
  expect(document.querySelectorAll('.pedigree-scroll [onclick], .pedigree-scroll [onload]').length).toBe(0);
  expect(document.querySelector('.pedigree-scroll svg')?.getAttribute('xmlns') ?? SVG_NS).toBeTruthy();
});
