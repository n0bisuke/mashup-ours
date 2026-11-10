/**
 * 配合頻度・候補更新頻度の設定（config/schedule.json）。（issue #15）
 *
 * 「1時間に1回」「15分ごと」などの固定仕様を廃止し、設定ファイルから
 * 頻度・候補件数を変更できるようにする。このモジュールは純関数のみ
 * （Node依存なし）。フロント・ワーカー・テストで共有する。
 *
 * 方針:
 * - 候補更新（candidateRotationMinutes）と配合処理（breedingIntervalMinutes）は
 *   完全に独立した設定。UI・スクリプトとも混同しない。
 * - GitHub Actions の cron はJSONを読めないため、ワークフローは一定間隔で起床し、
 *   スクリプトがこの設定と前回実行の状態から実行可否を判断する。
 * - 「設定間隔ごとに必ず生成」ではなく「間隔を空けて最大1件」（Actionsの遅延を許容）。
 * - 設定が不正な場合: スクリプトは exit 1 で停止（= AIを呼ばない）、
 *   フロントは既定値で表示しつつエラーを告知する。
 */

export interface ScheduleConfig {
  /** 配合候補の更新間隔（分・正の整数）。 */
  candidateRotationMinutes: number;
  /** 配合（生成AI呼び出し）の間隔（分・正の整数）。前回成功からの空き時間。 */
  breedingIntervalMinutes: number;
  /** 1枠あたりの候補件数の上限（正の整数）。 */
  maxCandidates: number;
  /** 任意: UTC日ごとの生成AI呼び出し回数の上限（正の整数）。未設定 = 上限なし。 */
  dailyAiCallLimit?: number;
  /**
   * 任意: 自動配合申請（issue #27）の待機時間（時間・0以上）。
   * 指定時間以内に配合申請がなければ自動で1件作る。0 = 自動作成しない。
   * 未設定 = DEFAULT_AUTO_REQUEST_IDLE_HOURS。
   */
  autoRequestIdleHours?: number;
}

/**
 * 設定が読めない場合の既定値（= 従来の動作）。
 * フロントは不正時にこれで描画を続ける（表示は止めない）。
 */
/** 自動配合申請の待機時間の既定値（時間）。設定が無ければこれを使う（issue #27）。 */
export const DEFAULT_AUTO_REQUEST_IDLE_HOURS = 8;
/** autoRequestIdleHours の上限（時間）。1か月。 */
const MAX_AUTO_IDLE_HOURS = 720;

export const FALLBACK_SCHEDULE: ScheduleConfig = {
  candidateRotationMinutes: 15,
  breedingIntervalMinutes: 60,
  maxCandidates: 6,
  autoRequestIdleHours: DEFAULT_AUTO_REQUEST_IDLE_HOURS,
};

/** 間隔（分）の上限。1週間。無効な巨大値でUI・スロット計算が壊れないようにする。 */
const MAX_MINUTES = 10080;
/** 候補件数の上限。 */
const MAX_CANDIDATES = 50;
/** 日次AI呼び出し上限の上限。 */
const MAX_DAILY_AI_CALLS = 1000;

export type ScheduleParseResult =
  | { ok: true; config: ScheduleConfig }
  | { ok: false; reason: string };

