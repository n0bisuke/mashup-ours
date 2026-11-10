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
 * - 時間帯別配合（issue #41）: `breedingWindows` を指定すると **日本時間（JST）の
 *   時間帯ごとに間隔を切り替える**（例: 13:00〜21:00=30分 / 21:00〜翌13:00=2時間）。
 *   指定がなければ従来どおり breedingIntervalMinutes の間隔モード（後方互換）。
 */

/** 時間帯別配合の1区間（issue #41）。時刻は日本時間（Asia/Tokyo）の "HH:MM"。 */
export interface BreedingWindow {
  /** 開始時刻（JST "HH:MM"・0以上23時）。 */
  startJst: string;
  /** 終了時刻（JST "HH:MM"・開始と同じ値なら翌日 = 24時間ぶんの1区間）。 */
  endJst: string;
  /** この時間帯の配合間隔（分・正の整数）。区間の長さはこの値で割り切れること。 */
  intervalMinutes: number;
}

export interface ScheduleConfig {
  /** 配合候補の更新間隔（分・正の整数）。 */
  candidateRotationMinutes: number;
  /**
   * 配合（生成AI呼び出し）の間隔（分・正の整数）。前回成功からの空き時間。
   * `breedingWindows` が設定されているときは使わない（時間帯側が優先）。
   */
  breedingIntervalMinutes: number;
  /** 1枠あたりの候補件数の上限（正の整数）。 */
  maxCandidates: number;
  /**
   * 任意: 時間帯別配合（issue #41）。24時間を隙間・重複なく覆う連続した区間の並び。
   * 未設定・null = 従来の breedingIntervalMinutes 間隔モード。
   */
  breedingWindows?: BreedingWindow[];
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
/** 時間帯（breedingWindows）の区間数の上限。 */
const MAX_BREEDING_WINDOWS = 12;
/** "HH:MM"（00:00〜23:59）の形式。 */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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

/** "HH:MM" → 0〜1439の分。TIME_RE 通過後の内部関数。 */
function toMinuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** 時間帯の長さ（分）。start == end は翌日まで = 24時間ぶん。 */
function windowLengthMinutes(w: BreedingWindow): number {
  const s = toMinuteOfDay(w.startJst);
  const e = toMinuteOfDay(w.endJst);
  return s === e ? 1440 : (e - s + 1440) % 1440;
}

/**
 * breedingWindows の検証（issue #41）。不正なら理由文字列を返す。
 *
 * - 各区間: "HH:MM" 形式 / 正の整数の間隔 / 区間の長さが間隔で割り切れる
 *   （割り切れないと枠の境界と時刻の境界がずれる）
 * - 全体: **始点 = 前の区間の終点**（最後の終点 = 最初の始点）で24時間を
 *   隙間・重複なく覆う鎖であること（並びの起点はどこからでもよい）。
 */
function parseBreedingWindows(value: unknown): BreedingWindow[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return `breedingWindows は空でない配列である必要があります（入力: ${JSON.stringify(value)}）`;
  }
  if (value.length > MAX_BREEDING_WINDOWS) {
    return `breedingWindows は ${MAX_BREEDING_WINDOWS} 区間までです（入力: ${value.length} 区間）`;
  }
  const windows: BreedingWindow[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const at = `breedingWindows[${i}]`;
    const raw: unknown = value[i];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return `${at} はオブジェクトである必要があります`;
    }
    const w = raw as Record<string, unknown>;
    if (typeof w.startJst !== 'string' || !TIME_RE.test(w.startJst)) {
      return `${at}.startJst は 00:00〜23:59 の HH:MM 形式である必要があります（入力: ${JSON.stringify(w.startJst)}）`;
    }
    if (typeof w.endJst !== 'string' || !TIME_RE.test(w.endJst)) {
      return `${at}.endJst は 00:00〜23:59 の HH:MM 形式である必要があります（入力: ${JSON.stringify(w.endJst)}）`;
    }
    const interval = positiveInt(w.intervalMinutes, `${at}.intervalMinutes`, MAX_MINUTES);
    if (typeof interval === 'string') return interval;
    const window: BreedingWindow = { startJst: w.startJst, endJst: w.endJst, intervalMinutes: interval };
    const length = windowLengthMinutes(window);
    if (length % interval !== 0) {
      return `${at}（${window.startJst}〜${window.endJst}）の長さ ${length} 分は intervalMinutes ${interval} で割り切れないため、枠の境界とずれます`;
    }
    windows.push(window);
  }
  // 隙間・重複なく連続しているか（末尾 → 先頭も巡回して確認）
  for (let i = 0; i < windows.length; i += 1) {
    const cur = windows[i];
    const next = windows[(i + 1) % windows.length];
    if (cur.endJst !== next.startJst) {
      return `breedingWindows は ${cur.startJst}〜${cur.endJst} の次が ${next.startJst} で連続している必要があります（隙間・重複・時刻順の乱れは不可）`;
    }
  }
  return windows;
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

  // 時間帯別配合（issue #41）。未設定・null = 従来の breedingIntervalMinutes 間隔モード。
  // 不正な時間帯は exit 1 の対象（= AIを呼ばない。表示側は FALLBACK で継続）。
  if (v.breedingWindows !== undefined && v.breedingWindows !== null) {
    const windows = parseBreedingWindows(v.breedingWindows);
    if (typeof windows === 'string') return { ok: false, reason: windows };
    config.breedingWindows = windows;
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

/**
 * 配合頻度の短い説明（設定から生成 / issue #41）。
 * - 時間帯設定あり: 「13:00〜21:00は30分ごと・21:00〜13:00は2時間ごと（日本時間）」
 * - なし（従来）: 間隔ラベルそのまま（例: 「1時間」）
 */
export function breedingFreqLabel(cfg: ScheduleConfig): string {
  const windows = cfg.breedingWindows;
  if (windows && windows.length > 0) {
    const parts = windows.map((w) => `${w.startJst}〜${w.endJst}は${intervalLabel(w.intervalMinutes)}ごと`);
    return `${parts.join('・')}（日本時間）`;
  }
  return intervalLabel(cfg.breedingIntervalMinutes);
}

/** 候補更新の説明文（設定から生成。例: 「1時間ごとに新しい発明候補が届くよ！」）。 */
export function candidateNotice(cfg: ScheduleConfig): string {
  return `${intervalLabel(cfg.candidateRotationMinutes)}ごとに新しい発明候補が届くよ！`;
}

/** 配合の説明文（設定から生成。例: 「3時間に最大1つ、新しい発明が誕生します！」）。 */
export function breedingNotice(cfg: ScheduleConfig): string {
  if (cfg.breedingWindows && cfg.breedingWindows.length > 0) {
    // 時間帯別（issue #41）: 「13:00〜21:00は30分ごと・21:00〜13:00は2時間ごと（日本時間）に最大1つ、…」
    return `${breedingFreqLabel(cfg)}に最大1つ、新しい発明が誕生します！`;
  }
  return `${intervalLabel(cfg.breedingIntervalMinutes)}に最大1つ、新しい発明が誕生します！`;
}

/** 候補バッジの説明文（設定から生成。例: 「15分ごとに6件・全ユーザー共通」）。 */
export function candidateChipText(cfg: ScheduleConfig): string {
  return `${intervalLabel(cfg.candidateRotationMinutes)}ごとに${cfg.maxCandidates}件・全ユーザー共通`;
}

/** 配合枠の共有ルール説明（設定から生成。全ユーザー共有であることを明示）。 */
export function breedingShareText(cfg: ScheduleConfig): string {
  // 「候補の更新とは別の処理」は内部実装の説明なので画面に出さない（issue #33）。
  if (cfg.breedingWindows && cfg.breedingWindows.length > 0) {
    // 時間帯別（issue #41）: 1日の枠数も設定から計算して明示する。
    return `配合は${breedingFreqLabel(cfg)}に最大1件（1日最大${breedingSlotsPerDay(cfg)}枠）、全ユーザー共有です（ユーザーごとの回数制限ではありません）。`;
  }
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
  /**
   * 最後に**生成に成功した配合枠**（issue #41・JST枠キー 例 "2026-11-10T1300JST"）。
   * 同じ枠で二重生成しないために永続化する。失敗では更新しない（= 同じ枠で再試行できる）。
   * 時間帯設定がない（従来モード）・未実行なら null。任意項目（旧ファイル互換）。
   */
  lastSlot?: string | null;
}

/** data/breeding-state.json の lastSlot の形式（JST枠キー / issue #41）。 */
export const BREEDING_SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{4}JST$/;

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
  // lastSlot は任意（旧ファイルには無い）。あるなら JST枠キーの形でなければならない。
  if (s.lastSlot !== undefined && s.lastSlot !== null) {
    if (typeof s.lastSlot !== 'string' || !BREEDING_SLOT_KEY_RE.test(s.lastSlot)) return false;
  }
  return true;
}

