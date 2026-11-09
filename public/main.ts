import './style.css';
import type { BreedingMode, Offspring, ParentId, ProtopediaWork } from '../lib/types.ts';
import {
  BLEND_MODE_DESCRIPTIONS,
  BLEND_MODE_LABELS,
  BREEDING_MODES,
} from '../lib/types.ts';
import { MAX_COMMENT_LENGTH } from '../lib/issue.ts';
import {
  JST_NOTE,
  formatDateTimeJST,
  formatSlotDateTimeJST,
  formatSlotRangeJST,
  jstNote,
} from '../lib/datetime.ts';
import { newIssueUrl, repoConfigFromEnv } from '../lib/config.ts';
import { CANDIDATES_PER_SLOT, isCandidatesFile, type CandidatesFile } from '../lib/candidates.ts';
import {
  breedingNotice,
  breedingShareText,
  candidateChipText,
  candidateNotice,
  intervalLabel,
  resolveSchedule,
} from '../lib/schedule.ts';
import rawSchedule from '../config/schedule.json';
import rawOffspring from '../data/offspring.json';
import rawCandidates from '../data/current-candidates.json';
import sampleWorksJson from '../data/protopedia-sample.json';
import rawPool from '../data/sample-prototypes.json';
import rawSampleOffspring from '../data/offspring.sample.json';
import { createCharacter } from './character.ts';
import {
  applyView,
  observeBreeding,
  observeView,
  OBSERVE_INTERVAL_MS,
  OBSERVE_MAX_CYCLES,
  type ApplyPhase,
  type ObservePhase,
} from './breeding-state.ts';
import { fetchSeenIssues, watchApplyConfirmation } from './github-watch.ts';

// ---------------------------------------------------------------------------
// データ読み込み
// ---------------------------------------------------------------------------

const offspring = (rawOffspring as unknown as Offspring[]).slice();
const sampleWorks = (sampleWorksJson as { works: ProtopediaWork[] }).works;
const sampleOffspring = (rawSampleOffspring as unknown as Offspring[]).slice();

// 頻度設定（config/schedule.json / issue #15）: 「1時間に1回」「15分ごと」の
// 固定文言はやめ、設定値から文言・次回時刻を生成する。
// 不正なら既定値で描画を続けエラーを告知（Worker側は同じ設定で exit 1 = 処理停止）。
const schedule = resolveSchedule(rawSchedule);
const scheduleCfg = schedule.config;
// 候補件数の上限を引き下げた直後の既存ファイルを壊さないよう、読み取りガードは max(設定, 既定)。
const candFileMax = Math.max(scheduleCfg.maxCandidates, CANDIDATES_PER_SLOT);

// 配合候補（data/current-candidates.json。Actions「Rotate candidates」が設定間隔で更新）。
// ブラウザからProtoPedia APIは呼ばない。ページ再読み込みで候補は変わらない。
// 形が想定外なら開発用サンプルに落とし、[SAMPLE] 表記で本番と明確に区別する。
const candidatesFile: CandidatesFile | null = isCandidatesFile(rawCandidates, candFileMax)
  ? rawCandidates
  : null;
const usingSampleCandidates = candidatesFile === null;
const candidates: ProtopediaWork[] = usingSampleCandidates
  ? sampleWorks
  : candidatesFile.candidates;

// 本番データが0件の間はサンプル子作品も表示する（系譜図が空にならないように。
// 各データは sample フラグ・[SAMPLE]表記つきで本番と明確に区別される）。
const showSampleOffspring = offspring.length === 0;
const children: Offspring[] = showSampleOffspring ? sampleOffspring : offspring;

const repoCfg = repoConfigFromEnv({
  VITE_GITHUB_OWNER: import.meta.env.VITE_GITHUB_OWNER,
  VITE_GITHUB_REPO: import.meta.env.VITE_GITHUB_REPO,
  GITHUB_REPOSITORY: typeof __GITHUB_REPOSITORY__ !== 'undefined' ? __GITHUB_REPOSITORY__ : '',
});

// ---------------------------------------------------------------------------
// ヘルパー（安全なDOM構築: 外部入力はHTMLとして挿入しない）
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'href') node.setAttribute('href', v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// 系譜図の完整性: 親作品が候補カードに入っていない場合も、系譜として描けるよう
// 参照だけ追加する（候補カードには表示しない）。
// - 実作品は data/sample-prototypes.json（候補プール12件）から。候補6件は15分ごとに入れ替わるため、
//   ここで外れた親が系譜図から消えないようにする（issue #21）。
// - 開発用ダミー（protopedia-sample.json 9001〜）はサンプル子作品の親用。
const candidateIds = new Set(candidates.map((c) => c.id));
const poolWorks = (rawPool as unknown as { works: ProtopediaWork[] }).works;
const supportWorks = [
  ...poolWorks.filter((w) => !candidateIds.has(w.id)),
  ...sampleWorks.filter((w) => !candidateIds.has(w.id)),
];
const allNodes: (ProtopediaWork | Offspring)[] = [...candidates, ...supportWorks, ...children];
const nodeById = new Map<string, ProtopediaWork | Offspring>(allNodes.map((n) => [n.id, n]));

function isOffspring(n: ProtopediaWork | Offspring | undefined): n is Offspring {
  return !!n && 'sourceIssue' in n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 親×親 → 子 を表すピクセルの交差ロゴ（色はテーマCSSに追従）。 */
function logoSprite(): SVGSVGElement {
  const cells: [number, number, string][] = [];
  const size = 16;
  for (let i = 0; i < 8; i++) {
    const c = i * 2;
    cells.push([c, c, i === 4 ? 'm0' : 'm2']); // \ 系
    cells.push([size - 2 - c, c, i === 4 ? 'm0' : 'm1']); // / 系
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'logo');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '40');
  svg.setAttribute('height', '40');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Mashup Ours ロゴ');
  for (const [x, y, cls] of cells) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', '2');
    rect.setAttribute('height', '2');
    rect.setAttribute('class', cls);
    svg.append(rect);
  }
  return svg;
}

function label(n: ProtopediaWork | Offspring | undefined): string {
  return n ? n.title : '(不明)';
}

// ---------------------------------------------------------------------------
// テーマ切替（ダーク / ライト）
// ---------------------------------------------------------------------------

const THEME_KEY = 'mashup-theme';

type Theme = 'dark' | 'light';

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark' || t === 'light') return t;
  const mq = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
  return mq ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------

const app = document.querySelector<HTMLDivElement>('#app')!;
const wrap = el('div', { class: 'wrap' });
app.append(wrap);

const themeBtn = el('button', { class: 'theme-toggle', type: 'button' }) as HTMLButtonElement;

