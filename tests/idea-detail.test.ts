// @vitest-environment happy-dom
/**
 * 個別詳細ページ /ideas/<id>/（issue #24）。
 * - 基本情報（発明名・サムネイル・概要・誕生日時JST・発明ID・世代・配合タイプ）
 * - 親A/B（ProtoPedia=作品名/画像/作者/出典リンク、mashup=発明名/サムネイル/個別ページ）
 * - AI配合結果（継承・仕組み・利用シーン・詳細）
 * - 子孫・関連リンク（Issue / 系譜図 ?id= / 一覧 / 配合申請）
 * - 存在しないID → 404相当、画像なし → プレースホルダ、欠損でも壊さない、XSS安全
 */
import { beforeEach, expect, it } from 'vitest';
import { BLEND_MODE_DESCRIPTIONS, type Offspring, type ProtopediaWork } from '../lib/types.ts';
import sampleOffspring from '../data/offspring.sample.json';
import {
  buildIdeaDetail,
  ideaDetailHref,
  ideaIdFromPath,
  siteBaseFor,
  type IdeaDetailContext,
} from '../public/idea.ts';

const fixtures = sampleOffspring as unknown as Offspring[];

// 作者・作品画像つきの架空ProtoPedia親（作者/画像表示の検証用）
const workWithMeta: ProtopediaWork = {
  id: 'protopedia:4',
  title: 'Pour or Drink',
  sourceUrl: 'https://protopedia.net/prototype/4',
  summary: 'テスト用の親作品',
  generation: 0,
  authors: ['作者A', '作者B'],
  mainUrl: 'https://protopedia.net/pic/sample.jpg',
};

const ctx: IdeaDetailContext = {
  repoCfg: { owner: 'test-owner', repo: 'test-repo' },
  base: '/',
  works: [workWithMeta],
};

function build(id: string, list: Offspring[] = fixtures, c: IdeaDetailContext = ctx): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  document.body.append(host);
  buildIdeaDetail(host, id, list, c);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

it('基本情報を表示する（発明名・世代・配合タイプ・誕生日時JST・発明ID）', () => {
  const host = build('mashup-000002');
  const text = host.textContent ?? '';
  expect(text).toContain('[SAMPLE] 手紙の声が導く光の散歩');
  expect(text).toContain('架空サンプル：古い手紙の声と光る地図が、散歩のルートを同時に教える');
  expect(text).toContain('第2世代');
  expect(text).toContain('単純配合');
  expect(text).toContain('未実装のアイデア');
  expect(text).toContain('発明ID: mashup-000002');
  // 誕生日時（issue #18 JST統一 / issue #24 §4）
  expect(text).toMatch(/誕生日時: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}（日本時間）/);
  expect(text).not.toContain('UTC');
  // サムネイル（大きく）+ 実装済みと誤認させない注意書き
  expect(host.querySelector('.det-thumb img')).toBeTruthy();
  expect(text).toContain('AIが考えた未実装の発明アイデア');
  expect(document.title).toContain('[SAMPLE] 手紙の声が導く光の散歩');
});

it('親A/Bを左右に表示する（ProtoPedia=出典リンク / mashup=個別ページへ）', () => {
  const host = build('mashup-000002'); // 親: mashup-000001 × protopedia:9002
  const cards = host.querySelectorAll<HTMLElement>('.det-parent');
  expect(cards.length).toBe(2);
  expect(cards[0].querySelector('.det-parent-role')?.textContent).toBe('親A');
  expect(cards[1].querySelector('.det-parent-role')?.textContent).toBe('親B');
  // 親A = 子作品 → 個別ページへ（相互遷移）
  const aLink = cards[0].querySelector<HTMLAnchorElement>('h3 a');
  expect(aLink?.getAttribute('href')).toBe('/ideas/mashup-000001/');
  expect(cards[0].textContent).toContain('[SAMPLE] 光る歴史散歩デバイス'); // 親＝子作品の発明名
  expect(cards[0].querySelector('img')).toBeTruthy(); // サムネイル
  expect(cards[0].textContent).toContain('個別ページへ');
  // 親B = ProtoPedia作品 → 出典URLへ（新規タブ）
  const bLink = cards[1].querySelector<HTMLAnchorElement>('h3 a');
  expect(bLink?.getAttribute('href')).toBe('https://protopedia.net/prototype/9002');
  expect(bLink?.getAttribute('target')).toBe('_blank');
  expect(cards[1].textContent).toContain('ProtoPedia作品');
  expect(cards[1].textContent).toContain('ProtoPediaで見る');
});