/** 新規（未実行）の状態。 */
export function initialBreedingState(): BreedingState {
  return {
    schemaVersion: 1,
    lastSuccessAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    aiCalls: {},
    lastSlot: null,
  };
}

/** UTC日付キー "YYYY-MM-DD"（日次上限の集計単位）。 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 時間帯別配合の枠計算（issue #41 / 純関数・JST基準）
// ---------------------------------------------------------------------------

/** JSTのUTCオフセット（分）。 Asia/Tokyo は夏時間なし。 */
export const JST_OFFSET_MINUTES = 9 * 60;

/** 現在時刻に対応する配合枠。時間帯設定が無ければ null（従来モード）。 */
export interface BreedingSlot {
  /** 二重生成防止に永続化する枠キー（例: "2026-11-10T1300JST"）。 */
  key: string;
  /** 枠の開始時刻の表示用（例: "2026-11-10 13:00"）。 */
  startLabel: string;
  /** 枠の開始時刻（epoch ms）。次回枠の目安計算に使う。 */
  startMs: number;
  /** この枠の配合間隔（分）= 所属する時間帯の intervalMinutes。 */
  intervalMinutes: number;
}

/** JST epoch 分（1970-01-01 00:00 JST = 0）へ変換する。 */
function toJstMinutes(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MINUTES * 60_000) / 60_000);
}