function updateThemeBtn(): void {
  const t = currentTheme();
  themeBtn.textContent = t === 'dark' ? 'ライトにする' : 'ダークにする';
  themeBtn.setAttribute('aria-label', `表示テーマを切り替える（現在: ${t === 'dark' ? 'ダーク' : 'ライト'}）`);
}

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

// --- ファーストビュー（issue #14） -------------------------------------------
// 構成（上から順）: ①「Mashup Ours」（最も大きく）+ ②コピー → ③メインビジュアル
// （左=親Aカプセル / 中央=配合装置 / 右=親Bカプセル、パイプで接続、左右に研究員）→
// ④大見出し+補足 → ⑤ボタン「発明を配合する」「発明の系譜図を見る」。
// 参考画像はデザイン参考のみ。背景画像は敷かず、装置・カプセルはHTML/CSSで作る。
// 「16bit配合研究所」等のデザイン手法文言はFVから削除（issue #14 §1・§11）。
// 選択・Issue申請の動作は既存フロー（候補カード・発明配合マシン）をそのまま使う。

const heroLeft = el(
  'div',
  {},
  el(
    'div',
    { class: 'hero-title-row' },
    logoSprite(),
    // ロゴ右隣の読み仮名（issue #19）: Mashup Awards をもじった名前と伝わる小さめのカタカナ。
    // 英語ロゴが主・カタカナは添え書き。h1 の中には入れない（見出しの文言は "Mashup Ours" のまま）。
    el(
      'div',
      { class: 'hero-logo' },
      el('h1', {}, 'Mashup Ours'),
      el('span', { class: 'logo-yomi', lang: 'ja' }, '（マッシュアップアワーズ）'),
    ),
  ),
  el('p', { class: 'copy' }, '20年分の発明を、もう一度マッシュアップ。'),
);

wrap.append(
  el('header', { class: 'hero' }, el('div', { class: 'hero-top' }, heroLeft, themeBtn)),
);
updateThemeBtn();

// --- メインビジュアル: 左右カプセル + 中央配合装置 + 研究員2人（issue #14 §5・§6） ---
// キャラの状態は breeding-state.ts の観測結果だけが変える（操作と連動）。
// 最重要: 選択やカプセルの表示だけでAI配合処理は開始しない（実際の申請はGitHub Issue）。

const bannoGreet = createCharacter('banno');
const higeGreet = createCharacter('higedaruma');
// セリフウィンドウ（観測結果のあいさつが流れ続ける。長い技術説明はFVから削除）
const greetLead = el('p', { class: 'greet-lead' }, observeView('nothing').greeting);

const capsuleViewA: HTMLElement = el('div', { class: 'capsule-view' }, el('span', { class: 'capsule-q' }, '？'));
const capsuleViewB: HTMLElement = el('div', { class: 'capsule-view' }, el('span', { class: 'capsule-q' }, '？'));
const capsuleNameA = el('div', { class: 'capsule-name' }, '発明Aをえらんでね');
const capsuleNameB = el('div', { class: 'capsule-name' }, '発明Bをえらんでね');

/** カプセル1体（device=ドーム+覗き窓+台座 / tag / name はgrid各行へ配置）。 */
function buildFvCapsule(slot: 'a' | 'b', view: HTMLElement, name: HTMLElement): HTMLElement {
  return el(
    'div',
    { class: `capsule capsule-${slot}` },
    el(
      'div',
      { class: 'capsule-device' },
      el('div', { class: 'capsule-dome', 'aria-hidden': 'true' }),
      el('div', { class: 'capsule-tube' }, view),
      el('div', { class: 'capsule-base', 'aria-hidden': 'true' }),
    ),
    el('div', { class: 'capsule-tag' }, slot === 'a' ? '親となる発明 A' : '親となる発明 B'),
    name,
  );
}

// 中央の配合装置（画面×+操作盤+状態表示。状態文は updateFvLab が更新）
const fvStatus = el('div', { class: 'fv-status' }, 'スタンバイ中 — 発明を2つえらんでね');
const fvMachine = el(
  'div',
  { class: 'fv-machine' },
  el(
    'div',
    { class: 'fv-machine-body' },
    el('div', { class: 'fv-screen', 'aria-hidden': 'true' }, el('span', { class: 'fv-cross' }, '×')),
    el(
      'div',
      { class: 'fv-deck', 'aria-hidden': 'true' },
      el('span', { class: 'fv-key' }),
      el('span', { class: 'fv-key' }),
      el('span', { class: 'fv-key wide' }),
      el('span', { class: 'fv-lamp' }),
      el('span', { class: 'fv-lamp on' }),
    ),
  ),
  fvStatus,
);

const fvScene = el(
  'div',
  { class: 'lab-scene' },
  buildFvCapsule('a', capsuleViewA, capsuleNameA),
  el('div', { class: 'pipe pipe-a', 'aria-hidden': 'true' }),
  el('div', { class: 'lab-char left' }, bannoGreet.el),
  fvMachine,
  el('div', { class: 'lab-char right' }, higeGreet.el),
  el('div', { class: 'pipe pipe-b', 'aria-hidden': 'true' }),
  buildFvCapsule('b', capsuleViewB, capsuleNameB),
);

wrap.append(
  el(
    'div',
    { class: 'fv' },
    fvScene,
    el('div', { class: 'fv-greet window' }, greetLead),
    el(
      'div',
      { class: 'fv-dialog window' },
      el('p', { class: 'fv-lead' }, 'プロトタイプとプロトタイプを配合して、新しいアイデアを生み出そう！'),
      el(
        'p',
        { class: 'fv-sub' },
        'ProtoPediaに投稿された作品から2つを選ぶと、AIがそれぞれの特徴を組み合わせて、新しい発明アイデアを考えます。',
      ),
    ),
    el(
      'div',
      { class: 'fv-actions' },
      el('a', { class: 'fv-btn primary', href: '#candidates' }, '発明を配合する'),
      el('a', { class: 'fv-btn', href: '#pedigree' }, '発明の系譜図を見る'),
    ),
  ),
);

// --- 所長のメモ（セリフウィンドウ。キャラ画はMVP後に追加 / DESIGN.md §4） ---

wrap.append(
  el(
    'div',
    { class: 'memo window' },
    el('div', { class: 'titlebar' }, el('span', {}, '所長のメモ')),
    el('p', {}, `${candidateNotice(scheduleCfg)}2つえらんで「配合を申し込む」と、GitHub Issueの申し込み画面が開きます。`),
    el('p', {}, `${breedingNotice(scheduleCfg)}全ユーザー共有です。この組み合わせ、何が生まれるんだろう？ 生成されるのはすべてAIが考えた未実装のアイデアです。`),
  ),
);

// 注意書き
wrap.append(
  el(
    'div',
    { class: 'notice window' },
    '生成された子作品は ',
    el('strong', {}, 'AIが考えた未実装の発明アイデア'),
    ' です。実際に製作したもの・実在の成果物ではありません。 ProtoPediaの元作品は出典リンク先を参照してください。',
  ),
);