it('ProtoPedia親の作者名と作品画像を表示する（メタデータがあるとき）', () => {
  const fx: Offspring = { ...fixtures[0], parents: ['protopedia:4', 'protopedia:9004'] };
  const host = build(fx.id, [fx]);
  const card = host.querySelector<HTMLElement>('.det-parents .det-parent');
  expect(card?.textContent).toContain('Pour or Drink');
  expect(card?.textContent).toContain('作者: 作者A / 作者B');
  const img = card?.querySelector<HTMLImageElement>('img');
  expect(img?.getAttribute('src')).toBe('https://protopedia.net/pic/sample.jpg');
  expect(img?.getAttribute('alt')).toContain('作品画像（ProtoPedia）');
});

it('メタデータ不在の親でもIDと出典URLで表示して壊さない', () => {
  const fx: Offspring = { ...fixtures[0], parents: ['protopedia:999999999', 'mashup-999999'] };
  const host = build(fx.id, [fx]);
  const text = host.textContent ?? '';
  expect(text).toContain('protopedia:999999999'); // 不明なIDはIDのまま
  const proto = host.querySelector<HTMLAnchorElement>('a[href="https://protopedia.net/prototype/999999999"]');
  expect(proto).toBeTruthy();
  // 不在の子作品親 → 該当ページへのリンクは残す（行き先は404相当画面）
  expect(host.querySelector('a[href="/ideas/mashup-999999/"]')).toBeTruthy();
  expect(text).toContain('詳細データ未読込');
});

it('AI配合結果（継承・仕組み・利用シーン・詳細説明）を表示する', () => {
  const fx: Offspring = { ...fixtures[1], useCases: ['史跡散歩で使う', '授業で使う'] };
  const host = build(fx.id, [fixtures[0], fx]);
  const text = host.textContent ?? '';
  expect(text).toContain('AIによる配合結果');
  expect(text).toContain('継承した特徴');
  expect(text).toContain('歩くと変化する光の演出'); // inheritedTraits[].trait
  expect(text).toContain('仕組み・技術構成');
  expect(text).toContain('架空サンプルデータ。読み上げと光の同期（想定）。');
  expect(text).toContain('利用シーン');
  expect(text).toContain('史跡散歩で使う');
  expect(text).toContain('詳細説明（利用場面）');
});

it('子供の発明を個別ページへつなげる（相互遷移）', () => {
  const host = build('mashup-000001'); // 000002 の親
  const kids = host.querySelector('.det-kids');
  expect(kids).toBeTruthy();
  const link = kids?.querySelector<HTMLAnchorElement>('a[href="/ideas/mashup-000002/"]');
  expect(link).toBeTruthy();
  expect(link?.textContent).toContain('[SAMPLE] 手紙の声が導く光の散歩');
  // 子がいないときの文言
  const host2 = build('mashup-000002');
  expect(host2.querySelector('.det-kids')?.textContent).toContain('まだ子供の発明は生まれていません');
});