/** JST epoch 分 → 枠キー・表示ラベル。 */
function jstSlotParts(absMinutes: number): { key: string; startLabel: string; startMs: number } {
  const day = Math.floor(absMinutes / 1440);
  const minuteOfDay = absMinutes - day * 1440;
  const startMs = day * 1440 * 60_000 + minuteOfDay * 60_000 - JST_OFFSET_MINUTES * 60_000;
  // 日付はJST暦（= day をそのままUTCとして解釈したもの）。startMs は実UTC時刻なので
  // ISO文字列の日付は前日になり、そのまま使うと枠キーの日付が1日ずれる。
  const ymd = new Date(day * 1440 * 60_000).toISOString().slice(0, 10);
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return { key: `${ymd}T${hh}${mm}JST`, startLabel: `${ymd} ${hh}:${mm}`, startMs };
}

/**
 * 現在時刻の配合枠を求める（issue #41）。
 *
 * - `breedingWindows` 未設定なら null（従来の間隔モード = この関数は使わない）。
 * - 枠は **JST基準**。13:00〜21:00 は30分、21:00〜翌13:00 は2時間、のように
 *   時間帯ごとに intervalMinutes で割った区切り。日付をまたぐ時間帯も扱う。
 * - 時間帯設定で24時間を覆っていない場合のみ null（=「時間帯の外」）。
 *
 * 遅延した実行でも **現在時刻の1枠だけ** を返す（過去の枠を列挙するAPIは無い =
 * 1回の実行で処理できる枠は常に1つ）。
 */