// サンプル表示中かどうか（owner/repo設定とは独立した条件）。
// 候補と子作品は別々に未同期になり得るので、表示場所ごとに正しく案内する。
if (candidates.some((w) => w.sample)) {
  wrap.append(
    el(
      'div',
      { class: 'notice warn window' },
      'ProtoPediaの候補データが未同期のため、候補は開発用サンプルです（[SAMPLE] 表記・実在の作品ではありません）。',
    ),
  );
}
if (children.some((c) => c.sample)) {
  wrap.append(
    el(
      'div',
      { class: 'notice warn window' },
      '子作品がまだ0件のため、「最近誕生した発明」と「発明の系譜図」には開発用サンプルを表示しています（[SAMPLE] 表記・実在の生成結果ではありません）。',
    ),
  );
}

if (!repoCfg) {
  wrap.append(
    el(
      'div',
      { class: 'notice error window' },
      'GitHub owner/repo が未設定です。.env.example を .env にコピーして VITE_GITHUB_OWNER / VITE_GITHUB_REPO を設定してください（配合の申し込みリンクは設定後に有効になります）。Actions では GITHUB_REPOSITORY から自動設定されます。',
    ),
  );
}
if (schedule.error) {
  wrap.append(
    el(
      'div',
      { class: 'notice error window' },
      `設定ファイル config/schedule.json が不正です（${schedule.error}）。表示は既定値（候補更新${intervalLabel(scheduleCfg.candidateRotationMinutes)}ごと・配合${intervalLabel(scheduleCfg.breedingIntervalMinutes)}ごと）で継続しています。`,
    ),
  );
}

// ---------------------------------------------------------------------------
// ① 今の15分枠の配合候補（1枠6件・全ユーザー共通。追加開発指示 §2/§3 / issue #10）
// ---------------------------------------------------------------------------

// 完成イメージ（tmp/CleanShot 2026-11-09 at 21.43.19.png）準拠:
// パネル見出し「本日の発明研究所」+ ラテン小見出し + 右上バッジ。
// その下に画像中心の3列カード（画像タイルが主役、キャプションは下に添える）。
// id=candidates / id=pedigree はFVボタン（issue #14）のアンカー先
const candSection = el('section', { class: 'cand-section', id: 'candidates' });
const stateBadge = el('span', { class: 'chip' });
const candMeta = el('div', { class: 'cand-meta' });
const grid = el('div', { class: 'candidates' });

// --- 親選択の案内（追加指示 §5: 親選択=案内役の博士） --------------------------
// 状態は「選択数」だけを反映する。success/thinking は実際の処理状態のときに
// だけ使う（ここでは触らない）。
const SELECT_MSGS: Record<number, string> = {
  0: 'この候補から、気になる発明を2つ選ぶのじゃ！「Aにする」「Bにする」のボタンでえらべます。',
  1: 'あと1つ！もう1つの発明を選んで配合しよう！',
  2: 'よし、2つえらべた！下の「配合を申し込む」を押すのじゃ！',
};
const bannoGuide = createCharacter('banno', { message: SELECT_MSGS[0] });