it('関連リンク（Issue / 系譜図 ?id= / 一覧 / 配合申請）を持つ', () => {
  const fx: Offspring = { ...fixtures[0], sourceIssue: 42, sample: false };
  const host = build(fx.id, [fx]);
  const links = host.querySelector('.det-links');
  expect(links).toBeTruthy();
  const issue = links?.querySelector<HTMLAnchorElement>('a[href$="/issues/42"]');
  expect(issue?.getAttribute('href')).toBe('https://github.com/test-owner/test-repo/issues/42');
  expect(issue?.getAttribute('target')).toBe('_blank');
  // 系譜図へはこの発明を選択した状態で（?id= ディープリンク / §5）
  expect(links?.querySelector('a[href="/?id=mashup-000001"]')).toBeTruthy();
  expect(links?.textContent).toContain('発明の系譜図で見る');
  expect(links?.querySelector('a[href="/ideas/"]')).toBeTruthy();
  expect(links?.querySelector('a[href="/#candidates"]')).toBeTruthy();
  // ヘッダーにも一覧・トップへの導線
  expect(host.querySelector('header.hero a[href="/ideas/"]')).toBeTruthy();
  expect(host.querySelector('header.hero a[href="/"]')).toBeTruthy();
});

it('sourceIssue 0 や repoCfg 未設定では元Issueリンクを出さない', () => {
  const host = build('mashup-000001'); // sourceIssue: 0
  expect(host.querySelector('.det-links a[href*="/issues/"]')).toBeNull();
  const host2 = build('mashup-000001', fixtures, { ...ctx, repoCfg: null });
  expect(host2.querySelector('a[href*="/issues/"]')).toBeNull();
});

it('存在しないID → 404相当の画面（一覧・トップへの導線つき）', () => {
  const host = build('mashup-999999');
  const text = host.textContent ?? '';
  expect(text).toContain('そのIDの発明は見つかりませんでした');
  expect(text).toContain('mashup-999999');
  expect(host.querySelector('a[href="/ideas/"]')).toBeTruthy();
  expect(host.querySelector('a[href="/"]')).toBeTruthy();
  expect(host.querySelector('.det-hero')).toBeNull();
  expect(document.title).toContain('見つかりません');
  // ID未指定でも壊さない
  expect(() => build('')).not.toThrow();
});

it('画像なし（imagePath: null）は共通プレースホルダを表示する', () => {
  const fx: Offspring = { ...fixtures[0], imagePath: null };
  const host = build(fx.id, [fx]);
  expect(host.querySelector('.det-thumb img')).toBeNull();
  expect(host.querySelector('.det-thumb .thumb-miss')?.textContent).toBe('画像なし');
});

it('データ欠損（inheritedTraits / useCases / concept 無し）でも画面を壊さない', () => {
  const { inheritedTraits: _t, useCases: _u, concept: _c, mechanism: _m, ...rest } = fixtures[0];
  const bare = rest as unknown as Offspring; // 必須フィールド欠損を許容する型に無理やり（検証対象）
  expect(() => build(bare.id, [bare])).not.toThrow();
  const host = build(bare.id, [bare]);
  expect(host.textContent).toContain(bare.title);
  expect(host.textContent).not.toContain('継承した特徴'); // 中身が無いセクションは出さない
  expect(host.textContent).not.toContain('利用シーン');
});

it('外部入力をHTMLとして挿入しない（XSS）', () => {
  const evil: Offspring = {
    ...fixtures[0],
    title: '<img src=x onerror=alert(1)>',
    summary: '"><script>alert(2)</script>',
    concept: '<svg onload=alert(3)>',
  };
  const host = build(evil.id, [evil]);
  expect(host.querySelector('script')).toBeNull();
  expect(host.querySelectorAll('[onclick], [onload], [onerror]').length).toBe(0);
  expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
});

