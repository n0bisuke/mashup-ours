// @vitest-environment happy-dom
/**
 * /ideas アイデア一覧ページ（issue #8）。
 * 空状態・一覧の件数とバッジ・親リンク・出典Issueリンク・XSS安全を確認する。
 */
import { expect, it } from 'vitest';
import type { Offspring } from '../lib/types.ts';
import sampleOffspring from '../data/offspring.sample.json';
import { buildIdeasPage, type IdeasContext } from '../public/ideas.ts';

const fixtures = sampleOffspring as unknown as Offspring[];

const ctx: IdeasContext = {
  repoCfg: { owner: 'test-owner', repo: 'test-repo' },
  base: '/',
};

function build(list: Offspring[], c: IdeasContext = ctx): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  buildIdeasPage(host, list, c);
  return host;
}

it('0件のときは空状態と申請誘導を表示する', () => {
  const host = build([]);
  const text = host.textContent ?? '';
  expect(text).toContain('まだアイデアは生まれていません');
  expect(text).toContain('配合を申し込む');
  expect(text).toContain('全0件');
  expect(host.querySelectorAll('.idea-item').length).toBe(0);
  // 戻るリンクはトップ
  const back = host.querySelector<HTMLAnchorElement>('header.hero a');
  expect(back?.getAttribute('href')).toBe('/');
});

it('一覧は新しい順に件数どおり並び、世代・未実装バッジが付く', () => {
  const host = build(fixtures);
  const items = Array.from(host.querySelectorAll<HTMLElement>('.idea-item'));
  expect(items.length).toBe(fixtures.length);
  // createdAt 降順: mashup-000002（11/08 11:05Z）が先頭
  expect(items[0].dataset.id).toBe('mashup-000002');
  expect(items[0].querySelector('.badge.idea')?.textContent).toBe('未実装のアイデア');
  expect(items[0].querySelector('.badge.gen')?.textContent).toBe('第2世代');
  expect(items[0].querySelector('.badge.sample')?.textContent).toBe('SAMPLE');
  expect(host.textContent).toContain('全2件');
  // 日時は日本時間（issue #18）: 「誕生日時: 2026/11/08 20:05（日本時間）」
  expect(host.textContent).toMatch(/誕生日時: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}（日本時間）/);
  expect(host.textContent).not.toContain('UTC'); // UTCの生データは画面に出さない
  // 詳細リンクは個別ページ /ideas/<id>/（issue #24）
  const detail = items[0].querySelector<HTMLAnchorElement>('a.idea-detail');
  expect(detail?.getAttribute('href')).toBe('/ideas/mashup-000002/');
});

it('サムネイル・発明名・概要が個別ページへの1つのリンクに入り、入れ子リンクがない（issue #24）', () => {
  const host = build(fixtures);
  const first = host.querySelector<HTMLElement>('.idea-item');
  const open = first?.querySelector<HTMLAnchorElement>('a.idea-open');
  expect(open).toBeTruthy();
  expect(open?.getAttribute('href')).toBe('/ideas/mashup-000002/');
  // 遷移領域にカードの余白・サムネイル・タイトル・概要が入る
  expect(open?.querySelector('.idea-thumb')).toBeTruthy();
  expect(open?.querySelector('.idea-title')).toBeTruthy();
  expect(open?.querySelector('.idea-summary')).toBeTruthy();
  // 実リンクなのでキーボード（Tab/Enter）で操作できる
  expect(open?.tagName).toBe('A');
  // リンクの入れ子なし（親作品・Issueのリンクは遷移領域の外）
  expect(open?.querySelector('a')).toBeNull();
  const outside = first?.querySelectorAll('.idea-parents a, .idea-foot a');
  expect(outside?.length).toBeGreaterThan(0);
  for (const a of Array.from(outside ?? [])) expect(open?.contains(a)).toBe(false);
});

it('親はタイトルでリンクする（子=その個別ページ / ProtoPedia=出典URL）', () => {
  const host = build(fixtures); // 先頭は mashup-000002（親: mashup-000001 × protopedia:9002）
  const first = host.querySelector<HTMLElement>('.idea-item');
  expect(first).toBeTruthy();
  const links = Array.from(first!.querySelectorAll('.idea-parents a'));
  expect(links.length).toBe(2);
  expect(links[0].getAttribute('href')).toBe('/ideas/mashup-000001/'); // 個別ページ中心（issue #24）
  expect(links[0].textContent).toContain('光る歴史散歩デバイス'); // 読み込み済みのタイトル
  expect(links[1].getAttribute('href')).toBe('https://protopedia.net/prototype/9002');
  expect(links[1].getAttribute('target')).toBe('_blank');
});

