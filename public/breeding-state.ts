/**
 * 配合フローの状態判定（issue #11 / 追加指示 §3・§5・§7・最重要事項）。
 *
 * すべて純関数。ネットワークもDOMも持たない（取得は github-watch.ts、
 * 表示は character.ts、接続は main.ts）。
 *
 * 最重要事項: リアクションは実際の操作・処理状態と連動させる。
 * - `window.open` は「Issue作成画面を開いただけ」で、申請完了ではない（success にしない）。
 * - 申請完了（confirmed）は GitHub API が Issue を返したときだけ。
 * - 実験待ち（open Issue）と生成中（closed だが未公開）を区別する。
 * - 誕生（fresh）は公開済みの子作品の実データだけで判定する。
 */
import type { Offspring } from '../lib/types.ts';
import type { CharacterState } from './character.ts';
import { breedingFreqLabel, resolveSchedule } from '../lib/schedule.ts';
import rawSchedule from '../config/schedule.json';

// 頻度設定（config/schedule.json / issue #15）: 「1時間」固定ではなく設定値から表示する。
const { config: scheduleCfg } = resolveSchedule(rawSchedule);

/** GitHub の Issue 最小情報（API の items[] から取り出す項目のみ） */
export interface SeenIssue {
  number: number;
  /** 表示用タイトル（正規の入力は本文。ここでは照合の目印としてだけ使う） */
  title: string;
  /** 本文。親IDは本文の `parent_a:` / `parent_b:` 行だけで照合する */
  body: string;
  state: 'open' | 'closed';
  createdAt: string; // ISO 8601
}

export interface Pair {
  parentA: string;
  parentB: string;
}

/** キャラに渡す表示内容（state + セリフ） */
export interface CharView {
  state: CharacterState;
  message: string;
}

/** 表示用タイトルの形式（newIssueUrl と完全一致させる。信用はしない・照合の目印） */
export function breedTitle(pair: Pair): string {
  return `[Breed] ${pair.parentA} x ${pair.parentB}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 本文の `key: value` 行が1つ存在するか（行単位・前後空白許容） */
function hasBodyField(body: string, key: string, value: string): boolean {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*${escapeRegExp(value)}\\s*$`, 'm');
  return re.test(body);
}