function positiveInt(value: unknown, name: string, max: number): number | string {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${name} は正の整数である必要があります（入力: ${JSON.stringify(value)}）`;
  }
  if (value < 1 || value > max) {
    return `${name} は 1 以上 ${max} 以下である必要があります（入力: ${value}）`;
  }
  return value;
}

/**
 * config/schedule.json の形を検証する。
 * 必須3項目は正の整数、dailyAiCallLimit は任意（あれば正の整数）。
 * 未知のキーは無視する（将来の追加項目で壊さないため）。
 */
export function parseScheduleConfig(value: unknown): ScheduleParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'オブジェクトである必要があります' };
  }
  const v = value as Record<string, unknown>;

  const rotation = positiveInt(v.candidateRotationMinutes, 'candidateRotationMinutes', MAX_MINUTES);
  if (typeof rotation === 'string') return { ok: false, reason: rotation };

  const breeding = positiveInt(v.breedingIntervalMinutes, 'breedingIntervalMinutes', MAX_MINUTES);
  if (typeof breeding === 'string') return { ok: false, reason: breeding };

  const maxCand = positiveInt(v.maxCandidates, 'maxCandidates', MAX_CANDIDATES);
  if (typeof maxCand === 'string') return { ok: false, reason: maxCand };

  const config: ScheduleConfig = {
    candidateRotationMinutes: rotation,
    breedingIntervalMinutes: breeding,
    maxCandidates: maxCand,
  };

  if (v.dailyAiCallLimit !== undefined && v.dailyAiCallLimit !== null) {
    const daily = positiveInt(v.dailyAiCallLimit, 'dailyAiCallLimit', MAX_DAILY_AI_CALLS);
    if (typeof daily === 'string') return { ok: false, reason: daily };
    config.dailyAiCallLimit = daily;
  }

  // 自動配合申請の待機時間（issue #27）。0 は「無効」なので positiveInt を使わない。
  // 未設定・null は既定値（DEFAULT_AUTO_REQUEST_IDLE_HOURS）として扱い、設定には書かない。
  if (v.autoRequestIdleHours !== undefined && v.autoRequestIdleHours !== null) {
    const hours = v.autoRequestIdleHours;
    if (typeof hours !== 'number' || !Number.isInteger(hours)) {
      return {
        ok: false,
        reason: `autoRequestIdleHours は整数（時間）である必要があります（入力: ${JSON.stringify(hours)}）`,
      };
    }
    if (hours < 0 || hours > MAX_AUTO_IDLE_HOURS) {
      return {
        ok: false,
        reason: `autoRequestIdleHours は 0 以上 ${MAX_AUTO_IDLE_HOURS} 以下である必要があります（入力: ${hours}）`,
      };
    }
    config.autoRequestIdleHours = hours;
  }

  return { ok: true, config };
}

/**
 * 生JSONを検証し、不正なら既定値とエラー理由を返す（フロント用）。
 * スクリプト側は parseScheduleConfig の ok を見て exit する（= 処理停止）。
 */
export function resolveSchedule(raw: unknown): { config: ScheduleConfig; error: string | null } {
  const parsed = parseScheduleConfig(raw);
  return parsed.ok
    ? { config: parsed.config, error: null }
    : { config: FALLBACK_SCHEDULE, error: parsed.reason };
}

/**
 * 間隔（分）の人間向けラベル。
 * 60で割り切れる場合のみ「時間」表記（例: 15→「15分」, 60→「1時間」, 180→「3時間」）。
 * 90のような割り切れない値は分のまま（「1.5時間」は読みにくいため）。
 */
export function intervalLabel(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}時間` : `${minutes}分`;
}

/** 候補更新の説明文（設定から生成。例: 「1時間ごとに新しい発明候補が届くよ！」）。 */
export function candidateNotice(cfg: ScheduleConfig): string {
  return `${intervalLabel(cfg.candidateRotationMinutes)}ごとに新しい発明候補が届くよ！`;
}

/** 配合の説明文（設定から生成。例: 「3時間に最大1つ、新しい発明が誕生します！」）。 */
export function breedingNotice(cfg: ScheduleConfig): string {
  return `${intervalLabel(cfg.breedingIntervalMinutes)}に最大1つ、新しい発明が誕生します！`;
}

/** 候補バッジの説明文（設定から生成。例: 「15分ごとに6件・全ユーザー共通」）。 */
export function candidateChipText(cfg: ScheduleConfig): string {
  return `${intervalLabel(cfg.candidateRotationMinutes)}ごとに${cfg.maxCandidates}件・全ユーザー共通`;
}