it('読み込み済みに無い ProtoPedia 親でも出典URLへリンクする', () => {
  const fx: Offspring = {
    ...fixtures[0],
    id: 'mashup-000099',
    parents: ['protopedia:999999999', 'mashup-000001'] as Offspring['parents'],
    sample: false,
    sourceIssue: 42,
  };
  const host = build([fx]);
  const proto = host.querySelector<HTMLAnchorElement>(
    'a[href="https://protopedia.net/prototype/999999999"]',
  );
  expect(proto).toBeTruthy();
  expect(proto!.textContent).toBe('protopedia:999999999'); // 不明なIDはIDのまま
  // 生成Issueへのリンク（repoCfgあり・Issue番号あり）
  const issue = host.querySelector<HTMLAnchorElement>('a[href$="/issues/42"]');
  expect(issue?.getAttribute('href')).toBe('https://github.com/test-owner/test-repo/issues/42');
  // サンプルでなければ SAMPLE バッジは出ない
  expect(host.querySelector('.badge.sample')).toBeNull();
});

it('sourceIssue 0 や repoCfg 未設定では元Issueリンクを出さない', () => {
  const host = build(fixtures); // 全件 sourceIssue: 0
  expect(host.querySelector('a[href*="/issues/"]')).toBeNull();
  const host2 = build([{ ...fixtures[0], sourceIssue: 7 }], { repoCfg: null, base: '/' });
  expect(host2.querySelector('a[href*="/issues/"]')).toBeNull();
});

// --- 配合申請者のGitHubアイコン+ユーザー名（issue #42） ----------------------

