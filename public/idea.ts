import './style.css';
import type { Offspring, ParentId, ProtopediaWork } from '../lib/types.ts';
import { BLEND_MODE_LABELS } from '../lib/types.ts';
import { repoConfigFromEnv } from '../lib/config.ts';
import { formatDateTimeJSTWithNote } from '../lib/datetime.ts';
import rawOffspring from '../data/offspring.json';
import rawPool from '../data/sample-prototypes.json';
import rawSampleWorks from '../data/protopedia-sample.json';
import rawCandidates from '../data/current-candidates.json';

/**
 * /ideas/<id>/ — 発明の個別詳細ページ（issue #24）。
 *
 * > 一覧は発見の場、個別ページは詳しい情報と誕生の経緯の場。
 * > 個別ページを中心に、親作品・子孫・配合申請・系譜図を行き来できる構成にする。
 *
 * - URLは静的ホスティングで直接開けること（ビルド時に vite.config.ts の ideaPages
 *   プラグインが data/offspring.json の各IDぶんの index.html を生成する）。
 * - 外部入力はHTMLとして挿入せず、必ずテキストノード経由で描画する（XSS対策）。
 * - データ欠損（親メタデータ不在・画像なし・任意フィールド無し）でも画面を壊さない。
 */

const offspring = (rawOffspring as unknown as Offspring[]).slice();

// 親（ProtoPedia作品）のメタデータ参照元: 実プール + サンプル + 現在の候補。
const works: ProtopediaWork[] = [
  ...(rawPool as unknown as { works: ProtopediaWork[] }).works,
  ...(rawSampleWorks as unknown as { works: ProtopediaWork[] }).works,
  ...((rawCandidates as { candidates: ProtopediaWork[] }).candidates ?? []),
];

const repoCfg = repoConfigFromEnv({
  VITE_GITHUB_OWNER: import.meta.env.VITE_GITHUB_OWNER,
  VITE_GITHUB_REPO: import.meta.env.VITE_GITHUB_REPO,
  GITHUB_REPOSITORY: typeof __GITHUB_REPOSITORY__ !== 'undefined' ? __GITHUB_REPOSITORY__ : '',
});

const THEME_KEY = 'mashup-theme';
type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'light') return t;
  const mq =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;
  return mq ? 'dark' : 'light';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

export interface IdeaDetailContext {
  /** Issueリンク用。未設定なら元Issueのリンクは出さない（一覧と同じ）。 */
  repoCfg: { owner: string; repo: string } | null;
  /** サイトルートへの基点（'/' や '/<repo>/'、相対base時は '../../'）。 */
  base: string;
  /** 親（ProtoPedia作品）のメタデータ参照元。無い親はID+出典URLだけで表示する。 */
  works: ProtopediaWork[];
}

/** 個別ページのURL（サイトルート基点）。 */
export function ideaDetailHref(base: string, id: string): string {
  return `${base}ideas/${encodeURIComponent(id)}/`;
}

/**
 * URLパスから発明IDを取り出す（`/ideas/mashup-000001/` → `mashup-000001`）。
 * /ideas/ 直下（一覧）や該当なしは null。
 */
export function ideaIdFromPath(pathname: string): string | null {
  const m = /\/ideas\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  return id.startsWith('mashup-') ? id : null;
}

/** 相対base運用時のサイトルート基点。このページは /ideas/<id>/ に置かれる。 */
export function siteBaseFor(pathname: string, baseUrl: string): string {
  if (baseUrl.startsWith('/')) return baseUrl; // 絶対base（VITE_BASE指定時）
  return /\/ideas\/[^/]+\/?$/.test(pathname) ? '../../' : './';
}

/** サムネイル（大きめ）。画像なし・読み込み失敗は共通プレースホルダで枠を保つ。 */
function thumbBox(c: Offspring, base: string, cls: string): HTMLElement {
  const box = el('div', { class: cls });
  if (c.imagePath) {
    const img = el('img', {
      src: `${base}${c.imagePath}`,
      alt: `${c.title}のサムネイル（AIが生成した画像）`,
      loading: 'lazy',
    });
    img.addEventListener('error', () => box.replaceChildren(el('span', { class: 'thumb-miss' }, '画像なし')));
    box.append(img);
  } else {
    box.append(el('span', { class: 'thumb-miss' }, '画像なし'));
  }
  return box;
}

/** ProtoPedia親の作品画像（取得失敗は枠だけで壊れないよう取り除く）。 */
function workImage(w: ProtopediaWork): HTMLElement | null {
  if (!w.mainUrl) return null;
  const box = el('div', { class: 'det-parent-media' });
  const img = el('img', {
    src: w.mainUrl,
    alt: `${w.title}の作品画像（ProtoPedia）`,
    loading: 'lazy',
  });
  img.addEventListener('error', () => box.replaceChildren(el('span', { class: 'thumb-miss' }, '画像なし')));
  box.append(img);
  return box;
}

