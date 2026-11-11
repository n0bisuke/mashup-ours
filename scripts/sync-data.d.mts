/** scripts/sync-data.mjs の型（テストから使う union 純関数のみ・issue #52）
 * データの形は lib/types.ts 側で厳密に持つため、こちらは疎にする。 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export function unionOffspring(
  local: any[],
  remote: any[],
  deletedIds: ReadonlySet<string>,
): { result: any[]; addedIds: string[] };

export function unionLedger(
  local: { schemaVersion?: number; deletedIds?: string[]; notes?: string[] } | null,
  remote: { deletedIds?: string[]; notes?: string[] } | null,
): { schemaVersion: number; deletedIds: string[]; notes: string[] };

export function unionProcessed(
  local: Record<string, any>,
  remote: Record<string, any>,
): { result: Record<string, any>; merged: number };

export function unionCounters(local: any, remote: any): { result: any; merged: number };

export function unionBreedingState(local: any, remote: any): { result: any; merged: number };