it('requester があるカードは申請者のチップを foot に表示する（issue #42）', () => {
  const fx: Offspring = {
    ...fixtures[0],
    requester: { login: 'test-user', avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4' },
  };
  const host = build([fx]);
  const chip = host.querySelector<HTMLAnchorElement>('.idea-item .idea-foot .requester-chip');
  expect(chip).toBeTruthy();
  expect(chip?.getAttribute('href')).toBe('https://github.com/test-user');
  expect(chip?.getAttribute('target')).toBe('_blank');
  expect(chip?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(chip?.textContent).toContain('@test-user');
  expect(chip?.getAttribute('title')).toBe('配合を申し込んだ人');
  expect(chip?.querySelector('img')?.getAttribute('src')).toBe(
    'https://avatars.githubusercontent.com/u/123?v=4',
  );
});

it('requester 無しの既存データではチップを出さない（issue #42）', () => {
  const host = build(fixtures); // サンプルデータに requester は無い
  expect(host.querySelector('.requester-chip')).toBeNull();
  // 不正な avatarUrl は表示ごと省く fail-safe
  const bad = [
    { ...fixtures[0], requester: { login: 'x', avatarUrl: 'https://evil.example.com/u/1' } },
  ] as unknown as Offspring[];
  expect(build(bad).querySelector('.requester-chip')).toBeNull();
});

it('タイトル等の外部入力をHTMLとして挿入しない（XSS）', () => {
  const evil: Offspring = {
    ...fixtures[0],
    title: '<img src=x onerror=alert(1)>',
    summary: '"><script>alert(2)</script>',
  };
  const host = build([evil]);
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelectorAll('[onclick], [onload], [onerror]').length).toBe(0);
  // サムネイルの <img> は imagePath 由来だけ（タイトルのHTMLは src/alt 属性に展開されない）
  const imgs = Array.from(host.querySelectorAll('img'));
  expect(imgs.length).toBeLessThanOrEqual(1);
  for (const img of imgs) {
    expect(img.getAttribute('src') ?? '').toContain('assets/inventions/');
    expect(img.getAttribute('src') ?? '').not.toContain('onerror=alert');
    expect(img.hasAttribute('onerror')).toBe(false);
  }
  // テキストとしてそのまま表示される
  expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
});

it('フッターにGitHubリポジトリへのリンク（issue #30 / 未設定時は出さない）', () => {
  const host = build(fixtures);
  const link = host.querySelector<HTMLAnchorElement>('.ideas-foot .foot-links a');
  expect(link?.getAttribute('href')).toBe('https://github.com/test-owner/test-repo');
  expect(link?.getAttribute('target')).toBe('_blank');
  expect(link?.getAttribute('rel')).toContain('noopener');
  expect(link?.textContent).toContain('GitHubリポジトリ');
  // owner/repo 未設定ならリンク行ごと出さない（ハードコードしたリンクは張らない）
  const host2 = build(fixtures, { ...ctx, repoCfg: null });
  expect(host2.querySelector('.ideas-foot .foot-links')).toBeNull();
  // 非公式の注記は残る
  expect(host2.querySelector('.ideas-foot .foot-note')?.textContent).toContain('非公式プロジェクト');
});

it('一覧と個別ページの配合タイプ表示名を統一する（issue #31）', () => {
  const host = build(fixtures);
  const badge = host.querySelector('.idea-item .badge.mode');
  expect(badge?.textContent).toBe('単純配合'); // 個別ページ（idea.ts）と同じ blendModeLabel 由来

  // 未記録・未知の値は一覧も「配合タイプ不明」（単純配合と見なさない）
  const broken = [{ ...fixtures[0], mode: 'simple' }] as unknown as Offspring[];
  const h2 = build(broken);
  expect(h2.querySelector('.idea-item .badge.mode')?.textContent).toBe('配合タイプ不明');
  expect(h2.textContent).not.toContain('undefined');
});

// --- 検索（issue #38: 技術 × 分野の掛け合わせ検索） -------------------------

/** メタデータを持つ架空の発明（タグ絞り込み・一致表示の検証用）。 */
function taggedIdea(id: string, overrides: Partial<Offspring>): Offspring {
  return { ...fixtures[0], id, ...overrides } as Offspring;
}

const searchable: Offspring[] = [
  taggedIdea('mashup-000011', {
    title: '授業を変える点呼システム',
    summary: '出席と理解度を同時にとる',
    concept: '教室で先生が使う',
    technologies: ['Dify'],
    domains: ['教育・学習'],
    createdAt: '2026-11-09T12:00:00Z',
  }),
  taggedIdea('mashup-000012', {
    title: '業務を整える通知マシン',
    summary: '社内の漏れを減らす',
    concept: '職場で使う',
    technologies: ['LINE'],
    domains: ['業務・ビジネス'],
    createdAt: '2026-11-09T11:00:00Z',
  }),
  taggedIdea('mashup-000013', {
    // タグ無し（既存データ）: テキスト検索の対象には残る
    title: '光る歴史散歩デバイス',
    summary: '歩くと体験が光で変わる',
    technologies: undefined,
    domains: undefined,
    createdAt: '2026-11-09T10:00:00Z',
  }),
];

function buildWith(
  list: Offspring[],
  opts: Parameters<typeof buildIdeasPage>[3] = {},
): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  buildIdeasPage(host, list, ctx, opts);
  return host;
}

it('検索UI（キーワード・技術・分野・クリア）を一覧に用意する（issue #38）', () => {
  const host = buildWith(searchable, { syncUrl: false });
  const form = host.querySelector('form.search-row');
  expect(form).toBeTruthy();
  expect(host.querySelector<HTMLInputElement>('#idea-search-input')?.type).toBe('search');
  const tech = Array.from(host.querySelectorAll<HTMLOptionElement>('#search-tech option')).map(
    (o) => o.value,
  );
  const domain = Array.from(
    host.querySelectorAll<HTMLOptionElement>('#search-domain option'),
  ).map((o) => o.value);
  // 実データに存在する条件だけを候補にする（存在しない条件は出さない）
  expect(tech).toEqual(['', 'Dify', 'LINE']);
  // 分野は config/search-taxonomy.json の並び順（実データにあるものだけ）
  expect(domain).toEqual(['', '業務・ビジネス', '教育・学習']);
  expect(domain).not.toContain('医療・ヘルスケア');
  // 検索できない状態ではクリアボタンを出さない
  expect(host.querySelector<HTMLButtonElement>('.search-clear')?.hidden).toBe(true);
  expect(host.textContent).toContain('全3件');
  expect(host.textContent).toContain('技術と分野は掛け合わせで絞り込めます');
});