/** 親カード（左右配置 / issue #24 §4）。欠損を吸収して表示する。 */
function parentCard(
  id: ParentId,
  role: '親A' | '親B',
  ctx: IdeaDetailContext,
  list: Offspring[],
  titleOf: Map<string, string>,
): HTMLElement {
  const card = el('div', { class: 'det-parent' }, el('span', { class: 'det-parent-role' }, role));

  if (id.startsWith('protopedia:')) {
    const w = ctx.works.find((x) => x.id === id);
    const protoNum = id.slice('protopedia:'.length);
    const sourceUrl = w?.sourceUrl ?? `https://protopedia.net/prototype/${protoNum}`;
    const title = w?.title ?? id;
    const media = w ? workImage(w) : null;
    if (media) card.append(media);
    card.append(
      el(
        'h3',
        {},
        el('a', { href: sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, title),
      ),
      el('p', { class: 'det-parent-kind hint' }, 'ProtoPedia作品（第0世代・実作品）'),
    );
    if (w?.authors && w.authors.length > 0) {
      card.append(el('p', { class: 'det-parent-authors' }, `作者: ${w.authors.join(' / ')}`));
    }
    if (w?.sample) {
      card.append(el('p', { class: 'hint' }, '開発用サンプル（実在のProtoPedia作品ではありません）'));
    }
    card.append(
      el(
        'p',
        {},
        el('a', { href: sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'ProtoPediaで見る ↗'),
      ),
    );
    return card;
  }

  // mashup-* の親 = すでに生まれた子作品 → その個別ページへ（相互遷移）。
  const child = list.find((x) => x.id === id);
  const title = child?.title ?? titleOf.get(id) ?? id;
  if (child) {
    card.append(thumbBox(child, ctx.base, 'det-parent-media'));
    card.append(
      el(
        'h3',
        {},
        el('a', { href: ideaDetailHref(ctx.base, id) }, title),
      ),
      el(
        'p',
        { class: 'det-parent-kind hint' },
        `AIが考えた未実装のアイデア（第${child.generation}世代・子作品）`,
      ),
    );
    if (child.sample) {
      card.append(el('p', { class: 'hint' }, '開発用サンプル（実在の生成結果ではありません）'));
    }
    card.append(
      el('p', {}, el('a', { href: ideaDetailHref(ctx.base, id) }, 'この発明の個別ページへ →')),
    );
  } else {
    // データ不在でもIDだけは示す（壊さない・リンクは404相当画面へ）
    card.append(el('h3', {}, el('a', { href: ideaDetailHref(ctx.base, id) }, id)));
    card.append(el('p', { class: 'det-parent-kind hint' }, '子作品（詳細データ未読込）'));
  }
  return card;
}

/** セクション（見出し + 中身）。中身の有無は呼び出し側のガードで確認済み。 */
function section(title: string, ...body: (Node | string)[]): HTMLElement {
  return el('section', { class: 'det-section' }, el('h3', { class: 'det-h' }, title), ...body);
}

/** 個別ページ本体を host に構築する（テストから直接呼けるよう純関数寄りに）。 */
export function buildIdeaDetail(
  host: HTMLElement,
  id: string,
  list: Offspring[],
  ctx: IdeaDetailContext,
): void {
  host.replaceChildren();

  const titleOf = new Map<string, string>();
  for (const w of ctx.works) titleOf.set(w.id, w.title);
  for (const c of list) titleOf.set(c.id, c.title);

  const wrap = el('div', { class: 'wrap' });
  host.append(wrap);

  // --- ヘッダー（一覧と同型: 見出し + コピー + テーマ切替 + 戻る） -----------
  const themeBtn = el('button', { class: 'theme-toggle', type: 'button' }) as HTMLButtonElement;
  const updateThemeBtn = (): void => {
    const t = currentTheme();
    themeBtn.textContent = t === 'dark' ? 'ライトにする' : 'ダークにする';
    themeBtn.setAttribute(
      'aria-label',
      `表示テーマを切り替える（現在: ${t === 'dark' ? 'ダーク' : 'ライト'}）`,
    );
  };
  themeBtn.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* プライベートモード等では保存できないが表示は切り替わる */
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#202735' : '#FFF5DE');
    updateThemeBtn();
  });

  wrap.append(
    el(
      'header',
      { class: 'hero' },
      el(
        'div',
        { class: 'hero-top' },
        el(
          'div',
          {},
          el('h1', {}, '発明の詳細'),
          el('p', { class: 'copy' }, 'この発明は、どんな親から生まれたのか。'),
          el(
            'p',
            { class: 'ideas-back' },
            el('a', { href: `${ctx.base}ideas/` }, '← アイデア一覧へ戻る'),
            ' / ',
            el('a', { href: ctx.base }, '研究所トップへ'),
          ),
        ),
        themeBtn,
      ),
    ),
  );
  updateThemeBtn();

  const c = list.find((x) => x.id === id);

  // --- 存在しないID → 404相当（一覧・トップへの導線あり / §7） ----------------
  if (!c) {
    wrap.append(
      el(
        'div',
        { class: 'notice window det-missing' },
        el('p', { class: 'empty-title' }, 'そのIDの発明は見つかりませんでした'),
        el(
          'p',
          {},
          `ID「${id || '（未指定）'}」は存在しないか、まだ生まれていません。一覧から探してみてください。`,
        ),
        el(
          'p',
          {},
          el('a', { href: `${ctx.base}ideas/` }, 'アイデア一覧へ →'),
          ' / ',
          el('a', { href: ctx.base }, '研究所トップへ →'),
        ),
      ),
    );
    wrap.append(detailFooter(ctx));
    document.title = '発明が見つかりません — Mashup Ours';
    return;
  }

  document.title = `${c.title} — Mashup Ours`;

  // --- 注意書き（一覧と同じ文言。実装済みと誤認させない） ---------------------
  wrap.append(
    el(
      'div',
      { class: 'notice window' },
      'ここに並ぶのは ',
      el('strong', {}, 'AIが考えた未実装の発明アイデア'),
      ' です。実際に製作したもの・実在の成果物ではありません。 ProtoPediaの元作品は出典リンク先を参照してください。',
    ),
  );
  if (c.sample) {
    wrap.append(
      el(
        'div',
        { class: 'notice warn window' },
        '開発用サンプルのデータを表示しています（実在の生成結果ではありません）。',
      ),
    );
  }

  // --- 基本情報（サムネイル大・発明名・概要を最も目立たせる） ----------------
  const badges = el('div', { class: 'idea-badges' },
    el('span', { class: 'badge idea' }, '未実装のアイデア'),
    el('span', { class: 'badge gen' }, `第${c.generation}世代`),
    el('span', { class: 'badge mode' }, BLEND_MODE_LABELS[c.mode] ?? c.mode),
  );
  if (c.sample) badges.append(el('span', { class: 'badge sample' }, 'SAMPLE'));

  const hero = el(
    'div',
    { class: 'det-hero' },
    thumbBox(c, ctx.base, 'det-thumb'),
    el(
      'div',
      { class: 'det-hero-main' },
      badges,
      el('h2', { class: 'det-title' }, c.title),
      el('p', { class: 'det-summary' }, c.summary || '（概要なし）'),
      el(
        'div',
        { class: 'det-meta hint' },
        `発明ID: ${c.id} ・ 誕生日時: ${formatDateTimeJSTWithNote(c.createdAt)}`,
      ),
    ),
  );
  wrap.append(el('section', {}, el('div', { class: 'lab-panel' }, hero)));

  // --- 親A・B（左右配置で継承関係を視覚化 / §6） ----------------------------
  const parents = el('div', { class: 'det-parents' });
  parents.append(parentCard(c.parents[0], '親A', ctx, list, titleOf));
  parents.append(parentCard(c.parents[1], '親B', ctx, list, titleOf));
  wrap.append(
    el(
      'section',
      { class: 'lab-panel det-panel' },
      el(
        'div',
        { class: 'lab-head' },
        el('div', { class: 'lab-titles' }, el('h2', {}, '親となった発明'), el('p', { class: 'lab-sub' }, 'PARENTS')),
      ),
      parents,
    ),
  );

  // --- AIによる配合結果（継承・仕組み・利用シーン・技術構成） -----------------
  const result = el('div', { class: 'det-result' });

  const traitItems = (c.inheritedTraits ?? []).filter((t) => t && t.trait);
  if (traitItems.length > 0) {
    const ul = el('ul', { class: 'det-list' });
    for (const t of traitItems) {
      ul.append(el('li', {}, `${t.trait}（${titleOf.get(t.parentId) ?? t.parentId} から）`));
    }
    result.append(section('継承した特徴', ul));
  }
  if (c.mechanism) result.append(section('仕組み・技術構成', el('p', {}, c.mechanism)));
  if (c.useCases && c.useCases.length > 0) {
    const ul = el('ul', { class: 'det-list' });
    for (const u of c.useCases) ul.append(el('li', {}, u));
    result.append(section('利用シーン', ul));
  }
  if (c.concept) result.append(section('詳細説明（利用場面）', el('p', {}, c.concept)));
  if (c.whyInteresting) result.append(section('面白さ・意外性', el('p', {}, c.whyInteresting)));
  if (c.implementationSketch) {
    result.append(section('最小プロトタイプの製作案', el('p', {}, c.implementationSketch)));
  }
  if (c.model) result.append(section('生成モデル', el('p', { class: 'hint' }, c.model)));

  wrap.append(
    el(
      'section',
      { class: 'lab-panel det-panel' },
      el(
        'div',
        { class: 'lab-head' },
        el(
          'div',
          { class: 'lab-titles' },
          el('h2', {}, 'AIによる配合結果'),
          el('p', { class: 'lab-sub' }, 'BLENDED BY AI'),
        ),
      ),
      result,
    ),
  );

  // --- 子孫（個別ページを起点に行き来できるようにする / 最重要事項） -----------
  const kids = list.filter((k) => (k.parents ?? []).includes(c.id as ParentId));
  const kidBody = el('div', { class: 'det-kids' });
  if (kids.length === 0) {
    kidBody.append(el('p', { class: 'hint' }, 'まだ子供の発明は生まれていません。この発明を親に選んで配合を申し込めます。'));
  } else {
    const ul = el('ul', { class: 'det-list' });
    for (const k of kids) {
      ul.append(
        el(
          'li',
          {},
          el('a', { href: ideaDetailHref(ctx.base, k.id) }, k.title),
          ` （第${k.generation}世代・${k.summary || '概要なし'}）`,
        ),
      );
    }
    kidBody.append(ul);
  }
  wrap.append(
    el(
      'section',
      { class: 'lab-panel det-panel' },
      el(
        'div',
        { class: 'lab-head' },
        el('div', { class: 'lab-titles' }, el('h2', {}, 'この発明から生まれた子'), el('p', { class: 'lab-sub' }, 'OFFSPRING')),
      ),
      kidBody,
    ),
  );

  // --- 関連リンク（Issue / 系譜図 / 一覧 / 配合申請） -------------------------
  const links = el('ul', { class: 'det-links' });
  if (ctx.repoCfg && c.sourceIssue > 0) {
    links.append(
      el(
        'li',
        {},
        el(
          'a',
          {
            href: `https://github.com/${ctx.repoCfg.owner}/${ctx.repoCfg.repo}/issues/${c.sourceIssue}`,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          `元の配合申請 Issue #${c.sourceIssue} ↗`,
        ),
      ),
    );
  }
  // 系譜図へは「この発明を選択した状態」で飛ぶ（?id= ディープリンク / §5）。
  links.append(
    el('li', {}, el('a', { href: `${ctx.base}?id=${encodeURIComponent(c.id)}` }, '発明の系譜図で見る →')),
  );
  links.append(el('li', {}, el('a', { href: `${ctx.base}ideas/` }, 'アイデア一覧へ戻る →')));
  links.append(
    el('li', {}, el('a', { href: `${ctx.base}#candidates` }, '研究所トップで次の配合を申し込む →')),
  );
  wrap.append(
    el(
      'section',
      { class: 'lab-panel det-panel' },
      el(
        'div',
        { class: 'lab-head' },
        el('div', { class: 'lab-titles' }, el('h2', {}, '関連リンク'), el('p', { class: 'lab-sub' }, 'LINKS')),
      ),
      links,
    ),
  );

  wrap.append(detailFooter(ctx));
}

function detailFooter(ctx: IdeaDetailContext): HTMLElement {
  return el(
    'footer',
    { class: 'ideas-foot hint' },
    el(
      'div',
      {},
      el('a', { href: ctx.base }, 'Mashup Ours トップへ'),
      ' — 20年分の発明を、もう一度マッシュアップ。',
    ),
    el(
      'div',
      { class: 'foot-note' },
      'Mashup Oursは個人制作の非公式プロジェクトです。ProtoPediaおよびヒーローズ・リーグの公式サービスではありません。',
    ),
  );
}

// 本番ページ（dist/ideas/<id>/index.html）では自動起動。テストは buildIdeaDetail を直接呼ぶ。
const hostEl = document.querySelector<HTMLElement>('#idea-app');
if (hostEl) {
  const base = siteBaseFor(window.location.pathname, import.meta.env.BASE_URL);
  // URLパス（/ideas/<id>/）が正。開発用の ?id= フォールバックも許容する。
  const id =
    ideaIdFromPath(window.location.pathname) ??
    new URLSearchParams(window.location.search).get('id') ??
    '';
  buildIdeaDetail(hostEl, id, offspring, { repoCfg, base, works });
}
