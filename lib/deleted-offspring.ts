/**
 * 削除済み子作品IDの台帳（data/deleted-offspring.json）。
 *
 * 削除したIDを「削除済み」として記録しておき、次IDの採番
 * （lib/generation.ts nextOffspringId）に渡すことで再利用を防ぐ。
 * 台帳が無ければ []（採番は data 上の既存IDの最大値で守られる）。
 *
 * Node.js専用（fs を使う）。ブラウザから import しないこと
 * （lib/index.ts からは再エクスポートしない）。
 */
import { existsSync, readFileSync } from 'node:fs';

export const DELETED_OFFSPRING_FILE = new URL(
  '../data/deleted-offspring.json',
  import.meta.url,
);

const ID_RE = /^mashup-\d{6}$/;

/**
 * 台帳を読む。
 * - ファイルが無くてもエラーにしない（削除していない運用でも動く）。
 * - あるのに形が不正なら例外（無視するとIDが再利用されるため黙って続行しない）。
 */
export function readDeletedOffspringIds(fileUrl: URL = DELETED_OFFSPRING_FILE): string[] {
  if (!existsSync(fileUrl)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fileUrl, 'utf8'));
  } catch (e) {
    throw new Error(
      `data/deleted-offspring.json をJSONとして読めません: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('data/deleted-offspring.json はオブジェクトである必要があります');
  }
  const { schemaVersion, deletedIds } = raw as { schemaVersion?: unknown; deletedIds?: unknown };
  if (schemaVersion !== 1) {
    throw new Error('data/deleted-offspring.json: schemaVersion が 1 ではありません');
  }
  if (!Array.isArray(deletedIds)) {
    throw new Error('data/deleted-offspring.json: deletedIds は配列である必要があります');
  }
  const ids = new Set<string>();
  for (const v of deletedIds) {
    if (typeof v !== 'string' || !ID_RE.test(v)) {
      throw new Error(`data/deleted-offspring.json: 削除済みIDの形式が不正です: ${String(v)}`);
    }
    if (ids.has(v)) {
      throw new Error(`data/deleted-offspring.json: 削除済みIDが重複しています: ${v}`);
    }
    ids.add(v);
  }
  return [...ids];
}