/** 候補スロット "YYYY-MM-DDTHHMM"（15分刻み）を時刻msへ（従来の時間枠 "YYYY-MM-DDTHH" も許容）。 */
function slotToDate(slot: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})?$/.exec(slot);
  if (!m) return Number.NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}:00Z`);
}

// 日時の表示はすべて lib/datetime.ts の共通関数経由（issue #18 / JST統一）。
// 内部キー（slot・ISO日時）はUTCのまま、画面に出すときだけ日本時間へ変換する。
// slotToDate は「予定時刻を過ぎたか」の判定に使う **UTCの絶対時刻**（表示には使わない）。

if (candidatesFile) {
  const f = candidatesFile;
  // 表示は日本時間（issue #18）。値の根拠は UTCキー（f.slot / f.nextSlot）のまま変更しない。
  // 不正値のときは「日時不明」となり、その場合だけ注記（日本時間）は付けない。
  const slotTxt = formatSlotRangeJST(f.slot, scheduleCfg.candidateRotationMinutes);
  const updatedTxt = formatDateTimeJST(f.generatedAt);
  // nextSlot はスロットキー（UTC "YYYY-MM-DDTHHMM"）なので ISO としてではなくキーとして解釈する
  const nextSlotTxt = formatSlotDateTimeJST(f.nextSlot);
  candMeta.append(
    el(
      'div',
      {},
      '現在の配合枠: ',
      el('span', { class: 'value' }, slotTxt),
      `${jstNote(slotTxt)}。右上のバッジと同じ枠で切り替わります`,
    ),
    el(
      'div',
      {},
      '最終更新: ',
      el('span', { class: 'value' }, updatedTxt),
      `${jstNote(updatedTxt)}（Actionsの実行結果）`,
    ),
    el(
      'div',
      {},
      '次の候補更新: ',
      el('span', { class: 'value' }, nextSlotTxt),
      `${jstNote(nextSlotTxt)}・更新予定（${intervalLabel(scheduleCfg.candidateRotationMinutes)}ごとに更新）`,
    ),
  );
  // Actionsの実行遅延はJSONの値（実行結果）ベースで表現する（端末時計で補完しない）。
  // ワークフローは15分間隔で起床し、スクリプトが設定間隔を判定してから
  // コミット→Pages反映する。その全行程＋GitHub側の遅延を耐える猶予（issue #15）。
  const UPDATE_GRACE_MS = 20 * 60_000;
  const nextMs = slotToDate(f.nextSlot);
  if (Number.isFinite(nextMs) && Date.now() > nextMs + UPDATE_GRACE_MS) {
    candMeta.append(
      el('div', { class: 'stale' }, '⚠ 候補更新が遅れています（Actionsの実行完了後に切り替わります）。'),
    );
  }
  if (f.candidates.length < scheduleCfg.maxCandidates) {
    candMeta.append(
      el('div', { class: 'hint' }, `現在の候補は${f.candidates.length}件です（最大${scheduleCfg.maxCandidates}件）。`),
    );
  }
} else {
  candMeta.append(
    el('div', { class: 'hint' }, `候補データ未同期: 開発用サンプル${candidates.length}件を表示中です。`),
  );
}
candMeta.append(
  el(
    'div',
    { class: 'hint' },
    `候補は${intervalLabel(scheduleCfg.candidateRotationMinutes)}ごとに差し替わります。ページを再読み込みしても候補は変わりません。`,
  ),
);
// 右上バッジ: サンプル表示中か本番候補かを常に見せる
stateBadge.textContent = usingSampleCandidates ? '開発用サンプル' : candidateChipText(scheduleCfg);
if (usingSampleCandidates) stateBadge.classList.add('chip-warn');

// --- 選択状態（親A / 親B） -------------------------------------------------

let pickA: string | null = null;
let pickB: string | null = null;

interface PickControls {
  /** 状態クラス（is-a / is-b）を付ける要素（候補カード or 子作品の行） */
  host: HTMLElement;
  /** 「親A選択中」バッジ（候補カードのみ。子作品の行には無し） */
  badge: HTMLElement | null;
  a: HTMLButtonElement;
  b: HTMLButtonElement;
}

const pickRegistry = new Map<string, PickControls>();

function pickButton(slot: 'a' | 'b', id: string, stopBubble: boolean): HTMLButtonElement {
  const btn = el(
    'button',
    {
      class: 'pick',
      type: 'button',
      'aria-pressed': 'false',
      'aria-label': `${slot === 'a' ? '親A' : '親B'}にする: ${label(nodeById.get(id))}`,
    },
    slot === 'a' ? 'Aにする' : 'Bにする',
  ) as HTMLButtonElement;
  btn.addEventListener('click', (e) => {
    if (stopBubble) e.stopPropagation(); // 子作品の行クリック（詳細表示）と競合させない
    togglePick(slot, id);
  });
  return btn;
}

function togglePick(slot: 'a' | 'b', id: string): void {
  if (slot === 'a') {
    pickA = pickA === id ? null : id;
    if (pickA && pickB === id) pickB = null; // 同じ作品をAとBに同時に指定しない
  } else {
    pickB = pickB === id ? null : id;
    if (pickB && pickA === id) pickA = null;
  }
  updateSelectionUI();
}

/** 作品カードのサムネイル枠。画像が無く・届かなくても枠は維持する（レイアウト崩れ防止）。 */
function thumbNode(w: ProtopediaWork): HTMLElement {
  const box = el('div', { class: 'thumb' });
  const placeholder = () => box.replaceChildren(el('div', { class: 'thumb-ph' }, '画像なし'));
  if (!w.mainUrl) {
    placeholder();
    return box;
  }
  const img = el('img', {
    src: w.mainUrl,
    alt: `${w.title}の作品画像（ProtoPedia）`,
    loading: 'lazy',
  }) as HTMLImageElement;
  img.addEventListener('error', () => {
    img.remove();
    placeholder();
  });
  box.append(img);
  return box;
}

function buildCandidateCard(w: ProtopediaWork, index: number): HTMLElement {
  const card = el('article', { class: 'candidate', 'data-id': w.id });
  card.append(thumbNode(w));

  const badge = el('span', { class: 'badge pick-state' }, '');
  badge.hidden = true; // 選択中のみ表示（色だけに依存せずテキストで状態を示す）

  const idx = el('div', { class: 'card-index' }, `作品 No.${String(index + 1).padStart(2, '0')}`);
  const h3 = el('h3', {}, w.title, badge);
  const author = el(
    'div',
    { class: 'author' },
    w.authors && w.authors.length > 0 ? `作者: ${w.authors.join(' / ')}` : '作者: （不明）',
  );
  const summary = el('p', { class: 'summary' }, w.summary || '（概要なし）');
  const link = el('a', { href: w.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'ProtoPediaで見る ↗');

  const btnA = pickButton('a', w.id, false);
  const btnB = pickButton('b', w.id, false);
  const picks = el('div', { class: 'picks' }, btnA, btnB);
  const foot = el('div', { class: 'card-foot' }, link, picks);

  const body = el('div', { class: 'card-body' }, idx, h3, author, summary, foot);
  card.append(body);

  pickRegistry.set(w.id, { host: card, badge, a: btnA, b: btnB });
  return card;
}

candidates.forEach((w, i) => grid.append(buildCandidateCard(w, i)));
if (candidates.length === 0) {
  grid.append(el('div', { class: 'empty' }, '候補がありません（データ未同期です）。'));
}
candSection.append(
  el(
    'div',
    { class: 'lab-panel' },
    el(
      'div',
      { class: 'lab-head' },
      el(
        'div',
        { class: 'lab-titles' },
        el('h2', {}, '本日の発明研究所'),
        el('p', { class: 'lab-sub' }, 'LAB / INVENTION CANDIDATES'),
      ),
      stateBadge,
    ),
    candMeta,
    grid,
    el('div', { class: 'cand-guide' }, bannoGuide.el),
  ),
);
wrap.append(candSection);

// ---------------------------------------------------------------------------
// ② 配合マシン（選択状態・申請・稼働状況・配合待ち）
// ---------------------------------------------------------------------------

const machineSection = el('section', {}, el('h2', {}, '発明配合マシン'));

const statusA = el('span', { class: 'status-val empty' }, '（未選択）');
const statusB = el('span', { class: 'status-val empty' }, '（未選択）');
const statusRow = el(
  'div',
  { class: 'status-row' },
  el('div', { class: 'side' }, el('span', { class: 'side-label' }, '親A'), statusA),
  el('span', { class: 'cross', 'aria-hidden': 'true' }, '×'),
  el('div', { class: 'side' }, el('span', { class: 'side-label' }, '親B'), statusB),
);

// 稼働状況と配合待ち（DESIGN.md §1: ファーストビュー圏で分かるように）。
// 固定の「1時間枠」表記はやめ、config/schedule.json の間隔から次回の目安を計算する
//（仕様は「間隔を空けて最大1件」。Actionsの遅延・失敗でずれる場合があるため目安と明示）。
const breedingIntervalMs = scheduleCfg.breedingIntervalMinutes * 60_000;
const lastBirthMs = children
  .filter((c) => !c.sample)
  .reduce((max, c) => Math.max(max, Date.parse(c.createdAt) || 0), 0);
const nextBreedingHint =
  lastBirthMs === 0
    ? 'まだ配合の成功記録がありません（最初の申請を順次受け付けています）。'
    : Date.now() < lastBirthMs + breedingIntervalMs
      ? `次の配合の目安: ${formatDateTimeJST(lastBirthMs + breedingIntervalMs)}${JST_NOTE}（前回の誕生から間隔を空けて処理）。`
      : '次の配合はただちに処理できます（申請の順次処理）。';
const statusNote = el(
  'div',
  { class: 'slot' },
  el(
    'div',
    {},
    '配合の間隔（設定値）: ',
    el('span', { class: 'value' }, intervalLabel(scheduleCfg.breedingIntervalMinutes)),
    '。',
    nextBreedingHint,
  ),
  el('div', {}, breedingShareText(scheduleCfg)),
  repoCfg
    ? el(
        'div',
        {},
        '配合待ちの申し込みは公開Issueで確認できます: ',
        el(
          'a',
          {
            href: `https://github.com/${repoCfg.owner}/${repoCfg.repo}/issues?q=is%3Aissue+state%3Aopen`,
            target: '_blank',
            rel: 'noopener',
          },
          '配合待ちのIssue一覧 →',
        ),
      )
    : el('div', { class: 'empty' }, '配合待ちのIssue一覧はリポジトリ設定後に表示されます。'),
);