it('URLユーティリティ（パスからID / サイトルート基点 / 個別URL）', () => {
  expect(ideaIdFromPath('/ideas/mashup-000001/')).toBe('mashup-000001');
  expect(ideaIdFromPath('/ideas/mashup-000001')).toBe('mashup-000001');
  expect(ideaIdFromPath('/ideas/')).toBeNull(); // 一覧は対象外
  expect(ideaIdFromPath('/')).toBeNull();
  expect(ideaIdFromPath('/repo/ideas/mashup-000002/')).toBe('mashup-000002');
  // 相対base: 個別ページは深さ2 → ルートへの基点は '../../'
  expect(siteBaseFor('/ideas/mashup-000001/', './')).toBe('../../');
  expect(siteBaseFor('/repo/ideas/mashup-000001/', './')).toBe('../../');
  expect(siteBaseFor('/idea/', './')).toBe('./');
  // 絶対base（VITE_BASE指定）はそのまま
  expect(siteBaseFor('/repo/ideas/mashup-000001/', '/repo/')).toBe('/repo/');
  expect(ideaDetailHref('/', 'mashup-000001')).toBe('/ideas/mashup-000001/');
  expect(ideaDetailHref('../../', 'mashup-000001')).toBe('../../ideas/mashup-000001/');
});

it('フッターにGitHubリポジトリへのリンク（issue #30 / 未設定時は出さない）', () => {
  const host = build('mashup-000001');
  const link = host.querySelector<HTMLAnchorElement>('.ideas-foot .foot-links a');
  expect(link?.getAttribute('href')).toBe('https://github.com/test-owner/test-repo');
  expect(link?.getAttribute('target')).toBe('_blank');
  const host2 = build('mashup-000001', fixtures, { ...ctx, repoCfg: null });
  expect(host2.querySelector('.ideas-foot .foot-links')).toBeNull();
});

it('上部に配合タイプのバッジと配合方法の説明を表示する（issue #31）', () => {
  const host = build('mashup-000001');
  const badge = host.querySelector('.det-hero .idea-badges .badge.mode');
  expect(badge?.textContent).toBe('単純配合'); // 実データ mode: fusion の表示名
  const note = host.querySelector('.det-mode-note');
  expect(note?.textContent).toContain('配合方法:');
  expect(note?.textContent).toContain(BLEND_MODE_DESCRIPTIONS.fusion);
  // 発明名・世代・誕生日時の並び（バッジはこの上部領域にある）
  expect(host.querySelector('.det-title')?.textContent).toBeTruthy();
  expect(host.querySelector('.idea-badges .badge.gen')?.textContent).toMatch(/第\d+世代/);
  expect(host.querySelector('.det-meta')?.textContent).toContain('誕生日時');
});

it('mode 未記録・未知の値は「配合タイプ不明」で、説明も undefined も出さない（issue #31）', () => {
  // 過去データに配合タイプが無いケース
  const noMode = [{ ...fixtures[0], mode: undefined }] as unknown as Offspring[];
  const h1 = build('mashup-000001', noMode);
  expect(h1.querySelector('.det-hero .badge.mode')?.textContent).toBe('配合タイプ不明');
  const note1 = h1.querySelector('.det-mode-note');
  expect(note1?.textContent).not.toContain('配合方法:'); // 説明を当てはめない
  expect(note1?.textContent).not.toContain('2つの発明'); // 単純配合の説明を勝手に足さない
  expect(h1.textContent).not.toContain('undefined'); // 「undefined」表示の防止
  expect(h1.textContent).not.toContain('fusion'); // 生値も出さない

  // 未知の値（実在しない配合タイプ名）
  const unknown = [{ ...fixtures[0], mode: 'simple' }] as unknown as Offspring[];
  const h2 = build('mashup-000001', unknown);
  expect(h2.querySelector('.det-hero .badge.mode')?.textContent).toBe('配合タイプ不明');
  expect(h2.querySelector('.det-mode-note')?.textContent).not.toContain('配合方法:');
});

// --- 技術・分野タグ（issue #38 §8） ------------------------------------------

