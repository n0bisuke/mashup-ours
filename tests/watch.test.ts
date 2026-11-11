/**
 * 申請確認ポーリング（issue #11 / github-watch.ts）。
 * - 確実に停止する（最大回数・レート制限・キャンセル）
 * - 実通信しない（フェッチを注入する）
 * - 失敗しても無限リトライしない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSeenIssues,
  watchApplyConfirmation,
  GitHubApiError,
  type FetchLike,
  type JsonResponse,
} from '../public/github-watch.ts';
import {
  CONFIRM_DELAYS_MS,
  breedTitle,
  countWaitingRequests,
  type SeenIssue,
} from '../public/breeding-state.ts';

const CFG = { owner: 'test-owner', repo: 'test-repo' };
const PAIR = { parentA: 'protopedia:1234', parentB: 'protopedia:5678' };

function res(status: number, body: unknown): JsonResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function apiIssues(
  over: { title?: string; body?: string | null; state?: string; created_at?: string }[] = [],
): unknown[] {
  return over.map((o, i) => ({
    number: i + 1,
    title: o.title ?? breedTitle(PAIR),
    body: o.body ?? `parent_a: ${PAIR.parentA}\nparent_b: ${PAIR.parentB}`,
    state: o.state ?? 'open',
    created_at: o.created_at ?? '2026-11-09T12:00:00Z',
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

it('fetchSeenIssues: 最小フィールドに正規化し PR を除外する', async () => {
  const fetchImpl: FetchLike = async () =>
    res(200, [
      ...apiIssues([{}]),
      {
        number: 99,
        title: 'some pr',
        body: null,
        state: 'open',
        created_at: '2026-11-09T12:00:00Z',
        pull_request: {},
      },
      { number: 100, title: 'bad date', body: '', state: 'open', created_at: 'not-a-date' },
    ]);
  const issues = await fetchSeenIssues(CFG, fetchImpl);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({
    number: 1,
    title: breedTitle(PAIR),
    state: 'open',
    body: expect.stringContaining('parent_a:'),
  });
});

it('fetchSeenIssues: 非2xx はステータス付きエラー（レート制限判定に使う）', async () => {
  const fetchImpl: FetchLike = async () => res(403, { message: 'rate limited' });
  await expect(fetchSeenIssues(CFG, fetchImpl)).rejects.toThrowError(GitHubApiError);
  const fetchImpl403: FetchLike = async () => res(403, {});
  try {
    await fetchSeenIssues(CFG, fetchImpl403);
    expect.unreachable('エラーになるべき');
  } catch (e) {
    expect((e as GitHubApiError).status).toBe(403);
  }
});

it('申請Issueが見つかったら 1回目のポーリングで confirmed になり停止', async () => {
  vi.useFakeTimers();
  const openedAtMs = Date.parse('2026-11-09T12:00:00Z');
  const fetchImpl: FetchLike = vi.fn(async () => res(200, apiIssues([{}])));
  const results: string[] = [];
  watchApplyConfirmation(CFG, PAIR, openedAtMs, (r) => results.push(r), fetchImpl);

  await vi.advanceTimersByTimeAsync(CONFIRM_DELAYS_MS[0]);
  expect(results).toEqual(['confirmed']);
  // 追試行しない（停止している）
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(results).toEqual(['confirmed']);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('見つからない場合は最大回数で unconfirmed になり必ず停止する', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => res(200, []));
  const results: string[] = [];
  watchApplyConfirmation(
    CFG,
    PAIR,
    Date.parse('2026-11-09T12:00:00Z'),
    (r) => results.push(r),
    fetchImpl,
  );

  const total = CONFIRM_DELAYS_MS.reduce((a, b) => a + b, 0);
  await vi.advanceTimersByTimeAsync(total + 1_000);
  expect(results).toEqual(['unconfirmed']);
  expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(CONFIRM_DELAYS_MS.length);
  // その後もポーリングしない
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(results).toEqual(['unconfirmed']);
});

it('レート制限（403/429）は即 unconfirmed で停止（無意味な再試行をしない）', async () => {
  vi.useFakeTimers();
  for (const status of [403, 429]) {
    const fetchImpl: FetchLike = vi.fn(async () => res(status, {}));
    const results: string[] = [];
    watchApplyConfirmation(
      CFG,
      PAIR,
      Date.parse('2026-11-09T12:00:00Z'),
      (r) => results.push(r),
      fetchImpl,
    );
    await vi.advanceTimersByTimeAsync(CONFIRM_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(results).toEqual(['unconfirmed']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }
});

it('ネットワーク障害は3回連続で unconfirmed にフォールバック（無限リトライしない）', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async (): Promise<JsonResponse> => {
    throw new Error('network down');
  });
  const results: string[] = [];
  watchApplyConfirmation(
    CFG,
    PAIR,
    Date.parse('2026-11-09T12:00:00Z'),
    (r) => results.push(r),
    fetchImpl,
  );
  for (const d of CONFIRM_DELAYS_MS) {
    if (results.length > 0) break;
    await vi.advanceTimersByTimeAsync(d);
  }
  expect(results).toEqual(['unconfirmed']);
  expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
});

it('キャンセル後はフェッチも結果通知も止まる', async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => res(200, []));
  const results: string[] = [];
  const cancel = watchApplyConfirmation(
    CFG,
    PAIR,
    Date.parse('2026-11-09T12:00:00Z'),
    (r) => results.push(r),
    fetchImpl,
  );
  cancel();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(results).toEqual([]);
});

describe('countWaitingRequests（issue #48・待機中の配合申請数）', () => {
  it('open な [Breed] 申請だけを数える', () => {
    const issues: SeenIssue[] = [
      { number: 1, title: '[Breed] protopedia:1 x protopedia:2', body: '', state: 'open', createdAt: '2026-11-10T00:00:00Z' },
      { number: 2, title: '[Breed] mashup-000002 x protopedia:3', body: '', state: 'open', createdAt: '2026-11-10T01:00:00Z' },
      { number: 3, title: '[Breed] protopedia:4 x protopedia:5', body: '', state: 'closed', createdAt: '2026-11-10T02:00:00Z' },
      { number: 4, title: '[Fix] 雑談Issue', body: '', state: 'open', createdAt: '2026-11-10T03:00:00Z' },
      { number: 5, title: '別件', body: 'parent_a: protopedia:1', state: 'open', createdAt: '2026-11-10T04:00:00Z' },
    ];
    expect(countWaitingRequests(issues)).toBe(2);
  });

  it('配合理で検出できない申請（タイトル非準拠・本文のみ）は数えない（表示は近似値）', () => {
    const issues: SeenIssue[] = [
      { number: 6, title: '本文だけの申請', body: 'parent_a: protopedia:1\nparent_b: protopedia:2', state: 'open', createdAt: '2026-11-10T00:00:00Z' },
    ];
    expect(countWaitingRequests(issues)).toBe(0);
  });
});