// --- 配合タイプと研究員へのひとこと（issue #16 / 追加開発指示 §4・§5） ---------
// どちらもIssue本文へ記録される（このページからAIを直接呼ぶことはしない）。
const modeSelect = el('select', { class: 'blend-mode', id: 'blend-mode' }) as HTMLSelectElement;
for (const m of BREEDING_MODES) {
  modeSelect.append(el('option', { value: m }, `${BLEND_MODE_LABELS[m]}（${m}）`));
}
modeSelect.value = 'fusion'; // 初期値: 単純配合
const modeDesc = el('p', { class: 'hint mode-desc' }, BLEND_MODE_DESCRIPTIONS.fusion);
modeSelect.addEventListener('change', () => {
  const m = modeSelect.value as BreedingMode;
  modeDesc.textContent = BLEND_MODE_DESCRIPTIONS[m] ?? BLEND_MODE_DESCRIPTIONS.fusion;
});

const commentInput = el('input', {
  class: 'breed-comment',
  type: 'text',
  id: 'breed-comment',
  maxlength: String(MAX_COMMENT_LENGTH),
  placeholder: '例：子どもが遊べる発明にしてほしい！',
  autocomplete: 'off',
}) as HTMLInputElement;

const applyFields = el(
  'div',
  { class: 'apply-fields' },
  el('div', { class: 'field mode-field' },
    el('label', { for: 'blend-mode' }, '配合タイプ'),
    modeSelect,
    modeDesc,
  ),
  el('div', { class: 'field comment-field' },
    el('label', { for: 'breed-comment' }, `研究員へのひとこと（任意・最大${MAX_COMMENT_LENGTH}文字）`),
    commentInput,
    el(
      'p',
      { class: 'hint' },
      '配合の動機や希望を1行で。公開Issueに記録され、生成の追加条件として使われます。',
    ),
  ),
);

const breedBtn = el('button', { class: 'breed', type: 'button' }, '配合を申し込む') as HTMLButtonElement;
const hint = el('span', { class: 'hint' });
const actions = el('div', { class: 'actions' }, breedBtn, hint);

const machineHint = el(
  'div',
  { class: 'hint catalog' },
  usingSampleCandidates
    ? '候補は開発用サンプルです（実在の作品ではありません）。'
    : '候補カードの「Aにする」「Bにする」で、気になる発明を2つえらべます。',
);

// --- 発明配合マシンの博士（追加指示 §5: 申し込み・実験結果の案内役） --------
// どの状態を出すかは applyView（申請フロー）/ observeView（公開データ観測）が決める。
const higeMachine = createCharacter('higedaruma', { message: applyView('idle').message });

let applyPhase: ApplyPhase = 'idle';

function setApplyPhase(phase: ApplyPhase): void {
  applyPhase = phase;
  const v = applyView(phase);
  higeMachine.setState(v.state);
  higeMachine.setMessage(v.message);
  updateFvLab(); // FV装置の状態表示も申請フェーズに追従（issue #14 §7）
}

const machine = el(
  'div',
  { class: 'machine window' },
  el(
    'div',
    { class: 'titlebar' },
    el('span', {}, '発明配合マシン'),
    el(
      'span',
      { class: 'lamps', 'aria-hidden': 'true' },
      el('span', { class: 'lamp mint' }),
      el('span', { class: 'lamp yellow' }),
      el('span', { class: 'lamp coral' }),
    ),
  ),
  machineHint,
  statusRow,
  statusNote,
  applyFields,
  actions,
  el('div', { class: 'machine-char' }, higeMachine.el),
);
machineSection.append(machine);
wrap.append(machineSection);

function pickText(id: string | null): string {
  if (!id) return '（未選択）';
  const n = nodeById.get(id);
  return n ? `${n.title} (${id})` : id;
}

function currentPair(): [ParentId, ParentId] | null {
  if (!pickA || !pickB || pickA === pickB) return null;
  return [pickA as ParentId, pickB as ParentId];
}

// --- FVカプセル・装置の連動（issue #14 §6・§7） -------------------------------
// 選択状態・申請フェーズ・観測フェーズをカプセルの覗き窓と装置の状態表示へ反映する。
// ※ カプセルの表示や2選択だけでAI配合処理は開始しない（実際の申請はGitHub Issue）。

/** カプセル覗き窓を親選択に合わせて描き直す（未選択=「？」、無画像は8bitプレースホルダー）。 */
function renderFvCapsule(
  view: HTMLElement,
  name: HTMLElement,
  id: string | null,
  emptyName: string,
): void {
  if (!id) {
    view.replaceChildren(el('span', { class: 'capsule-q' }, '？'));
    name.textContent = emptyName;
    return;
  }
  const n = nodeById.get(id);
  name.textContent = n ? n.title : id;
  // 子作品は出典画像を持たない → プレースホルダー。ProtoPedia親は作品画像（読み込み失敗時も同様）。
  const url = n && !isOffspring(n) && n.mainUrl ? n.mainUrl : null;
  if (!url) {
    view.replaceChildren(el('span', { class: 'capsule-q' }, '？'));
    return;
  }
  const img = el('img', { src: url, alt: '' });
  img.addEventListener('error', () => {
    view.replaceChildren(el('span', { class: 'capsule-q' }, '？'));
  });
  view.replaceChildren(img);
}

/** 装置の状態表示文（§7 状態表。Issue作成画面を開いただけ=申請成功にしない）。 */
function fvStatusText(): string {
  if (applyPhase === 'opening') return '申請手続き中 — Issue作成画面で「送信」してね';
  if (applyPhase === 'confirmed') return '配合申請受付！ 次の配合の処理を待つのじゃ';
  if (applyPhase === 'unconfirmed') return '実験失敗？ 申請をまだ確認できません — 送信したか確認してもう一度読み込んでね';
  if (observedPhase === 'fresh') return '新しい発明が誕生したぞ！';
  if (observedPhase === 'generating') return '配合実験中 — AIが新しい発明を考えています';
  if (observedPhase === 'queued') return '配合待ち — 次の配合枠まで待つのじゃ';
  const selected = (pickA ? 1 : 0) + (pickB ? 1 : 0);
  if (selected === 2) return '配合準備完了！ 「発明を配合する」から申し込むのじゃ';
  if (selected === 1) return 'あと1つ — もう一方のカプセルに入れてね';
  return 'スタンバイ中 — 発明を2つえらんでね';
}

