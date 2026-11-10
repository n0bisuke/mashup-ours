/**
 * 自動配合申請の判定と親ペアの選出。（issue #27）
 *
 * 「直近 autoRequestIdleHours（既定8時間）に配合申請がなければ、システム側で
 * 配合申請Issueを1件自動追加する」ための純関数群。このモジュールは
 * **生成AIを呼ばない**（選出は乱数だけで行う。AIは子の生成でのみ使う）。
 *
 * 要件:
 * - 直近の申請判定は open/closed・自動/人手を問わず、配合申請に見える Issue のみ
 *   （機能追加・バグ報告などのIssueは「申請」と数えない）。
 * - 未処理の open 申請があれば積み増さしない（詰まったキューを悪化させない）。
 * - 自動作成した Issue 自体が次の判定で「直近の申請」になる → 最大でも1枠1件。
 * - 親ペアはワーカーの却下条件と**同じ条件**を満たすものだけを選ぶ
 *   （別ID / 生成済みペアでない / 系譜上 祖先×子孫でない）。
 *
 * このモジュールは純関数のみ（Node依存なし）。ネットワーク・ファイルは持たない。
 */
import { isAncestorDescendantPair } from './generation.ts';
import { samePair } from './issue.ts';
import { looksLikeBreedingIssue, MAX_FAILED_ATTEMPTS, type IssueRecord, type ProcessedIssues } from './queue.ts';
import type { IssueForm } from './config.ts';

/** 自動作成した申請であることを示す本文マーカー（人間・スクリプト双方の目印）。 */
export const AUTO_REQUEST_MARKER = '<!-- mashup-ours: auto-request -->';
/** 本文に書き込む選出方法の記録。パーサーは未知のフィールドを無視するため処理には影響しない。 */
export const AUTO_REQUEST_SOURCE = 'auto-random';
/** 親として使えるID形式（ワーカーのバリデーションと同じ）。 */
const PARENT_ID = /^(protopedia:\d{1,9}|mashup-\d{1,9})$/;
/** 有効ペアを探す検査回数の上限（巨大プールで全数走査しないため）。 */
export const MAX_PAIR_CHECKS = 500;

/** 自動申請のIssue本文かどうか（マーカーで判定。タイトル・ラベルは信用しない）。 */
export function isAutoRequestIssue(body: string): boolean {
  return typeof body === 'string' && body.includes(AUTO_REQUEST_MARKER);
}

export interface AutoRequestDecision {
  create: boolean;
  /** ログ用の理由（create どちらでも必ず返す。秘密情報は含めない）。 */
  reason: string;
}

export interface AutoRequestInput {
  /** 直近の Issue（state=all・新しい順）。配合申請に見えるものだけ「直近の申請」と数える。 */
  recent: readonly IssueRecord[];
  /** open の Issue（state=open）。未処理の申請があると積み増さしない。 */
  open: readonly IssueRecord[];
  processed: ProcessedIssues;
  /** config/schedule.json の autoRequestIdleHours（時間・0 = 無効）。 */
  idleHours: number;
  now?: Date;
}

/**
 * 自動申請を作るべきか判定する。
 * 作成条件（すべて満たす）:
 * 1. autoRequestIdleHours が 1 以上（0 は無効）。
 * 2. 直近 idleHours 時間以内に配合申請に見える Issue が1件もない。
 * 3. 未処理（failed 上限未満を含む）の open 申請が残っていない。
 */