/** 配合枠の共有ルール説明（設定から生成。全ユーザー共有であることを明示）。 */
export function breedingShareText(cfg: ScheduleConfig): string {
  // 「候補の更新とは別の処理」は内部実装の説明なので画面に出さない（issue #33）。
  return `配合は${intervalLabel(cfg.breedingIntervalMinutes)}に最大1件、全ユーザー共有です（ユーザーごとの回数制限ではありません）。`;
}

// ---------------------------------------------------------------------------
// 配合の実行制御（ワーカーが使う。前回成功日時との比較で「間隔を空けて最大1件」）
// ---------------------------------------------------------------------------

/**
 * 配合ワーカーの実行状態（data/breeding-state.json）。
 * 「候補更新の状態」（data/current-candidates.json の slot）とは別物。
 */
export interface BreedingState {
  schemaVersion: 1;
  /** 最後に配合に成功した日時（ISO 8601）。null = まだ成功していない。 */
  lastSuccessAt: string | null;
  /** 直近の試行日時（ISO 8601）。失敗でも更新する。 */
  lastAttemptAt: string | null;
  /** 連続失敗回数（成功で 0 にリセット）。 */
  consecutiveFailures: number;
  /** UTC日付（"YYYY-MM-DD"）ごとの生成AI呼び出し回数。直近の日付のみ保持。 */
  aiCalls: Record<string, number>;
}

/** 連続失敗の上限。ここまでは次の起床で再試行、超えたら間隔の冷却に入る。 */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** aiCalls に保持する日数。 */
const AI_CALL_HISTORY_DAYS = 7;

/** data/breeding-state.json の形を検証する。 */
export function isBreedingState(x: unknown): x is BreedingState {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const s = x as Record<string, unknown>;
  if (s.schemaVersion !== 1) return false;
  if (s.lastSuccessAt !== null && typeof s.lastSuccessAt !== 'string') return false;
  if (s.lastAttemptAt !== null && typeof s.lastAttemptAt !== 'string') return false;
  if (typeof s.consecutiveFailures !== 'number' || !Number.isInteger(s.consecutiveFailures) || s.consecutiveFailures < 0) {
    return false;
  }
  if (typeof s.aiCalls !== 'object' || s.aiCalls === null || Array.isArray(s.aiCalls)) return false;
  for (const [day, count] of Object.entries(s.aiCalls as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return false;
  }
  return true;
}

/** 新規（未実行）の状態。 */
export function initialBreedingState(): BreedingState {
  return { schemaVersion: 1, lastSuccessAt: null, lastAttemptAt: null, consecutiveFailures: 0, aiCalls: {} };
}

/** UTC日付キー "YYYY-MM-DD"（日次上限の集計単位）。 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface BreedDecision {
  run: boolean;
  /** ログ用の理由（run どちらでも必ず返す。秘密情報は含めない）。 */
  reason: string;
}

/**
 * 生成AIを呼ぶべきか判定する（ワーカーの実行ゲート）。
 *
 * 再試行条件（明示）:
 * 1. **間隔**: 前回の成功から breedingIntervalMinutes を空けない限り実行しない
 *    （前回成功が null なら最初の1回を許可）。
 * 2. **失敗の再試行**: 失敗しても間隔は数えない。次の起床で再試行できる
 *    （連続失敗が MAX_CONSECUTIVE_FAILURES 未満なら）。
 * 3. **連続失敗の冷却**: 連続失敗が上限まで達したら、直近の試行から
 *    breedingIntervalMinutes を空けるまで停止。冷却が終わると再開する。
 * 4. **日次上限**: dailyAiCallLimit 設定時、そのUTC日に呼び出し回数が上限なら停止
 *    （失敗した試行も呼び出し回数に数える = コスト上限として機能する）。
 *
 * 「間隔ごとに必ず生成」ではなく「間隔を空けて最大1件」。workflow_dispatch の
 * 手動実行もこの判定を通す（初期設定では頻度制限を守る）。
 */