/** FV全体（カプセル・装置・状態文）を選択と処理状態に連動させる。 */
function updateFvLab(): void {
  renderFvCapsule(capsuleViewA, capsuleNameA, pickA, '発明Aをえらんでね');
  renderFvCapsule(capsuleViewB, capsuleNameB, pickB, '発明Bをえらんでね');
  fvStatus.textContent = fvStatusText();
  // 2作品そろい・申請フロー中でなく・実験中でもない = 「配合準備完了」（短い光/点滅）
  const busy =
    applyPhase !== 'idle' || observedPhase === 'fresh' || observedPhase === 'generating';
  fvMachine.classList.toggle('is-ready', currentPair() !== null && !busy);
}

function refreshBreedButton(): void {
  const pair = currentPair();
  breedBtn.disabled = !pair || !repoCfg;
  if (!pair) {
    hint.textContent =
      pickA && pickB && pickA === pickB
        ? '親Aと親Bは別の発明を選んでください。'
        : '発明を2つえらぶと、GitHub Issueの申し込み画面が開きます。';
  } else if (!repoCfg) {
    hint.textContent = 'owner/repo未設定のため申し込めません（上の案内を参照）。';
  } else {
    hint.textContent = `${pair[0]} × ${pair[1]}${
      candidatesFile
        ? `（現在の配合枠 ${formatSlotRangeJST(candidatesFile.slot, scheduleCfg.candidateRotationMinutes)}${JST_NOTE}）`
        : ''
    } の組み合わせで配合を申し込みます。`;
  }
}

function updateSelectionUI(): void {
  for (const [id, c] of pickRegistry) {
    const isA = pickA === id;
    const isB = pickB === id;
    c.host.classList.toggle('is-a', isA);
    c.host.classList.toggle('is-b', isB);
    c.a.setAttribute('aria-pressed', String(isA));
    c.b.setAttribute('aria-pressed', String(isB));
    if (c.badge) {
      c.badge.hidden = !(isA || isB);
      c.badge.textContent = isA ? '親A選択中' : isB ? '親B選択中' : '';
    }
  }
  statusA.textContent = pickText(pickA);
  statusA.classList.toggle('empty', !pickA);
  statusB.textContent = pickText(pickB);
  statusB.classList.toggle('empty', !pickB);
  const selected = (pickA ? 1 : 0) + (pickB ? 1 : 0);
  bannoGuide.setMessage(SELECT_MSGS[selected]);
  refreshBreedButton();
  updateFvLab(); // FVカプセルへ選択を反映（issue #14 §6）
}

// ライブ観測のガード（追加指示 §10 / 最重要事項）:
// - テスト（vitest）では一切の実通信をしない（ui.test が main.ts を起動し続ける）。
// - owner/repo 未設定でも観測はしない。
// - 3回連続失敗・レート制限で観測を止める（無限リトライしない）。
const canWatch =
  import.meta.env.MODE !== 'test' && typeof fetch === 'function' && repoCfg !== null;

let cancelApplyWatch: (() => void) | null = null;
let observeTimer: ReturnType<typeof setInterval> | undefined;
let observeFailures = 0;
let observeCycles = 0;

/** 公開データ（Issue + 子作品）から実際の処理状態を観測してキャラに反映する。 */
async function refreshObservation(): Promise<void> {
  if (!repoCfg) return;
  try {
    const [issues, runtimeOffspring] = await Promise.all([
      fetchSeenIssues(repoCfg),
      fetchRuntimeOffspring(),
    ]);
    observeFailures = 0;
    applyObservation(
      observeBreeding({ issues, offspring: runtimeOffspring, nowMs: Date.now() }),
    );
    if (observedPhase === 'fresh') stopObservation(); // 誕生演出のあとは停止
  } catch {
    observeFailures += 1;
    if (observeFailures >= 3) stopObservation(); // 表示は現状のまま維持する
  }
}

function stopObservation(): void {
  if (observeTimer !== undefined) {
    clearInterval(observeTimer);
    observeTimer = undefined;
  }
}

let observedPhase: ObservePhase = 'nothing';

/** 観測結果をキャラ・挨拶文へ反映する（申請フロー中は申請の真実が優先）。 */
function applyObservation(phase: ObservePhase): void {
  observedPhase = phase;
  const view = observeView(phase);
  if (applyPhase === 'idle') {
    higeMachine.setState(view.higedaruma.state);
    higeMachine.setMessage(view.higedaruma.message);
  }
  bannoGreet.setState(view.bothState);
  higeGreet.setState(view.bothState);
  greetLead.textContent = view.greeting;
  updateFvLab(); // FV装置の状態表示も観測結果に追従（issue #14 §7）
}

/**
 * ランタイムの子作品（ビルド後に生まれた誕生を知るため data/offspring.json を読む。
 * vite.config.ts の emit プラグインが dist へ出す）。失敗時はビルド時データのまま。
 * 不正な項目は取り込まない（JSONは外部入力。表示には本文を流し込まない）。
 */
