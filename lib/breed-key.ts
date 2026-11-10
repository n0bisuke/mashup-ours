/**
 * 配合条件の一意キー（issue #37）。
 *
 * 同じ条件（親A・親B・配合タイプ・コメント）なら同じ発明を返し、
 * 1つでも違えば新しい発明を生み出すためのハッシュ。
 *
 * キーに含めるもの:
 *   parentA / parentB / mode / 正規化したコメント の4項目だけ。
 *   **Issue番号・申請日時・スロットなど、申請のたびに変わる値は含めない。**
 * 親の順序は区別する（A×B と B×A は継承内容が変わり、別物として扱う）。
 *
 * 依存は node:crypto だけ。ブラウザからは import せず、`lib/index.ts` からも
 * 再エクスポートしない（フロントのバンドルに node 専用コードを混ぜないため）。
 */
import { createHash } from 'node:crypto';
import type { BreedingRequest } from './types.ts';

/** SHA-256 の16進（小文字）64文字。 */
const HASH_RE = /^[0-9a-f]{64}$/;

export function isRequestHash(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v);
}

/**
 * コメントの正規化。
 * - 改行コード（CRLF / CR）を \n に統一
 * - 前後の空白を落とす
 * - 空白だけのコメントは「コメントなし」（`''`）と同じにする
 * 内容が違うコメントは別の配合として扱う（正規化しない）。
 */
export function normalizeComment(comment: string | undefined): string {
  if (comment === undefined) return '';
  const unified = comment.replace(/\r\n?/g, '\n').trim();
  return unified === '' ? '' : unified;
}

/**
 * 重複判定に使う配合条件。
 * `BreedingRequest` から **slot は意図的に外す**（申請のたびに変わる値はキーに含めない）。
 */
export type BreedCondition = Pick<BreedingRequest, 'parentA' | 'parentB' | 'mode' | 'comment'>;

/**
 * canonical JSON（キー順を固定したJSON文字列）。
 * オブジェクトのリテラル順で組み立てるため、入力が同じなら常に同じ文字列になる。
 */
export function canonicalCondition(input: BreedCondition): string {
  return JSON.stringify({
    parentA: input.parentA,
    parentB: input.parentB,
    mode: input.mode,
    comment: normalizeComment(input.comment),
  });
}

/** 配合条件のSHA-256（小文字16進64文字）。 */
export function requestHashOf(input: BreedCondition): string {
  return createHash('sha256').update(canonicalCondition(input), 'utf8').digest('hex');
}