export function shouldCreateAutoRequest(input: AutoRequestInput): AutoRequestDecision {
  const idleHours = input.idleHours;
  if (!Number.isFinite(idleHours) || idleHours <= 0) {
    return { create: false, reason: '自動申請が無効です（autoRequestIdleHours: 0）' };
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const cutoff = nowMs - idleHours * 3_600_000;

  for (const issue of input.recent) {
    if (!looksLikeBreedingIssue(issue)) continue;
    const createdMs = Date.parse(issue.createdAt);
    if (!Number.isFinite(createdMs)) continue; // 日時が読めないものは判断材料にしない
    if (createdMs >= cutoff) {
      return {
        create: false,
        reason: `直近${idleHours}時間以内に配合申請 #${issue.number} がある`,
      };
    }
  }

  for (const issue of input.open) {
    if (!looksLikeBreedingIssue(issue)) continue;
    const entry = input.processed[String(issue.number)];
    if (!entry) {
      return { create: false, reason: `未処理の配合申請 #${issue.number} が open のまま` };
    }
    if (entry.status === 'failed' && entry.attempts < MAX_FAILED_ATTEMPTS) {
      return { create: false, reason: `失敗中の配合申請 #${issue.number} が再試行待ち` };
    }
    // resolved / rejected / 失敗上限超過は「処理は終わっている」とみなして次へ。
  }

  return { create: true, reason: `${idleHours}時間以上 配合申請がないため自動申請を作成する` };
}

export interface AutoPairInput {
  /** 親候補のID（現行の配合候補 + すでに生まれた子作品）。重複・不正IDは吸収される。 */
  pool: readonly string[];
  /** すでに生成済みの親ペア（同じ組み合わせは選ばない）。 */
  offspringPairs: ReadonlyArray<readonly [string, string]>;
  /** 系譜のエッジ（parent → child）。祖先×子孫の組み合わせは選ばない。 */
  edges: ReadonlyArray<readonly [string, string]>;
  /** 乱数（テスト注入用・既定 Math.random）。AIは使わない。 */
  rng?: () => number;
  /** 有効ペアを探す検査回数の上限（既定 MAX_PAIR_CHECKS）。 */
  maxChecks?: number;
}

/**
 * プールから親ペアを**ランダムに**選ぶ（生成AIは使わない / issue #27）。
 * - プールを Fisher–Yates でシャッフルし、先頭から有効なペアを1つ返す。
 * - 有効条件: 別ID / すでに生成済みのペアでない / 系譜上 祖先×子孫でない。
 * - プール2件未満・有効ペア0件・検査上限超過は null（呼び出し側は作成しない）。
 */
export function selectAutoPair(input: AutoPairInput): [string, string] | null {
  const rng = input.rng ?? Math.random;
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const id of input.pool) {
    if (typeof id !== 'string' || !PARENT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    pool.push(id);
  }
  if (pool.length < 2) return null;

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }

  const maxChecks = input.maxChecks ?? MAX_PAIR_CHECKS;
  let checks = 0;
  for (let i = 0; i < pool.length - 1; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (++checks > maxChecks) return null;
      const pair: [string, string] = [pool[i], pool[j]];
      if (input.offspringPairs.some((p) => samePair(p, pair))) continue;
      if (isAncestorDescendantPair(pair[0], pair[1], input.edges)) continue;
      return pair;
    }
  }
  return null;
}

/**
 * 自動申請の本文に付ける区切り（人手の申請との同一フォーマットは保ったまま）。
 * - 見出し1行: Issue を開いた人に自動申請だと伝える（パーサーは `key: value` 行しか
 *   読まないため、検証・処理には影響しない）。
 * - マーカー: スクリプト側の目印（isAutoRequestIssue）。
 * - `source: auto-random`: 選出方法の記録（未知フィールドとして無視される）。
 */
export function decorateAutoIssueBody(
  base: IssueForm,
  idleHours: number,
): { title: string; body: string } {
  const note =
    `> 自動申請: 直近${idleHours}時間に配合申請がなかったため、候補からランダムに選んだ2作品で` +
    '配合申請を追加しました（選出に生成AIは使っていません）。';
  return {
    title: base.title,
    body: [note, '', base.body, AUTO_REQUEST_MARKER, `source: ${AUTO_REQUEST_SOURCE}`].join('\n'),
  };
}