it('技術と分野を掛け合わせて絞り込み、件数チップが切り替わる（issue #38）', () => {
  const host = buildWith(searchable, {
    syncUrl: false,
    initialQuery: { q: '', tech: 'Dify', domain: '教育・学習' },
  });
  const items = Array.from(host.querySelectorAll<HTMLElement>('.idea-item'));
  expect(items.map((i) => i.dataset.id)).toEqual(['mashup-000011']);
  expect(host.querySelector('.chip')?.textContent).toBe('検索結果: 1件');
  expect(host.querySelector('.chip')?.classList.contains('is-filtered')).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('.search-clear')?.hidden).toBe(false);
  expect(host.querySelector<HTMLSelectElement>('#search-tech')?.value).toBe('Dify');
  expect(host.querySelector<HTMLSelectElement>('#search-domain')?.value).toBe('教育・学習');
  // 選択中タグは状態を色だけでなく aria-pressed でも示す
  const pressed = host.querySelectorAll<HTMLButtonElement>('.idea-tags .tag-chip[aria-pressed="true"]');
  expect(pressed.length).toBe(2); // 技術Dify + 分野教育・学習
});

it('キーワードはANDで絞り、一致した項目をカードに示す（issue #38）', () => {
  const host = buildWith(searchable, {
    syncUrl: false,
    initialQuery: { q: '点呼 授業', tech: '', domain: '' },
  });
  const items = Array.from(host.querySelectorAll<HTMLElement>('.idea-item'));
  expect(items.map((i) => i.dataset.id)).toEqual(['mashup-000011']);
  const hint = host.querySelector('.idea-match')?.textContent ?? '';
  expect(hint).toContain('に一致');
  expect(hint).toContain('発明名'); // どの項目に一致したか分かる
});

it('条件に合う発明が無いときは専用の空状態を出す（issue #38）', () => {
  const host = buildWith(searchable, {
    syncUrl: false,
    initialQuery: { q: '', tech: 'Dify', domain: '業務・ビジネス' },
  });
  expect(host.querySelectorAll('.idea-item')).toHaveLength(0);
  expect(host.textContent).toContain('条件に合う発明はまだ見つからないようです。');
  expect(host.querySelector('.chip')?.textContent).toBe('検索結果: 0件');
});

it('カードのタグを押すと絞り込み、同じタグをもう一度押すと解除される（issue #38）', () => {
  const host = buildWith(searchable, { syncUrl: false });
  const tag = host.querySelector<HTMLButtonElement>(
    '.idea-item[data-id="mashup-000011"] button.tag-chip[data-kind="tech"]',
  );
  expect(tag?.dataset.value).toBe('Dify');
  tag?.click();
  expect(
    Array.from(host.querySelectorAll<HTMLElement>('.idea-item')).map((i) => i.dataset.id),
  ).toEqual(['mashup-000011']);
  expect(host.querySelector('.chip')?.textContent).toBe('検索結果: 1件');
  // もう一度同じタグ → 解除（全件に戻る）
  const again = host.querySelector<HTMLButtonElement>(
    '.idea-item[data-id="mashup-000011"] button.tag-chip[data-kind="tech"]',
  );
  again?.click();
  expect(host.querySelectorAll('.idea-item')).toHaveLength(3);
  expect(host.querySelector('.chip')?.textContent).toBe('全3件');
});

it('タグが無い作品にはタグ行を作らない（既存データを壊さない / issue #38）', () => {
  const host = buildWith(searchable, { syncUrl: false });
  const legacy = host.querySelector('.idea-item[data-id="mashup-000013"]');
  expect(legacy?.querySelector('.idea-tags')).toBeNull();
  // タグを持つ作品には出る
  expect(host.querySelector('.idea-item[data-id="mashup-000011"] .idea-tags')).toBeTruthy();
});

it('検索条件はURLに記録され、共有できる（issue #38 §7）', () => {
  const host = buildWith(searchable, { syncUrl: false });
  const form = host.querySelector('form.search-row');
  const input = host.querySelector<HTMLInputElement>('#idea-search-input');
  if (input) input.value = '点呼';
  form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  const items = Array.from(host.querySelectorAll<HTMLElement>('.idea-item'));
  expect(items.map((i) => i.dataset.id)).toEqual(['mashup-000011']);
  // syncUrl:false では履歴を触らない（テストで履歴を汚さない）
  expect(host.querySelectorAll('.idea-item').length).toBe(1);
});