async function fetchRuntimeOffspring(): Promise<Offspring[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/offspring.json`);
    if (!res.ok) return offspring;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return offspring;
    const out: Offspring[] = [];
    for (const item of data as Offspring[]) {
      if (
        item &&
        typeof item.id === 'string' &&
        typeof item.createdAt === 'string' &&
        typeof item.sourceIssue === 'number' &&
        !item.sample
      ) {
        out.push(item);
      }
    }
    return out;
  } catch {
    return offspring;
  }
}

breedBtn.addEventListener('click', () => {
  const pair = currentPair();
  if (!pair || !repoCfg) return;
  const wa = nodeById.get(pair[0]);
  const wb = nodeById.get(pair[1]);
  window.open(
    newIssueUrl(repoCfg, pair[0], pair[1], {
      slot: candidatesFile?.slot,
      parentAUrl: wa && !isOffspring(wa) ? wa.sourceUrl : undefined,
      parentBUrl: wb && !isOffspring(wb) ? wb.sourceUrl : undefined,
      // 配合タイプと研究員へのひとこと（issue #16）。Issue本文へ1行ずつ記録される。
      mode: modeSelect.value,
      comment: commentInput.value.trim() || undefined,
    }),
    '_blank',
    'noopener',
  );
  // 最重要事項: 画面を開いただけでは申請完了ではない → success にしない。
  // GitHub API が Issue を確認できたときだけ confirmed（success 表示）になる。
  setApplyPhase('opening');
  if (canWatch) {
    cancelApplyWatch?.();
    cancelApplyWatch = watchApplyConfirmation(
      repoCfg,
      { parentA: pair[0], parentB: pair[1] },
      Date.now(),
      (result) => setApplyPhase(result),
    );
  }
});

// ---------------------------------------------------------------------------
// ③ 最近誕生した発明（直近の配合結果）
// ---------------------------------------------------------------------------

const listSection = el(
  'section',
  {},
  el(
    'h2',
    {},
    '最近誕生した発明 ',
    // 一覧ページへの導線（issue #8）。BASE_URL前提の相対リンクでリポジトリ名を固定しない。
    el('a', { href: `${import.meta.env.BASE_URL}ideas/` }, 'アイデア一覧 (/ideas) →'),
  ),
);
const list = el('ul', { class: 'offspring' });

/**
 * AI生成サムネイル（issue #16 / 追加開発指示 §12）。
 * imagePath はサイトルート相対パス。生成失敗（null）・読み込み失敗はプレースホルダー。
 * 外部データの alt は textNode 経由（el の append は文字列 → テキストノード）。
 */
function offspringThumb(c: Offspring, base: string, cls: string): HTMLElement {
  const box = el('div', { class: cls });
  if (c.imagePath) {
    const img = el('img', {
      src: `${base}${c.imagePath}`,
      alt: `${c.title}のサムネイル（AIが生成した画像）`,
      loading: 'lazy',
    });
    img.addEventListener('error', () =>
      box.replaceChildren(el('span', { class: 'thumb-miss' }, '画像なし')),
    );
    box.append(img);
  } else {
    // imagePath === null は「画像生成に失敗してテキストのみ保存」の明示的な状態
    box.append(el('span', { class: 'thumb-miss' }, '画像なし'));
  }
  return box;
}

const sorted = [...children].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
if (sorted.length === 0) {
  list.append(el('li', { class: 'empty' }, 'まだ子作品は生まれていません。'));
} else {
  for (const c of sorted) {
    const li = el('li', {});
    li.append(offspringThumb(c, import.meta.env.BASE_URL, 'li-thumb'));
    const main = el(
      'div',
      { class: 'li-main' },
      el(
        'div',
        { class: 'title' },
        c.title,
        el('span', { class: 'badge idea' }, '未実装のアイデア'),
        el('span', { class: 'badge mode' }, BLEND_MODE_LABELS[c.mode] ?? c.mode),
        c.sample ? el('span', { class: 'badge sample' }, 'SAMPLE') : '',
      ),
      el('div', { class: 'hint' }, c.summary),
      el(
        'div',
        { class: 'hint' },
        `${c.id} ・ 第${c.generation}世代 ・ ${c.parents[0]} × ${c.parents[1]}`,
      ),
    );
    li.append(main);
    li.addEventListener('click', () => selectNode(c.id));
    // 子作品も親にできる（AGENTS.md の完成形）。カードと同じ A/B 操作で選択できる。
    const btnA = pickButton('a', c.id, true);
    const btnB = pickButton('b', c.id, true);
    main.append(el('div', { class: 'li-picks' }, btnA, btnB));
    pickRegistry.set(c.id, { host: li, badge: null, a: btnA, b: btnB });
    list.append(li);
  }
}
listSection.append(list);
wrap.append(listSection);

// --- 系譜図 -----------------------------------------------------------------

const pedSection = el(
  'section',
  { id: 'pedigree' }, // FVボタン「発明の系譜図を見る」のアンカー先（issue #14）
  el('h2', {}, '発明の系譜図'),
  el(
    'p',
    { class: 'ped-desc hint' },
    'どの発明から、どんな発明が生まれたのか。配合を重ねて広がっていく、発明のつながりをたどってみよう。',
  ),
);
// 色だけに依存させない: 凡例 + 破線/実線の形アクセントで区別する
// 追加指示 §5: 系譜図はキャラの補助表示（完全装飾 = aria-hidden。character.ts が付与）
const pedChar = createCharacter('banno', { decorative: true });
pedChar.el.classList.add('ped-char');
const legend = el(
  'div',
  { class: 'pedigree-legend' },
  el('span', { class: 'key' }, el('span', { class: 'swatch proto' }), 'ProtoPedia作品（実線・第0世代）'),
  el('span', { class: 'key' }, el('span', { class: 'swatch child' }), 'AI生成アイデア（破線・未実装）'),
  el('span', { class: 'scroll-hint' }, '横スクロールで発明のつながりをたどれます'),
  pedChar.el,
);
const pedScroll = el('div', { class: 'pedigree-scroll window' });
const detailBox = el('div', { class: 'detail window' }, el('p', { class: 'empty' }, '発明をクリックすると、どんな発明から生まれたのか見られるぞ。'));
pedSection.append(legend, pedScroll, detailBox);
wrap.append(pedSection);

// 非公式プロジェクトである旨を一度だけ明示（追加指示 §4。注意書きは画面全体に繰り返さない）
wrap.append(
  el(
    'footer',
    { class: 'site-foot hint' },
    'Mashup Oursは個人制作の非公式プロジェクトです。ProtoPediaおよびヒーローズ・リーグの公式サービスではありません。',
  ),
);

interface LayoutNode {
  id: string;
  x: number;
  y: number;
  gen: number;
}

const NODE_W = 240;
const NODE_H = 44;
const COL_W = 300;
const NODE_FONT = 13;

/** フォント幅の概算（本文 = Noto Sans JP想定: 全角 ≈ fontSize、半角 ≈ 0.6 × fontSize）。 */
function estTextWidth(s: string, fontSize = NODE_FONT): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) < 0x80 ? fontSize * 0.6 : fontSize;
  return w;
}

/** ノード枠に収まるよう文字単位で切り詰める（固定文字数ではなく幅で判定）。 */
function truncateToWidth(s: string, maxWidth: number, fontSize = NODE_FONT): string {
  if (estTextWidth(s, fontSize) <= maxWidth) return s;
  let out = '';
  for (const ch of s) {
    if (estTextWidth(out + ch + '…', fontSize) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}
const ROW_H = 76;

const edges: [string, string][] = [];
for (const c of children) {
  for (const p of c.parents) edges.push([p, c.id]);
}

const involved = new Set<string>();
for (const [p, c] of edges) {
  involved.add(p);
  involved.add(c);
}
// 子がいない場合も第0世代の作品は見えるようにする
const visibleNodes = involved.size > 0
  ? allNodes.filter((n) => involved.has(n.id))
  : allNodes;

const byGen = new Map<number, (ProtopediaWork | Offspring)[]>();
for (const n of visibleNodes) {
  const g = isOffspring(n) ? n.generation : 0;
  const arr = byGen.get(g) ?? [];
  arr.push(n);
  byGen.set(g, arr);
}

const layout = new Map<string, LayoutNode>();
let maxY = 0;
for (const [gen, nodes] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
  nodes.forEach((n, i) => {
    layout.set(n.id, { id: n.id, x: 30 + gen * COL_W, y: 30 + i * ROW_H, gen });
    maxY = Math.max(maxY, 30 + i * ROW_H);
  });
}

const svgW = 30 + (Math.max(0, ...[...layout.values()].map((n) => n.gen)) + 1) * COL_W;
const svgH = maxY + NODE_H + 40;

function renderPedigree(): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(svgW));
  svg.setAttribute('height', String(svgH));
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);

  for (const [p, c] of edges) {
    const from = layout.get(p);
    const to = layout.get(c);
    if (!from || !to) continue;
    const path = document.createElementNS(SVG_NS, 'path');
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'edge');
    svg.append(path);
  }

  for (const n of layout.values()) {
    const node = nodeById.get(n.id);
    if (!node) continue;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `node ${isOffspring(node) ? 'child' : 'proto'}`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${node.title}（${n.id}）`);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(n.x));
    rect.setAttribute('y', String(n.y));
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    const hoverTitle = document.createElementNS(SVG_NS, 'title');
    hoverTitle.textContent = `${node.title} — ${node.summary}`;
    const text = document.createElementNS(SVG_NS, 'text');
    const title = truncateToWidth(node.title, NODE_W - 24);
    text.setAttribute('x', String(n.x + 12));
    text.setAttribute('y', String(n.y + NODE_H / 2 + 4));
    text.textContent = title;
    g.append(rect, hoverTitle, text);
    g.addEventListener('click', () => selectNode(n.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectNode(n.id);
      }
    });
    svg.append(g);
  }

  pedScroll.replaceChildren(svg);
}

