/**
 * 世代計算・ID発行・循環防止・時間枠の計算。
 */

/** ProtoPediaの元作品は第0世代。子は 1 + max(親のgeneration)。 */
export function computeGeneration(parentGenerations: readonly number[]): number {
  if (parentGenerations.length === 0) {
    throw new Error('親がありません');
  }
  return 1 + Math.max(...parentGenerations);
}

/**
 * 次の未使用の子作品IDを発行する（data内の既存IDとの重複を避ける）。
 * retiredIds = 削除済みID（data/deleted-offspring.json）。削除したIDは再利用しない。
 */
export function nextOffspringId(
  existingIds: readonly string[],
  retiredIds: readonly string[] = [],
): string {
  let max = 0;
  for (const id of [...existingIds, ...retiredIds]) {
    const m = /^mashup-(\d{6})$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `mashup-${String(max + 1).padStart(6, '0')}`;
}

/** UTC基準の時間枠キー "YYYY-MM-DDTHH"。1時間枠につき最大1件。 */
export function slotKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}`;
}

/**
 * 「先祖と子孫の配合」（近親交配）を検出する。
 * DAG上では新規ノード追加なので真の循環は生じないが、
 * 系譜として不自然な組み合わせ（片方が片方の祖先）は拒否する方針。
 * graph: parent -> child のエッジ一覧（対象の子を除く）。
 */
export function isAncestorDescendantPair(
  parentA: string,
  parentB: string,
  edges: ReadonlyArray<readonly [string, string]>,
): boolean {
  const descendants = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [p, c] of edges) {
        if (p === cur && !seen.has(c)) {
          seen.add(c);
          queue.push(c);
        }
      }
    }
    return seen;
  };
  // 片方が片方の先祖なら、その組み合わせは系譜上近親交配になる。
  return descendants(parentA).has(parentB) || descendants(parentB).has(parentA);
}
