/**
 * 配合候補の決定的選出。（追加開発指示 §3 / §7 / issue #10、間隔の設定化 issue #15）
 *
 * 要件:
 * - 候補は1枠につき最大 maxCandidates（既定6）作品・重複表示なし。
 * - 1枠の間は全ユーザーに同じ候補（= 同じスロット文字列なら常に同じ選出）。
 * - ページ再読み込みで候補を変化させない（UIは data/current-candidates.json を読むだけ）。
 * - 候補の生成時刻（generatedAt）と対象時間帯（slot）をJSONに記録する。
 * - Actionsの実行遅延に備え、表示はJSONの値（実行結果）ベースにする。
 *
 * ※ 候補スロット（"YYYY-MM-DDTHHMM"・間隔は config/schedule.json の
 *   candidateRotationMinutes、既定15分刻み）と、
 *   配合スロット（lib/generation.ts slotKey "YYYY-MM-DDTHH"）は別物。
 *
 * このモジュールは純関数のみ（Node依存なし）。フロント・ワーカー・テストで共有する。
 */
import type { ProtopediaWork } from './types.ts';

/** 候補スロットの既定の間隔（分）。実際の間隔は config/schedule.json（issue #15）。 */
export const CANDIDATE_SLOT_MINUTES = 15;
/** 1枠の候補数（最大・既定）。実際の上限は config/schedule.json の maxCandidates（issue #15）。 */
export const CANDIDATES_PER_SLOT = 6;

export interface CandidatesFile {
  schemaVersion: 1;
  /** 対象時間帯（UTC "YYYY-MM-DDTHHMM"・15分刻み）。このスロット中は全ユーザー共通。 */
  slot: string;
  /** このJSONの実際の生成時刻（Actions実行結果。UIはこの値を信用する）。 */
  generatedAt: string;
  /** 次の候補更新予定（= slot の次の15分境界 "YYYY-MM-DDTHHMM"）。 */
  nextSlot: string;
  /** 候補元のデータファイル（例: "data/sample-prototypes.json"）。 */
  source: string;
  /** このスロットのProtoPedia候補（最大6件・ID重複なし）。 */
  candidates: ProtopediaWork[];
  /**
   * このスロットの候補に含まれるAI生成アイデア（issue #36）。
   * 0件 = AI生成アイデアが無いときは ProtoPedia 候補だけで埋まる。
   * 既存ファイルに無くても良い（未定義 = AI生成候補なし）。
   * 中身はIDだけ。実体は data/offspring.json 側にあり、UIはIDで解決する。
   */
  offspringCandidates?: string[];
}

const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{4}$/;