function renderDetail(id: string): void {
  const node = nodeById.get(id);
  if (!node) return;
  const dl = el('dl', {});
  const add = (term: string, value: Node | string) => {
    dl.append(el('dt', {}, term), el('dd', {}, value));
  };

  const badges = el('div', {});
  /** サムネイル（issue #16 §12）。旧データはキー自体が無い（何も出さない）。 */
  let media: HTMLElement | null = null;
  if (isOffspring(node)) {
    badges.append(el('span', { class: 'badge idea' }, 'AIが考えた未実装の発明アイデア'));
    badges.append(el('span', { class: 'badge mode' }, BLEND_MODE_LABELS[node.mode] ?? node.mode));
    if (node.sample) badges.append(el('span', { class: 'badge sample' }, 'SAMPLE'));
    if (node.imagePath) {
      const img = el('img', {
        class: 'detail-thumb',
        src: `${import.meta.env.BASE_URL}${node.imagePath}`,
        alt: `${node.title}のサムネイル（AIが生成した画像）`,
        loading: 'lazy',
      });
      img.addEventListener('error', () => {
        media?.replaceChildren(el('span', { class: 'thumb-miss' }, '画像の読み込みに失敗しました'));
      });
      media = el('div', { class: 'detail-thumb-wrap' }, img);
    } else if (node.imagePath === null) {
      media = el(
        'div',
        { class: 'detail-thumb-wrap' },
        el('span', { class: 'thumb-miss' }, 'サムネイルなし（画像生成に失敗したため、アイデアのテキストのみ保存）'),
      );
    }
  } else if (node.sample) {
    badges.append(el('span', { class: 'badge sample' }, '開発用サンプル'));
  }

  add('概要', node.summary);

  if (isOffspring(node)) {
    add('配合タイプ', BLEND_MODE_LABELS[node.mode] ?? node.mode);
    add('コンセプト', node.concept);
    add('仕組み', node.mechanism);
    if (node.useCases && node.useCases.length > 0) {
      const cases = el('ul', {});
      for (const u of node.useCases) cases.append(el('li', {}, u));
      add('利用場面', cases);
    }
    const traits = el('ul', {});
    for (const t of node.inheritedTraits) {
      traits.append(el('li', {}, `${label(nodeById.get(t.parentId))} から「${t.trait}」を継承`));
    }
    add('継承した特徴', traits);
    const parentsList = el('ul', {});
    for (const p of node.parents) {
      const li = el('li', {});
      const btn = el('button', { class: 'linkish', type: 'button' }, label(nodeById.get(p)));
      btn.addEventListener('click', () => selectNode(p));
      li.append(btn, ` (${p})`);
      parentsList.append(li);
    }
    add('親', parentsList);
    const kids = children.filter((c) => c.parents.includes(node.id as ParentId));
    add(
      '子',
      kids.length > 0
        ? kids.map((k) => k.title).join(' / ')
        : '（まだいません）',
    );
    if (node.sample) {
      add('出典', '開発用サンプルデータ（実在の生成結果ではありません）');
    } else if (repoCfg && node.sourceIssue > 0) {
      add(
        '生成Issue',
        el(
          'a',
          {
            href: `https://github.com/${repoCfg.owner}/${repoCfg.repo}/issues/${node.sourceIssue}`,
            target: '_blank',
            rel: 'noopener',
          },
          `Issue #${node.sourceIssue}`,
        ),
      );
    }
    const birthTxt = formatDateTimeJST(node.createdAt);
    add('誕生日時', `${birthTxt}${jstNote(birthTxt)} ・ モデル: ${node.model}`);
  } else {
    add('世代', '第0世代（ProtoPedia作品）');
    if (node.authors && node.authors.length > 0) add('作者', node.authors.join(' / '));
    if (node.tags && node.tags.length > 0) add('タグ', node.tags.join(' / '));
    if (node.licenseType) add('ライセンス', node.licenseType);
    if (node.mainUrl) {
      const img = el('img', {
        src: node.mainUrl,
        alt: `${node.title}の作品画像（ProtoPedia）`,
        loading: 'lazy',
      });
      // 画像が届かない場合は枠だけで壊れないように取り除く
      img.addEventListener('error', () => img.remove());
      add('作品画像', img);
    }
    add('出典', el('a', { href: node.sourceUrl, target: '_blank', rel: 'noopener' }, node.sourceUrl));
    if (node.sample) {
      add('注意', '開発用の架空サンプル作品です。実在のProtoPedia作品ではありません。');
    }
  }

  detailBox.replaceChildren(el('h3', {}, node.title), badges, ...(media ? [media] : []), dl);
}

function selectNode(id: string): void {
  renderDetail(id);
  detailBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

renderPedigree();
updateSelectionUI();

// --- 公開状態の観測開始（issue #10〜 §10: 実際の処理状態とキャラを連動） -----
// 匿名API 60req/h のため OBSERVE_INTERVAL_MS（3分、最大40req/h）。
// テスト環境・未設定時は実通信しない。3回連続失敗 / fresh / 上限回数で停止。
if (canWatch && repoCfg) {
  void refreshObservation();
  observeTimer = setInterval(() => {
    observeCycles += 1;
    if (observeCycles >= OBSERVE_MAX_CYCLES) {
      stopObservation();
      return;
    }
    void refreshObservation();
  }, OBSERVE_INTERVAL_MS);
}

// ?id= ディープリンク（/ideas の「系譜図で詳細を見る」から戻る用 / issue #8）。
// 無効・未知のIDは無視して初期表示のまま。
const initialId = new URLSearchParams(window.location.search).get('id');
if (initialId && nodeById.has(initialId)) selectNode(initialId);