export function shouldBreed(state: BreedingState, cfg: ScheduleConfig, now: Date = new Date()): BreedDecision {
  const intervalMs = cfg.breedingIntervalMinutes * 60_000;
  const nowMs = now.getTime();

  if (state.lastSuccessAt !== null) {
    const last = Date.parse(state.lastSuccessAt);
    if (Number.isFinite(last) && nowMs - last < intervalMs) {
      return {
        run: false,
        reason: `前回の成功から${intervalLabel(cfg.breedingIntervalMinutes)}未経過（間隔を空けて最大1件）`,
      };
    }
  }

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && state.lastAttemptAt !== null) {
    const sinceAttempt = nowMs - Date.parse(state.lastAttemptAt);
    if (Number.isFinite(sinceAttempt) && sinceAttempt < intervalMs) {
      return {
        run: false,
        reason: `連続失敗${MAX_CONSECUTIVE_FAILURES}回のため冷却中（直近の試行から${intervalLabel(cfg.breedingIntervalMinutes)}を空けるまで停止）`,
      };
    }
  }

  if (cfg.dailyAiCallLimit !== undefined) {
    const today = utcDay(now);
    const used = state.aiCalls[today] ?? 0;
    if (used >= cfg.dailyAiCallLimit) {
      return {
        run: false,
        reason: `本日（UTC ${today}）のAI呼び出し上限 ${cfg.dailyAiCallLimit} 回に達したため停止`,
      };
    }
  }

  if (state.consecutiveFailures > 0) {
    return {
      run: true,
      reason: `前回失敗（連続${state.consecutiveFailures}回）— 再試行条件を満たした`,
    };
  }
  return { run: true, reason: '間隔・上限ともに条件を満たした' };
}

/**
 * 試行の結果を状態へ記録する（返り値は新しい状態。呼び出し側が保存する）。
 * - 成功: lastSuccessAt / consecutiveFailures=0
 * - 失敗: consecutiveFailures+1（間隔は数えない = 再試行可能）
 * - どちらも lastAttemptAt と aiCalls[当日] を更新（呼び出し回数は失敗も数える）
 * - 連続失敗上限の冷却が経過した後の最初の試行は、失敗カウントを数え直す
 * - aiCalls は直近 AI_CALL_HISTORY_DAYS 日のみ保持（無限に肥大化しない）
 */
export function recordBreedingAttempt(
  state: BreedingState,
  cfg: ScheduleConfig,
  opts: { now: Date; success: boolean },
): BreedingState {
  const { now, success } = opts;
  const intervalMs = cfg.breedingIntervalMinutes * 60_000;

  let failures = state.consecutiveFailures;
  if (failures >= MAX_CONSECUTIVE_FAILURES && state.lastAttemptAt !== null) {
    const sinceAttempt = now.getTime() - Date.parse(state.lastAttemptAt);
    if (Number.isFinite(sinceAttempt) && sinceAttempt >= intervalMs) {
      failures = 0; // 冷却経過 → 新しい周期として数え直す
    }
  }
  if (success) failures = 0;
  else failures += 1;

  const day = utcDay(now);
  const aiCalls: Record<string, number> = {};
  const cutoff = utcDay(new Date(now.getTime() - (AI_CALL_HISTORY_DAYS - 1) * 24 * 60 * 60_000));
  for (const [d, count] of Object.entries(state.aiCalls)) {
    if (d >= cutoff && d <= day) aiCalls[d] = count;
  }
  aiCalls[day] = (aiCalls[day] ?? 0) + 1;

  return {
    schemaVersion: 1,
    lastSuccessAt: success ? now.toISOString() : state.lastSuccessAt,
    lastAttemptAt: now.toISOString(),
    consecutiveFailures: failures,
    aiCalls,
  };
}
