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