export function currentBreedingSlot(cfg: ScheduleConfig, now: Date): BreedingSlot | null {
  const windows = cfg.breedingWindows;
  if (!windows || windows.length === 0) return null;

  const nowAbs = toJstMinutes(now.getTime());
  const dayAbs = Math.floor(nowAbs / 1440);
  const minuteOfDay = nowAbs - dayAbs * 1440;

  let windowStart = -1;
  let interval = 0;
  for (const w of windows) {
    const s = toMinuteOfDay(w.startJst);
    const e = toMinuteOfDay(w.endJst);
    if (s === e) {
      // 開始と終了が同じ時刻 = 24時間ぶんの1区間。基点は「直前の s 時」。
      windowStart = (dayAbs - 1) * 1440 + s;
    } else if (s < e) {
      // 同日区内の時間帯（例: 13:00〜21:00）
      if (minuteOfDay < s || minuteOfDay >= e) continue;
      windowStart = dayAbs * 1440 + s;
    } else {
      // 日付をまたぐ時間帯（例: 21:00〜翌13:00）
      if (minuteOfDay >= s) windowStart = dayAbs * 1440 + s;
      else if (minuteOfDay < e) windowStart = (dayAbs - 1) * 1440 + s;
      else continue;
    }
    interval = w.intervalMinutes;
    break;
  }
  if (windowStart < 0 || interval <= 0) return null; // 時間帯の外（24時間を覆わない設定のみ）

  const slotAbs = windowStart + Math.floor((nowAbs - windowStart) / interval) * interval;
  const { key, startLabel, startMs } = jstSlotParts(slotAbs);
  return { key, startLabel, startMs, intervalMinutes: interval };
}

/**
 * 次の配合枠の開始時刻（epoch ms）。時間帯設定が無ければ null。
 * 「次の発明はいつ生まれるか」の目安に使う（issue #41 / UI）。
 */
export function nextBreedingSlotStart(cfg: ScheduleConfig, after: Date): Date | null {
  const slot = currentBreedingSlot(cfg, after);
  if (!slot) return null;
  return new Date(slot.startMs + slot.intervalMinutes * 60_000);
}

/**
 * 1日あたりの配合枠数（issue #41 の完了条件「1日最大24枠」）。
 * 時間帯設定あり = Σ(区間の長さ ÷ 間隔)、なし = 1440 ÷ 間隔（切り捨て）。
 */
export function breedingSlotsPerDay(cfg: ScheduleConfig): number {
  const windows = cfg.breedingWindows;
  if (windows && windows.length > 0) {
    return windows.reduce((sum, w) => sum + windowLengthMinutes(w) / w.intervalMinutes, 0);
  }
  return Math.floor(1440 / cfg.breedingIntervalMinutes);
}

export interface BreedDecision {
  run: boolean;
  /** ログ用の理由（run どちらでも必ず返す。秘密情報は含めない）。 */
  reason: string;
}

/**
 * 生成AIを呼ぶべきか判定する（ワーカーの実行ゲート）。
 *
 * ### 時間帯別モード（breedingWindows あり / issue #41）
 * 1. **枠の二重生成防止**: 現在の枠が `state.lastSlot` と一致したら実行しない
 *    （成功したときだけ lastSlot が更新される = 同じ枠内での失敗は再試行できる）。
 * 2. **遅延の扱い**: 判定は **現在時刻の1枠だけ** を見る。過去の枠をまとめて処理しない
 *    （1回の実行で生成できるのは最大1件）。未処理Issueの選び方（古い順）は従来どおり。
 * 3. **冷却・日次上限**: 連続失敗3回の冷却はその枠の intervalMinutes、
 *    dailyAiCallLimit は従来どおり UTC日単位。
 *
 * ### 従来モード（breedingWindows なし）
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
 * 手動実行もこの判定を通す（dry_run は確認だけして続行する）。
 */
