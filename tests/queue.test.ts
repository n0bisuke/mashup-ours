/**
 * 配合キュー選択のテスト（issue #16 / AGENTS.md「キュー取得・バリデーション」）。
 * - 作成日時昇順で最古の妥当な申請を1件だけ選ぶ
 * - ラベルを信用しない（タイトル/本文の形式で判定）
 * - 処理済みIssue（resolved/rejected は永却下、failed は上限まで再試行）を再処理しない
 * - 存在しないID・祖先×子孫は AI呼び出し前に却下
 * - 同じ配合条件（親A/親B/配合タイプ/コメント）は reuse（再利用・AIなし）。
 *   親が同じでも条件が1つでも違えば新規生成（issue #37）
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FAILED_ATTEMPTS,
  isProcessedIssues,
  looksLikeBreedingIssue,
  selectBreedingIssue,
  type IssueRecord,
  type ProcessedIssues,
} from '../lib/queue.ts';
import { requestHashOf } from '../lib/breed-key.ts';

const proto = new Set(['protopedia:1', 'protopedia:2', 'protopedia:3']);
const kids = new Set(['mashup-000001']);

const issue = (
  number: number,
  createdAt: string,
  body: string,
  title = `[Breed] #${number}`,
): IssueRecord => ({ number, title, body, createdAt });

const validBody = (a: string, b: string): string =>
  `parent_a: ${a}\nparent_b: ${b}\nmode: fusion`;

const baseOpts = (
  processed: ProcessedIssues = {},
  extra: Partial<Parameters<typeof selectBreedingIssue>[1]> = {},
) => ({
  processed,
  knownProtopediaIds: proto,
  knownOffspringIds: kids,
  existingByRequestHash: new Map<string, string>(),
  edges: [] as ReadonlyArray<readonly [string, string]>,
  ...extra,
});

describe('looksLikeBreedingIssue', () => {
  it('タイトルの [Breed] か本文の parent_a: 行で判定する', () => {
    expect(looksLikeBreedingIssue({ title: '[Breed] a x b', body: '' })).toBe(true);
    expect(looksLikeBreedingIssue({ title: '別件', body: 'parent_a: protopedia:1' })).toBe(true);
    expect(looksLikeBreedingIssue({ title: '別件', body: '連絡のみ' })).toBe(false);
  });
});

describe('selectBreedingIssue', () => {
  it('候補が無ければ none', () => {
    expect(selectBreedingIssue([], baseOpts())).toEqual({ action: 'none' });
    expect(
      selectBreedingIssue(
        [issue(1, '2026-11-01T00:00:00Z', 'ただの日記', 'お問い合わせについて')],
        baseOpts(),
      ),
    ).toEqual({ action: 'none' });
  });

  it('作成日時が最古の妥当な申請を選ぶ（入力順に依存しない）', () => {
    const newer = issue(2, '2026-11-02T00:00:00Z', validBody('protopedia:1', 'protopedia:2'));
    const older = issue(5, '2026-11-01T00:00:00Z', validBody('protopedia:2', 'protopedia:3'));
    const r = selectBreedingIssue([newer, older], baseOpts());
    expect(r.action).toBe('process');
    if (r.action === 'process') {
      expect(r.issue.number).toBe(5);
      expect(r.request.parentA).toBe('protopedia:2');
    }
  });

  it('最古が不正なら却下対象として返す（その次の妥当な申請は次回以降）', () => {
    const broken = issue(1, '2026-11-01T00:00:00Z', 'parent_a: protopedia:1\nparent_b: protopedia:1');
    const ok = issue(2, '2026-11-02T00:00:00Z', validBody('protopedia:1', 'protopedia:2'));
    const r = selectBreedingIssue([ok, broken], baseOpts());
    expect(r.action).toBe('reject');
    if (r.action === 'reject') {
      expect(r.issue.number).toBe(1);
      expect(r.request).toBeNull(); // パース前に却下
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('存在しないIDは AI呼び出し前に却下', () => {
    const r = selectBreedingIssue(
      [issue(1, '2026-11-01T00:00:00Z', validBody('protopedia:999', 'protopedia:1'))],
      baseOpts(),
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') expect(r.request).not.toBeNull();
  });

  it('まだ生まれていない子作品は親にできない', () => {
    const r = selectBreedingIssue(
      [issue(1, '2026-11-01T00:00:00Z', validBody('mashup-000002', 'protopedia:1'))],
      baseOpts(),
    );
    expect(r.action).toBe('reject');
  });

  it('resolved / rejected は再処理しない（二重処理防止）', () => {
    const iss = issue(7, '2026-11-01T00:00:00Z', validBody('protopedia:1', 'protopedia:2'));
    for (const status of ['resolved', 'rejected'] as const) {
      const processed: ProcessedIssues = {
        7: { issue: 7, status, at: '2026-11-01T01:00:00Z', attempts: 1 },
      };
      expect(selectBreedingIssue([iss], baseOpts(processed))).toEqual({ action: 'none' });
    }
  });

  it('failed は上限までは再試行し、上限を超えたら処理しない', () => {
    const iss = issue(7, '2026-11-01T00:00:00Z', validBody('protopedia:1', 'protopedia:2'));
    const below: ProcessedIssues = {
      7: { issue: 7, status: 'failed', at: '2026-11-01T01:00:00Z', attempts: 1 },
    };
    expect(selectBreedingIssue([iss], baseOpts(below)).action).toBe('process');
    const atMax: ProcessedIssues = {
      7: {
        issue: 7,
        status: 'failed',
        at: '2026-11-01T01:00:00Z',
        attempts: MAX_FAILED_ATTEMPTS,
      },
    };
    expect(selectBreedingIssue([iss], baseOpts(atMax))).toEqual({ action: 'none' });
  });

  it('処理済みの古い申請より、未処理の新しい申請を選ぶ', () => {
    const doneOld = issue(1, '2026-11-01T00:00:00Z', validBody('protopedia:1', 'protopedia:2'));
    const fresh = issue(2, '2026-11-02T00:00:00Z', validBody('protopedia:2', 'protopedia:3'));
    const processed: ProcessedIssues = {
      1: { issue: 1, status: 'resolved', at: '2026-11-01T01:00:00Z', attempts: 1 },
    };
    const r = selectBreedingIssue([doneOld, fresh], baseOpts(processed));
    expect(r.action).toBe('process');
    if (r.action === 'process') expect(r.issue.number).toBe(2);
  });

  it('同じ配合条件の発明がすでにあれば reuse（AI呼び出しなし・既存IDを返す）', () => {
    const body = `parent_a: protopedia:2\nparent_b: protopedia:1\nmode: fusion`;
    const hash = requestHashOf({
      parentA: 'protopedia:2',
      parentB: 'protopedia:1',
      mode: 'fusion',
    });
    const r = selectBreedingIssue(
      [issue(3, '2026-11-01T00:00:00Z', body)],
      baseOpts({}, { existingByRequestHash: new Map([[hash, 'mashup-000001']]) }),
    );
    expect(r.action).toBe('reuse');
    if (r.action === 'reuse') expect(r.existingId).toBe('mashup-000001');
  });

  it('親が同じでもコメントが違えば新規生成する', () => {
    const hash = requestHashOf({
      parentA: 'protopedia:1',
      parentB: 'protopedia:2',
      mode: 'fusion',
      comment: '公園で',
    });
    const body = 'parent_a: protopedia:1\nparent_b: protopedia:2\nmode: fusion\ncomment: 公園で遊びたい';
    const r = selectBreedingIssue(
      [issue(3, '2026-11-10T00:00:00Z', body)],
      baseOpts({}, { existingByRequestHash: new Map([[hash, 'mashup-000001']]) }),
    );
    expect(r.action).toBe('process');
  });

  it('コメントなしと空白だけのコメントは同じ配合として reuse される', () => {
    const hash = requestHashOf({
      parentA: 'protopedia:1',
      parentB: 'protopedia:2',
      mode: 'fusion',
    });
    const body = 'parent_a: protopedia:1\nparent_b: protopedia:2\nmode: fusion\ncomment:    ';
    const r = selectBreedingIssue(
      [issue(3, '2026-11-10T00:00:00Z', body)],
      baseOpts({}, { existingByRequestHash: new Map([[hash, 'mashup-000001']]) }),
    );
    expect(r.action).toBe('reuse');
  });

  it('親が同じでも配合タイプが違えば新規生成する', () => {
    const hash = requestHashOf({
      parentA: 'protopedia:1',
      parentB: 'protopedia:2',
      mode: 'fusion',
    });
    const body = 'parent_a: protopedia:1\nparent_b: protopedia:2\nmode: mutation';
    const r = selectBreedingIssue(
      [issue(3, '2026-11-10T00:00:00Z', body)],
      baseOpts({}, { existingByRequestHash: new Map([[hash, 'mashup-000001']]) }),
    );
    expect(r.action).toBe('process');
  });

  it('親の順序が違う申請（B×A）は同じキーに一致しない', () => {
    const hash = requestHashOf({
      parentA: 'protopedia:1',
      parentB: 'protopedia:2',
      mode: 'fusion',
    });
    const body = 'parent_a: protopedia:2\nparent_b: protopedia:1\nmode: fusion';
    const r = selectBreedingIssue(
      [issue(3, '2026-11-10T00:00:00Z', body)],
      baseOpts({}, { existingByRequestHash: new Map([[hash, 'mashup-000001']]) }),
    );
    expect(r.action).toBe('process');
  });

  it('祖先×子孫の組み合わせ（近親交配）は却下する（キャッシュヒットでも）', () => {
    // protopedia:1 -> mashup-000001 の系譜で、その両端を親に指定
    const r = selectBreedingIssue(
      [issue(3, '2026-11-01T00:00:00Z', validBody('protopedia:1', 'mashup-000001'))],
      baseOpts({}, { edges: [['protopedia:1', 'mashup-000001']] }),
    );
    expect(r.action).toBe('reject');
    if (r.action === 'reject') expect(r.reason).toContain('先祖');
  });

  it('申請に見えないIssueは候補にしない（ラベル非信用・本文が正）', () => {
    const labelOnly = issue(
      1,
      '2026-11-01T00:00:00Z',
      'breeding-request ラベルだけ貼られた',
      'この件について',
    );
    expect(selectBreedingIssue([labelOnly], baseOpts())).toEqual({ action: 'none' });
  });

  it('同じ日時は Issue番号が小さい方が先（決着を確定的にする）', () => {
    const t = '2026-11-01T00:00:00Z';
    const a = issue(2, t, validBody('protopedia:1', 'protopedia:2'));
    const b = issue(9, t, validBody('protopedia:2', 'protopedia:3'));
    const r = selectBreedingIssue([b, a], baseOpts());
    if (r.action === 'process') expect(r.issue.number).toBe(2);
  });
});

describe('isProcessedIssues', () => {
  it('正常な記録を受理する', () => {
    expect(
      isProcessedIssues({
        12: { issue: 12, status: 'resolved', at: '2026-11-01T00:00:00Z', attempts: 1 },
        13: { issue: 13, status: 'failed', at: '2026-11-01T00:00:00Z', attempts: 3, reason: 'x' },
      }),
    ).toBe(true);
  });

  it('壊れた記録を拒否する（ワーカーは安全側で停止する）', () => {
    expect(isProcessedIssues(null)).toBe(false);
    expect(isProcessedIssues([])).toBe(false);
    expect(isProcessedIssues({ abc: { issue: 1, status: 'resolved', at: 'x', attempts: 1 } })).toBe(
      false,
    );
    expect(
      isProcessedIssues({ 1: { issue: 2, status: 'resolved', at: 'x', attempts: 1 } }),
    ).toBe(false); // key と issue が不一致
    expect(isProcessedIssues({ 1: { issue: 1, status: 'done', at: 'x', attempts: 1 } })).toBe(false);
    expect(isProcessedIssues({ 1: { issue: 1, status: 'resolved', at: 'x', attempts: 0 } })).toBe(
      false,
    );
  });
});
