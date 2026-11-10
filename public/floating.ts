/**
 * フローティング配合マシン（画面右下のミニマシン / issue #26）の判定・永続化。
 *
 * このモジュールは純関数のみ（DOM非依存）。
 * - 表示判定: IntersectionObserver のエントリから小さな状態機械を作る
 *   （スクロールイベントの高頻度監視はしない。境界付近でちらつかせないヒステリシス付き）
 * - 選択の永続化: localStorage に保存する書式と、復元時の検証
 *   （選択状態そのもの = pickA / pickB は public/main.ts の単一データソース。
 *    ここでは書式と検証だけを扱う）
 */

/** この比率以上でないと小型版を非表示にしない（0〜この値は前状態のまま = 境界でちらつかせない）。 */
export const FLOAT_HIDE_RATIO = 0.2;

export interface FloatVisibilityEntry {
  isIntersecting: boolean;
  intersectionRatio: number;
}

/**
 * 大きな配合マシン（FVの lab-scene）の可視状態から、小型版を表示するかを決める。
 *
 * - 完全に画面外（intersectionRatio 0）→ 表示
 * - 20%以上画面内 → 非表示
 * - その間（0〜20%）→ 前状態を維持（ヒステリシス = 境界のちらつき防止）
 */
export function shouldShowFloating(
  prevVisible: boolean,
  entry: FloatVisibilityEntry,
): boolean {
  if (!entry.isIntersecting || entry.intersectionRatio <= 0) return true;
  if (entry.intersectionRatio >= FLOAT_HIDE_RATIO) return false;
  return prevVisible;
}

/** 選択数のラベル（0/2・1/2・2/2）。色ではなく**文字**で状態を伝える（issue #26 §9）。 */
export function floatCountLabel(count: number): string {
  const n = Math.max(0, Math.min(2, Math.round(count)));
  return `${n}/2`;
}

/** 選択状態を保存するキー（テーマの `mashup-theme` と同じ命名系統）。 */
export const PICKS_KEY = 'mashup-picks';

/** 復元時に受け付けるIDの最大長（.localStorage の汚れた値対策）。 */
const MAX_PICK_ID = 64;

export interface Picks {
  a: string | null;
  b: string | null;
}

/** 選択状態を保存用にシリアライズする。両方 null ならキーごと消すため null を返す。 */
export function serializePicks(a: string | null, b: string | null): string | null {
  if (!a && !b) return null;
  return JSON.stringify({ v: 1, a, b });
}

/**
 * 保存値を復元する。検証に通らない項目は null にする（壊れた値で選択状態を作らない）。
 * - a / b は文字列・長さ上限
 * - 選択可能なかつ現在の候補/子作品（`isSelectable` = pickRegistry に存在するか）
 * - a === b は既存ルールで不可（b を捨てる）
 */
export function parsePicks(raw: unknown, isSelectable: (id: string) => boolean): Picks {
  const none: Picks = { a: null, b: null };
  if (typeof raw !== 'string' || raw === '') return none;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return none;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return none;
  const obj = data as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= MAX_PICK_ID ? v : null;
  let a = str(obj.a);
  let b = str(obj.b);
  if (a && b && a === b) b = null; // 同じ作品を親Aと親Bに同時に指定しない（既存ルール）
  return {
    a: a && isSelectable(a) ? a : null,
    b: b && isSelectable(b) ? b : null,
  };
}