/** FNV-1a 32bit（スロット文字列 → 乱数シード）。 */
export function hashSlot(slot: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slot.length; i++) {
    h ^= slot.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32（決定的な擬似乱数。シードが同じなら常に同じ列）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "protopedia:123" → 123（安定ソート用。未知形式は最後尾）。 */
function numericId(id: string): number {
  const m = /:(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * プールからスロット単位で候補を選ぶ。
 * - ID重複を排除し、ID昇順で安定ソート（入力ファイルの並び順に依存しない）。
 * - スロットのハッシュをシードにシャッフルし、上位 count 件を返す。
 * - 同じ（プール, スロット）なら常に同じ結果（15分枠内の再実行・再読み込みで不変）。
 */
export function selectCandidates(
  pool: readonly ProtopediaWork[],
  slot: string,
  count = CANDIDATES_PER_SLOT,
): ProtopediaWork[] {
  const seen = new Set<string>();
  const uniq: ProtopediaWork[] = [];
  for (const w of pool) {
    if (!w || typeof w.id !== 'string' || seen.has(w.id)) continue;
    seen.add(w.id);
    uniq.push(w);
  }
  uniq.sort((a, b) => numericId(a.id) - numericId(b.id));

  const rnd = mulberry32(hashSlot(slot));
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = uniq[i];
    uniq[i] = uniq[j];
    uniq[j] = tmp;
  }
  return uniq.slice(0, Math.min(count, uniq.length));
}

/**
 * AI生成アイデアから候補を1件だけ選ぶ（issue #36）。
 * - ProtoPedia候補と区別して1枠に1件（原則）。0件なら `null`（= ProtoPedia 6件で埋める）。
 * - 同じ（プール, スロット）なら常に同じ結果（15分枠内で不変 = 全ユーザー共通）。
 * - 削除済み・非公開・不正IDの除外は呼び出し側で行い、ここでは重複排除と選出だけをする。
 */
export function selectOffspringCandidate(
  offspringIds: readonly string[],
  slot: string,
): string | null {
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const id of offspringIds) {
    if (typeof id !== 'string' || !/^mashup-\d{1,9}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    uniq.push(id);
  }
  if (uniq.length === 0) return null;
  // ID昇順で安定ソートしてからシャッフル（入力ファイルの並び順に依存しない）
  const digits = (id: string): number => {
    const m = /(\d+)$/.exec(id);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  uniq.sort((a, b) => digits(a) - digits(b));
  // 決定的なシャッフル（selectCandidates と同じシード = 同じスロットなら同じ結果）
  const rnd = mulberry32(hashSlot(`${slot}|offspring`));
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = uniq[i];
    uniq[i] = uniq[j];
    uniq[j] = tmp;
  }
  return uniq[0];
}

/** 間隔（分）の形式検証（不正は例外）。config/schedule.json の検証とは独立に呼べる。 */
function assertSlotMinutes(slotMinutes: number): void {
  if (!Number.isInteger(slotMinutes) || slotMinutes < 1) {
    throw new Error(`slotMinutes は正の整数である必要があります: ${slotMinutes}`);
  }
}

/**
 * UTC基準の候補スロットキー "YYYY-MM-DDTHHMM"（slotMinutes 間隔の境界へ切り下げ）。
 * エポックミリ秒ベースなので 60 で割り切れない間隔（7分・10分など）でも日跨ぎなく正しく切れる。
 * Actionsの再実行・手動実行でも同じ枠内で常に同じスロットになる（決定的な選出の前提）。
 */
export function candidateSlotKey(
  date: Date = new Date(),
  slotMinutes: number = CANDIDATE_SLOT_MINUTES,
): string {
  assertSlotMinutes(slotMinutes);
  const stepMs = slotMinutes * 60_000;
  const d = new Date(Math.floor(date.getTime() / stepMs) * stepMs);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day}T${h}${mi}`;
}

/** slot "YYYY-MM-DDTHHMM" の次の slotMinutes 分後の境界。形式不正・間隔不正は例外。 */
export function nextSlotKey(slot: string, slotMinutes: number = CANDIDATE_SLOT_MINUTES): string {
  assertSlotMinutes(slotMinutes);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})$/.exec(slot);
  if (!m) throw new Error(`slot 形式が不正です（YYYY-MM-DDTHHMM）: ${slot}`);
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]) + slotMinutes),
  );
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${hh}${mi}`;
}

/**
 * 候補JSONを組み立てる。プール0件は例外（= 既存ファイルを更新しない）。
 * opts: 間隔（分）と候補件数の上限（config/schedule.json から渡す / issue #15）。
 * opts.offspringIds: 候補にできるAI生成アイデア（issue #36）。1件選出したら
 * **合計が maxCandidates を超えないよう ProtoPedia 候補を1件減らす**。
 * 0件なら従来どおり ProtoPedia だけで maxCandidates 件。
 */
export function buildCandidatesFile(
  pool: readonly ProtopediaWork[],
  slot: string,
  source: string,
  now: Date = new Date(),
  opts: { slotMinutes?: number; maxCandidates?: number; offspringIds?: readonly string[] } = {},
): CandidatesFile {
  const slotMinutes = opts.slotMinutes ?? CANDIDATE_SLOT_MINUTES;
  const maxCandidates = opts.maxCandidates ?? CANDIDATES_PER_SLOT;
  const offspringId = selectOffspringCandidate(opts.offspringIds ?? [], slot);
  const protoCount = Math.max(1, maxCandidates - (offspringId !== null ? 1 : 0));
  const candidates = selectCandidates(pool, slot, protoCount);
  if (candidates.length === 0) {
    throw new Error('選出できる作品がありません（プールが空のため候補を更新しません）');
  }
  return {
    schemaVersion: 1,
    slot,
    generatedAt: now.toISOString(),
    nextSlot: nextSlotKey(slot, slotMinutes),
    source,
    candidates,
    ...(offspringId !== null ? { offspringCandidates: [offspringId] } : {}),
  };
}

/**
 * data/current-candidates.json の形を検証する（フロントの読み込みガード）。
 * 想定外の形なら false を返し、呼び出し側は開発用サンプルに落とす。
 * maxCandidates: config の値を渡す（issue #15）。引き下げた直後に既存ファイルを
 * 壊さないよう、呼び出し側は max(設定値, 既定6) を渡すのが望ましい。
 */
export function isCandidatesFile(
  x: unknown,
  maxCandidates: number = CANDIDATES_PER_SLOT,
): x is CandidatesFile {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const f = x as Record<string, unknown>;
  if (f.schemaVersion !== 1) return false;
  if (typeof f.slot !== 'string' || !SLOT_RE.test(f.slot)) return false;
  if (typeof f.nextSlot !== 'string' || !SLOT_RE.test(f.nextSlot)) return false;
  if (typeof f.generatedAt !== 'string' || Number.isNaN(Date.parse(f.generatedAt))) return false;
  if (typeof f.source !== 'string' || f.source.length === 0) return false;
  if (!Array.isArray(f.candidates)) return false;
  if (f.candidates.length === 0 || f.candidates.length > maxCandidates) return false;

  // AI生成アイデアの候補（issue #36）。未定義（旧ファイル）は「なし」として受理する。
  let offspringCount = 0;
  if (f.offspringCandidates !== undefined) {
    if (!Array.isArray(f.offspringCandidates)) return false;
    const offIds = new Set<string>();
    for (const id of f.offspringCandidates) {
      if (typeof id !== 'string' || !/^mashup-\d{1,9}$/.test(id) || offIds.has(id)) return false;
      offIds.add(id);
    }
    offspringCount = f.offspringCandidates.length;
  }
  // 合計は maxCandidates 件以下（ProtoPedia 6件 + AI 1件 = 7件にはならない）
  if (f.candidates.length + offspringCount > maxCandidates) return false;

  const ids = new Set<string>();
  for (const c of f.candidates) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return false;
    const w = c as Record<string, unknown>;
    if (typeof w.id !== 'string' || !/^protopedia:\d{1,9}$/.test(w.id) || ids.has(w.id)) {
      return false;
    }
    ids.add(w.id);
    if (typeof w.title !== 'string' || w.title.length === 0) return false;
    if (typeof w.sourceUrl !== 'string' || !w.sourceUrl.startsWith('https://')) return false;
    if (w.generation !== 0) return false;
    // 制作状態（供養/開発中/完成）。1..99 の整数のみ（normalizeWork と同じ制約）。
    if (
      w.status !== undefined &&
      (typeof w.status !== 'number' || !Number.isInteger(w.status) || w.status < 1 || w.status > 99)
    ) {
      return false;
    }
  }
  return true;
}
