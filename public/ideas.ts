import './style.css';
import type { Offspring, ParentId, ProtopediaWork } from '../lib/types.ts';
import { BLEND_MODE_LABELS } from '../lib/types.ts';
import { repoConfigFromEnv } from '../lib/config.ts';
import { formatDateTimeJSTWithNote } from '../lib/datetime.ts';
import { CANDIDATES_PER_SLOT, isCandidatesFile } from '../lib/candidates.ts';
import { intervalLabel, resolveSchedule } from '../lib/schedule.ts';
import rawOffspring from '../data/offspring.json';
import rawCandidates from '../data/current-candidates.json';
import sampleWorksJson from '../data/protopedia-sample.json';
import rawSchedule from '../config/schedule.json';

/**
 * /ideas — 生み出されたアイデア一覧（issue #8）。
 * トップ（src/main.ts）と同じデータソースから子作品を列挙する。
 * 外部入力はHTMLとして挿入せず、必ずテキストノード経由で描画する（XSS対策）。
 * URLは GitHub Pages の base パス（import.meta.env.BASE_URL）前提のリンクで組み、
 * リポジトリ名はハードコードしない。
 */

// 頻度設定（config/schedule.json / issue #15）: 間隔の文言は設定値から生成する。
const { config: scheduleCfg } = resolveSchedule(rawSchedule);

const offspring = (rawOffspring as unknown as Offspring[]).slice();
const sampleWorks = (sampleWorksJson as { works: ProtopediaWork[] }).works;
const candWorks = isCandidatesFile(
  rawCandidates,
  Math.max(scheduleCfg.maxCandidates, CANDIDATES_PER_SLOT),
)
  ? rawCandidates.candidates
  : [];

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

// 日時は lib/datetime.ts の共通関数で日本時間表示（issue #18 / JST統一）。
// 内部データ（createdAt）はUTCのまま、表示時のみ変換。不正値は「日時不明」。

export interface IdeasContext {
  /** Issueリンク用。未設定なら元Issueのリンクは出さない（トップと同じ）。 */
  repoCfg: { owner: string; repo: string } | null;
  /** サイトルートへの基点（'/' や '/<repo>/'、相対base時は '../'）。 */
  base: string;
}

/** 親の表示。ProtoPediaは出典URLへ、子作品はトップの詳細（?id=）へ戻す。 */
function parentRef(
  id: ParentId,
  base: string,
  titleOf: Map<string, string>,
): { text: string; href: string; external: boolean } {
  const text = titleOf.get(id) ?? id;
  if (id.startsWith('protopedia:')) {
    // URLはIDから導出する（https固定）。データ中の文字列をURLとして信用しない。
    return {
      text,
      href: `https://protopedia.net/prototype/${id.slice('protopedia:'.length)}`,
      external: true,
    };
  }
  // 子作品の親リンクは個別ページへ（issue #24: 個別ページを中心に親作品・子孫を行き来する）
  return { text, href: `${base}ideas/${encodeURIComponent(id)}/`, external: false };
}