/** タイトル一致 + 本文の親ID行一致 + 時間窓、で Issue を照合する */
export function findOpenedIssue(
  issues: SeenIssue[],
  pair: Pair,
  openedAtMs: number,
): SeenIssue | null {
  const title = breedTitle(pair);
  const candidates = issues
    .filter((i) => i.title.trim() === title)
    .filter((i) => Date.parse(i.createdAt) >= openedAtMs - 60_000)
    .filter((i) => hasBodyField(i.body, 'parent_a', pair.parentA))
    .filter((i) => hasBodyField(i.body, 'parent_b', pair.parentB))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return candidates[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * 申請確認フェーズ（Issue作成画面を開いた後）
 * ------------------------------------------------------------------ */

export type ApplyPhase = 'idle' | 'opening' | 'confirmed' | 'unconfirmed';

export function applyView(phase: ApplyPhase): CharView {
  switch (phase) {
    case 'opening':
      return {
        state: 'idle',
        message:
          '申し込み画面を開きました。内容を「送信」して初めて配合の申し込み完了です（開いただけでは申請になりません）。',
      };
    case 'confirmed':
      return {
        state: 'success',
        message: 'よし！配合の申し込みを受け付けたぞ！次の配合タイムで実験を待つのじゃ。',
      };
    case 'unconfirmed':
      return {
        state: 'idle',
        message:
          'まだ申し込みを確認できません。Issueを「送信」しましたか？ 送信済みなら少し待ってから再読み込みしてください。',
      };
    case 'idle':
      return {
        state: 'idle',
        message:
          '発明を2つえらんで「配合を申し込む」を押すと、申し込み（GitHub Issue）が始まります。',
      };
  }
}

/** 申請確認のポーリング間隔（ms）。合計 約3.5分・最大10回 — 無限ポーリングはしない */
export const CONFIRM_DELAYS_MS = [
  5_000, 5_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

/* ------------------------------------------------------------------ *
 * 観測フェーズ（公開データから実際の処理状態を知る）
 * ------------------------------------------------------------------ */

export type ObservePhase = 'nothing' | 'queued' | 'generating' | 'fresh';

export interface ObserveInput {
  issues: SeenIssue[];
  /** 本番の子作品のみ（sample は含めない。main.ts がビルド時 or ランタイム取得分を渡す） */
  offspring: Offspring[];
  nowMs: number;
  /** 誕生演出を表示する時間窓（ms）。既定 90分 */
  freshWindowMs?: number;
}

/**
 * 公開状態から実際のフェーズを判定。優先度: fresh > generating > queued > nothing。
 * - fresh: 直近に生まれた子作品が存在（本番データのみ）
 * - generating: closed Issue のうち未公開（= ワーカー処理中）
 * - queued: open Issue あり（= 実験待ち）
 */
export function observeBreeding(input: ObserveInput): ObservePhase {
  const born = input.offspring.filter((o) => !o.sample && o.sourceIssue > 0);
  const freshWindow = input.freshWindowMs ?? 90 * 60_000;
  let newestMs = 0;
  for (const o of born) {
    const t = Date.parse(o.createdAt);
    if (Number.isFinite(t) && t > newestMs) newestMs = t;
  }
  if (newestMs > 0 && input.nowMs - newestMs <= freshWindow) return 'fresh';

  const requests = input.issues.filter((i) => parseBreedIssueTitle(i.title) !== null);
  const published = new Set(born.map((o) => o.sourceIssue));
  if (requests.some((i) => i.state === 'closed' && !published.has(i.number))) {
    return 'generating';
  }
  if (requests.some((i) => i.state === 'open')) return 'queued';
  return 'nothing';
}

/** 表示用タイトルから親ペアを取り出す（照合の目印。本文はワーカー側で検証） */
export function parseBreedIssueTitle(title: string): Pair | null {
  const m = /^\[Breed\]\s+(\S+)\s+x\s+(\S+)\s*$/.exec(title.trim());
  if (!m) return null;
  const [, parentA, parentB] = m;
  if (parentA.length > 64 || parentB.length > 64) return null;
  return { parentA, parentB };
}

/**
 * 待機中の配合申請数（open な配合申請Issueの件数 / issue #48）。
 * 直近30件の観測から数える**近似値**（古い申請は反映されない・追加API呼び出しはしない）。
 */
export function countWaitingRequests(issues: readonly SeenIssue[]): number {
  return issues.filter((i) => i.state === 'open' && parseBreedIssueTitle(i.title) !== null).length;
}

export interface ObserveViews {
  /** 配合マシンの実験担当の博士 */
  higedaruma: CharView;
  /** トップの挨拶ウィンドウ（共通セリフ） */
  greeting: string;
  /** トップの2人の状態（誕生時だけ celebration） */
  bothState: CharacterState;
}

export function observeView(phase: ObservePhase): ObserveViews {
  switch (phase) {
    case 'fresh':
      return {
        higedaruma: { state: 'celebration', message: 'なんと！あた新しい発明が誕生したぞ！' },
        greeting: 'なんと！あた新しい発明が誕生したぞ！',
        bothState: 'celebration',
      };
    case 'generating':
      return {
        higedaruma: { state: 'thinking', message: '生成中: AIがあたらしい発明を考えています。' },
        greeting:
          '配合の実験中です。AIがあたらしい発明案を生成しています。しばらくお待ちください。',
        bothState: 'idle',
      };
    case 'queued':
      return {
        higedaruma: {
          state: 'idle',
          message: '配合待ち: 次の実験が始まるまで、もう少しじゃ！',
        },
        greeting: `配合待ちの発明があります。次の配合タイム（${breedingFreqLabel(scheduleCfg)}に最大1件・全員で共有）までお待ちください。`,
        bothState: 'idle',
      };
    case 'nothing':
      return {
        higedaruma: applyView('idle'),
        greeting: 'ようこそ！ここは発明を配合する研究所じゃ！',
        bothState: 'idle',
      };
  }
}

/** 状態観測ポーリング間隔（ms）。匿名GitHub APIは60req/hのため（Issue+子作品で最大40/h） */
export const OBSERVE_INTERVAL_MS = 180_000;
/** 観測ポーリングの上限回数（既定 = 6時間。以降は再読み込みで再開） */
export const OBSERVE_MAX_CYCLES = 120;