it('技術・分野タグを表示し、押すと一覧の該当条件の検索へ移動する（issue #38）', () => {
  const withTags = [
    {
      ...fixtures[0],
      technologies: ['Dify', 'IoT'],
      domains: ['教育・学習'],
    },
  ] as unknown as Offspring[];
  const host = build('mashup-000001', withTags);
  const section = host.querySelector('.det-tags');
  expect(section).toBeTruthy();
  const chips = Array.from(host.querySelectorAll<HTMLAnchorElement>('.det-tag-row a.tag-chip'));
  expect(chips.map((a) => a.textContent)).toEqual(['Dify', 'IoT', '教育・学習']);
  // リンクは一覧の検索URL（リポジトリ名やドメインをハードコードしない）
  expect(chips[0].getAttribute('href')).toBe('/ideas/?tech=Dify');
  expect(chips[1].getAttribute('href')).toBe('/ideas/?tech=IoT');
  expect(chips[2].getAttribute('href')).toBe('/ideas/?domain=%E6%95%99%E8%82%B2%E3%83%BB%E5%AD%A6%E7%BF%92');
  expect(chips[2].getAttribute('data-kind')).toBe('domain');
  expect(host.textContent).toContain('タグを押すと、その条件でアイデア一覧を検索します。');
});

it('タグが無い既存データには「技術・分野タグ」の見出し自体を出さない（issue #38）', () => {
  const legacy = [{ ...fixtures[0], technologies: undefined, domains: undefined }] as unknown as Offspring[];
  const host = build('mashup-000001', legacy);
  expect(host.querySelector('.det-tags')).toBeNull();
  expect(host.textContent).not.toContain('技術・分野タグ');
  // それ以外のセクションはいつもどおり
  expect(host.querySelector('.det-title')).toBeTruthy();
});

it('空配列のタグも見出しを出さない（空の区画を作らない / issue #38）', () => {
  const empty = [{ ...fixtures[0], technologies: [], domains: [] }] as unknown as Offspring[];
  const host = build('mashup-000001', empty);
  expect(host.querySelector('.det-tags')).toBeNull();
});

// --- 配合申請者のGitHubアイコン+ユーザー名（issue #42） ----------------------

it('requester があるとき「配合を申し込んだ人」を表示する（issue #42）', () => {
  const withReq = [
    {
      ...fixtures[0],
      requester: {
        login: 'test-user',
        avatarUrl: 'https://avatars.githubusercontent.com/u/123456?v=4',
      },
    },
  ] as unknown as Offspring[];
  const host = build('mashup-000001', withReq);
  const chip = host.querySelector<HTMLAnchorElement>('.det-hero-main .requester-chip');
  expect(chip).toBeTruthy();
  expect(chip?.getAttribute('href')).toBe('https://github.com/test-user');
  expect(chip?.getAttribute('target')).toBe('_blank');
  expect(chip?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(chip?.textContent).toContain('配合を申し込んだ人: @test-user');
  const img = chip?.querySelector('img');
  expect(img?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/123456?v=4');
  // 悪意あるloginでもURLエンコードで壊さない（XSSの面も含めて）
  const weird = [
    { ...fixtures[0], requester: { login: 'a-b', avatarUrl: 'https://avatars.githubusercontent.com/u/9' } },
  ] as unknown as Offspring[];
  const host2 = build('mashup-000001', weird);
  expect(host2.querySelector('.requester-chip')?.getAttribute('href')).toBe('https://github.com/a-b');
});

it('requester が無い・不正な既存データでは表示しない（issue #42）', () => {
  const host = build('mashup-000001'); // サンプルデータに requester は無い
  expect(host.querySelector('.requester-chip')).toBeNull();
  // 不正な avatarUrl（GitHubのCDN以外）は表示ごと省く fail-safe
  const bad = [
    {
      ...fixtures[0],
      requester: { login: 'test-user', avatarUrl: 'https://evil.example.com/u/1' },
    },
  ] as unknown as Offspring[];
  const host2 = build('mashup-000001', bad);
  expect(host2.querySelector('.requester-chip')).toBeNull();
  // login の書式が不正でも省く
  const badLogin = [
    { ...fixtures[0], requester: { login: 'bad login!', avatarUrl: 'https://avatars.githubusercontent.com/u/1' } },
  ] as unknown as Offspring[];
  const host3 = build('mashup-000001', badLogin);
  expect(host3.querySelector('.requester-chip')).toBeNull();
});