function buildIdeaItem(
  c: Offspring,
  ctx: IdeasContext,
  titleOf: Map<string, string>,
): HTMLElement {
  const li = el('li', { class: 'idea-item', 'data-id': c.id });

  const badges = el('div', { class: 'idea-badges' }, el('span', { class: 'badge idea' }, '未実装のアイデア'));
  badges.append(el('span', { class: 'badge gen' }, `第${c.generation}世代`));
  badges.append(el('span', { class: 'badge mode' }, BLEND_MODE_LABELS[c.mode] ?? c.mode));
  if (c.sample) badges.append(el('span', { class: 'badge sample' }, 'SAMPLE'));

  const pa = parentRef(c.parents[0], ctx.base, titleOf);
  const pb = parentRef(c.parents[1], ctx.base, titleOf);
  const parentLink = (r: ReturnType<typeof parentRef>): HTMLElement => {
    const a = el('a', { href: r.href }, r.text);
    if (r.external) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    return a;
  };

  const meta = el(
    'div',
    { class: 'idea-meta hint' },
    `${c.id} ・ 誕生日時: ${formatDateTimeJSTWithNote(c.createdAt)}`,
  );

  // 個別詳細ページ（issue #24）: 一覧は発見の場 → 詳細は /ideas/<id>/ へ。
  const detailUrl = `${ctx.base}ideas/${encodeURIComponent(c.id)}/`;

  const foot = el('div', { class: 'idea-foot' });
  foot.append(el('a', { class: 'idea-detail', href: detailUrl }, 'この発明の詳細を見る →'));
  if (ctx.repoCfg && c.sourceIssue > 0) {
    foot.append(
      el(
        'a',
        {
          href: `https://github.com/${ctx.repoCfg.owner}/${ctx.repoCfg.repo}/issues/${c.sourceIssue}`,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        `生成Issue #${c.sourceIssue} ↗`,
      ),
    );
  }

  // サムネイル（issue #16 §12）。ctx.base はサイトルートへの基点（相対base時は '../'）。
  // 生成失敗（null）・読み込み失敗はプレースホルダーで枠を保つ。
  let thumb: HTMLElement | null = null;
  if (c.imagePath) {
    const box = el('div', { class: 'idea-thumb' });
    const img = el('img', {
      src: `${ctx.base}${c.imagePath}`,
      alt: `${c.title}のサムネイル（AIが生成した画像）`,
      loading: 'lazy',
    });
    img.addEventListener('error', () => box.replaceChildren(el('span', { class: 'thumb-miss' }, '画像なし')));
    box.append(img);
    thumb = box;
  } else if (c.imagePath === null) {
    thumb = el('div', { class: 'idea-thumb' }, el('span', { class: 'thumb-miss' }, '画像なし'));
  }

  // サムネイル・バッジ・発明名・概要を1つの <a> で包む = 個別ページへの遷移領域。
  // カード全体を <a> にしないのは**リンクの入れ子を避けるため**（親作品・Issueのリンクは
  // この <a> の外に置く）。実リンクなのでキーボード（Tab/Enter）でも操作できる。
  const open = el('a', { class: 'idea-open', href: detailUrl });
  if (thumb) open.append(thumb);
  open.append(
    badges,
    el('h3', { class: 'idea-title' }, c.title),
    el('p', { class: 'idea-summary' }, c.summary || '（概要なし）'),
  );

  li.append(
    open,
    el(
      'div',
      { class: 'idea-parents' },
      el('span', { class: 'lbl' }, '親: '),
      parentLink(pa),
      el('span', { class: 'cross' }, ' × '),
      parentLink(pb),
    ),
    meta,
    foot,
  );
  return li;
}

/** /ideas ページ本体を host に構築する（テストから直接呼けるよう純関数寄りに）。 */
export function buildIdeasPage(
  host: HTMLElement,
  list: Offspring[],
  ctx: IdeasContext,
): void {
  host.replaceChildren();

  // ID → タイトル（表示する一覧 + 読み込み済みの元作品）。無いIDはIDのまま表示する。
  const titleOf = new Map<string, string>();
  for (const w of sampleWorks) titleOf.set(w.id, w.title);
  for (const w of candWorks) titleOf.set(w.id, w.title);
  for (const c of list) titleOf.set(c.id, c.title);

  const wrap = el('div', { class: 'wrap' });
  host.append(wrap);

  // --- ヘッダー（トップと同型: h1 + コピー + テーマ切替 + 戻る） ---
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
          el('h1', {}, '生み出されたアイデア'),
          el('p', { class: 'copy' }, 'AIが考えた未実装の発明アイデアを、すべてここに。'),
          el('p', { class: 'ideas-back' }, el('a', { href: ctx.base }, '← 研究所トップへ戻る')),
        ),
        themeBtn,
      ),
    ),
  );
  updateThemeBtn();

  // --- 注意書き（トップと同じ文言。実装済みと誤認させない） ----------------
  wrap.append(
    el(
      'div',
      { class: 'notice window' },
      'ここに並ぶのは ',
      el('strong', {}, 'AIが考えた未実装の発明アイデア'),
      ' です。実際に製作したもの・実在の成果物ではありません。 ProtoPediaの元作品は出典リンク先を参照してください。',
    ),
  );

  if (list.some((c) => c.sample)) {
    wrap.append(
      el(
        'div',
        { class: 'notice warn window' },
        '開発用サンプルの子作品を表示しています（[SAMPLE] 表記・実在の生成結果ではありません）。',
      ),
    );
  }

  // --- 一覧パネル -----------------------------------------------------------
  const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const panel = el(
    'div',
    { class: 'lab-panel' },
    el(
      'div',
      { class: 'lab-head' },
      el(
        'div',
        { class: 'lab-titles' },
        el('h2', {}, 'アイデア一覧'),
        el('p', { class: 'lab-sub' }, 'ALL GENERATED IDEAS'),
      ),
      el('span', { class: 'chip' }, `全${sorted.length}件`),
    ),
  );

  if (sorted.length === 0) {
    panel.append(
      el(
        'div',
        { class: 'ideas-empty' },
        el('p', { class: 'empty-title' }, 'まだアイデアは生まれていません'),
        el(
          'p',
          {},
          `研究所トップで発明を2つえらんで「配合を申し込む」と、AIがあたらしい発明案を考えます。配合は${intervalLabel(scheduleCfg.breedingIntervalMinutes)}に最大1件（全員で共有）。`,
        ),
        el('p', {}, el('a', { href: ctx.base }, '研究所トップへ →')),
      ),
    );
  } else {
    const ul = el('ul', { class: 'ideas-list' });
    for (const c of sorted) ul.append(buildIdeaItem(c, ctx, titleOf));
    panel.append(ul);
  }

  wrap.append(el('section', {}, panel));
  wrap.append(
    el(
      'footer',
      { class: 'ideas-foot hint' },
      el(
        'div',
        {},
        el('a', { href: ctx.base }, 'Mashup Ours トップへ'),
        ' — 20年分の発明を、もう一度マッシュアップ。',
      ),
      // 非公式プロジェクトである旨（追加指示 §4）。このページで一度だけ。
      el(
        'div',
        { class: 'foot-note' },
        'Mashup Oursは個人制作の非公式プロジェクトです。ProtoPediaおよびヒーローズ・リーグの公式サービスではありません。',
      ),
      // リポジトリへのリンク（issue #30）。未設定時は出さない。
      ...(ctx.repoCfg
        ? [
            el(
              'div',
              { class: 'foot-links' },
              el(
                'a',
                {
                  href: `https://github.com/${ctx.repoCfg.owner}/${ctx.repoCfg.repo}`,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                },
                'GitHubリポジトリ ↗',
              ),
            ),
          ]
        : []),
    ),
  );
}

// 本番ページ（ideas/index.html）では自動起動。テストは buildIdeasPage を直接呼ぶ。
const hostEl = document.querySelector<HTMLElement>('#ideas-app');
if (hostEl) {
  // base が絶対（'/' や '/<repo>/'）ならそのまま。相対（'./'）ならこのページは
  // <root>/ideas/ にいるので、サイトルートへのリンクは '../'（ルート位置のページと
  // 決まりで解決）。どのドメイン・公開パスでも追従する。
  const siteBase = import.meta.env.BASE_URL.startsWith('/')
    ? import.meta.env.BASE_URL
    : '../';
  buildIdeasPage(hostEl, offspring, {
    repoCfg,
    base: siteBase,
  });
}