export function shouldBreed(state: BreedingState, cfg: ScheduleConfig, now: Date = new Date()): BreedDecision {
  const slot = currentBreedingSlot(cfg, now);
  if (slot === null && cfg.breedingWindows !== undefined && cfg.breedingWindows.length > 0) {
    return { run: false, reason: '現在時刻は設定された配合時間帯の外です（breedingWindows）' };
  }

  const nowMs = now.getTime();
  const intervalMinutes = slot ? slot.intervalMinutes : cfg.breedingIntervalMinutes;
  const intervalText = intervalLabel(intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;

  if (slot) {
    // 時間帯別モード: 同じ枠での二重生成をしない（実行済み枠は lastSlot に永続化）。
    if (state.lastSlot !== null && state.lastSlot !== undefined && state.lastSlot === slot.key) {
      return {
        run: false,
        reason: `この配合枠（${slot.startLabel} JST）は生成済みです（同一枠での二重生成はしない）`,
      };
    }
  } else if (state.lastSuccessAt !== null) {
    // 従来モード: 前回成功からの間隔。
    const last = Date.parse(state.lastSuccessAt);
    if (Number.isFinite(last) && nowMs - last < intervalMs) {
      return {
        run: false,
        reason: `前回の成功から${intervalText}未経過（間隔を空けて最大1件）`,
      };
    }
  }

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && state.lastAttemptAt !== null) {
    const sinceAttempt = nowMs - Date.parse(state.lastAttemptAt);
    if (Number.isFinite(sinceAttempt) && sinceAttempt < intervalMs) {
      return {
        run: false,
        reason: `連続失敗${MAX_CONSECUTIVE_FAILURES}回のため冷却中（直近の試行から${intervalText}を空けるまで停止）`,
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
  if (slot) {
    return {
      run: true,
      reason: `新しい配合枠 ${slot.startLabel} JST（${intervalText}枠・枠の生成実績なし・上限内）`,
    };
  }
  return { run: true, reason: '間隔・上限ともに条件を満たした' };
}

/**
 * 試行の結果を状態へ記録する（返り値は新しい状態。呼び出し側が保存する）。
 * - 成功: lastSuccessAt / consecutiveFailures=0 / **実行した枠を lastSlot に保存**
 *   （時間帯設定があるとき。issue #41 の同一枠二重生成防止）
 * - 失敗: consecutiveFailures+1（間隔は数えない = 再試行可能。lastSlot は変えない）
 * - どちらも lastAttemptAt と aiCalls[当日] を更新（呼び出し回数は失敗も数える）
 * - 連続失敗上限の冷却が経過した後の最初の試行は、失敗カウントを数え直す
 * - 冷却の空ける時間は時間帯別設定なら現在の枠の間隔、なければ breedingIntervalMinutes
 * - aiCalls は直近 AI_CALL_HISTORY_DAYS 日のみ保持（無限に肥大化しない）
 */
export function recordBreedingAttempt(
  state: BreedingState,
  cfg: ScheduleConfig,
  opts: { now: Date; success: boolean; slotKey?: string | null },
): BreedingState {
  const { now, success } = opts;
  const slot = currentBreedingSlot(cfg, now);
  const intervalMs = (slot ? slot.intervalMinutes : cfg.breedingIntervalMinutes) * 60_000;

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

  // 成功した枠だけ記録する（slotKey 明示 > now から計算。従来モードは null のまま）。
  const lastSlot = success
    ? (opts.slotKey ?? slot?.key ?? state.lastSlot ?? null)
    : (state.lastSlot ?? null);

  return {
    schemaVersion: 1,
    lastSuccessAt: success ? now.toISOString() : state.lastSuccessAt,
    lastAttemptAt: now.toISOString(),
    consecutiveFailures: failures,
    aiCalls,
    lastSlot,
  };
}
