/**
 * data/*.json の自動union（issue #52・scripts/sync-data.mjs）。
 * - offspring: id 一致のみ追加・削除台帳のIDは再追加しない・同一ID内容違いはローカル優先
 * - 台帳: deletedIds と notes の union（同文 dedupe）
 * - processed-issues: Issue番号 union（attempts 最大・at 新）
 * - ai-usage / breeding-state: カウンタは最大値（二重加算しない）
 */
import { expect, it } from 'vitest';
import {
  unionOffspring,
  unionLedger,
  unionProcessed,
  unionCounters,
  unionBreedingState,
} from '../scripts/sync-data.mjs';

const o = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

it('offspring: リモートのみのIDを追加し、重複と削除済みは追加しない', () => {
  const local = [o('mashup-000002'), o('mashup-000006', { requesterAuto: true })];
  const remote = [
    o('mashup-000002'), // 両側 = 追加しない
    o('mashup-000004'), // 削除台帳 = 再追加しない
    o('mashup-000007', { title: '新しい子' }), // リモートのみ = 追加
  ];
  const r = unionOffspring(local, remote, new Set(['mashup-000004']));
  expect(r.addedIds).toEqual(['mashup-000007']);
  expect(r.result.map((x: { id: string }) => x.id)).toEqual([
    'mashup-000002',
    'mashup-000006',
    'mashup-000007',
  ]);
});

it('offspring: 同一IDで内容が違う項目はローカルを優先する（上書きしない）', () => {
  const local = [o('mashup-000002', { summary: 'ローカルの編集' })];
  const remote = [o('mashup-000002', { summary: 'リモート側' })];
  const r = unionOffspring(local, remote, new Set());
  expect(r.addedIds).toEqual([]);
  expect(r.result[0].summary).toBe('ローカルの編集');
});

it('台帳: deletedIds と notes を union する（同文は1回）', () => {
  const r = unionLedger(
    { schemaVersion: 1, deletedIds: ['mashup-000001'], notes: ['note A'] },
    { deletedIds: ['mashup-000001', 'mashup-000004'], notes: ['note A', 'note B'] },
  );
  expect(deletedSort2(r.deletedIds)).toEqual(['mashup-000001', 'mashup-000004']);
  expect(r.notes).toEqual(['note A', 'note B']);
});

const deletedSort2 = (a: string[]) => [...a].sort();

it('processed-issues: 無い番号を追加し、既存番号は attempts 最大・at 新を採用する', () => {
  const r = unionProcessed(
    { 12: { issue: 12, status: 'resolved', at: '2026-11-09T00:00:00Z', attempts: 1 } },
    {
      12: { issue: 12, status: 'failed', at: '2026-11-09T01:00:00Z', attempts: 2 },
      13: { issue: 13, status: 'resolved', at: '2026-11-10T00:00:00Z', attempts: 1 },
    },
  );
  expect(r.merged).toBe(2);
  expect(r.result[13].status).toBe('resolved');
  expect(r.result[12].attempts).toBe(2);
  expect(r.result[12].status).toBe('failed');
});

it('ai-usage: 同じ日を両側で数えても最大値で統合する（二重加算しない）', () => {
  const r = unionCounters(
    { schemaVersion: 1, days: { '2026-11-10': { textCalls: 4, outputTokens: 1000 } } },
    { schemaVersion: 1, days: { '2026-11-10': { textCalls: 10, outputTokens: 900 }, '2026-11-11': { textCalls: 2 } } },
  );
  expect(r.result.days['2026-11-10'].textCalls).toBe(10);
  expect(r.result.days['2026-11-10'].outputTokens).toBe(1000);
  expect(r.result.days['2026-11-11'].textCalls).toBe(2);
});

it('breeding-state: lastSlot は新しい方、aiCalls は最大値、consecutiveFailures は大きい方', () => {
  const r = unionBreedingState(
    {
      aiCalls: { '2026-11-10': 5 },
      lastSlot: '2026-11-11T1800JST',
      consecutiveFailures: 0,
    },
    {
      aiCalls: { '2026-11-10': 8, '2026-11-11': 3 },
      lastSlot: '2026-11-11T2100JST',
      consecutiveFailures: 2,
    },
  );
  expect(r.result.aiCalls['2026-11-10']).toBe(8);
  expect(r.result.aiCalls['2026-11-11']).toBe(3);
  expect(r.result.lastSlot).toBe('2026-11-11T2100JST');
  expect(r.result.consecutiveFailures).toBe(2);
});
