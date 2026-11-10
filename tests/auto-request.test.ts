/**
 * 自動配合申請のテスト（issue #27）。
 * - 判定: 直近8時間に申請があれば作らない / 無ければ1件だけ作る
 * - 未処理の open 申請は積み増さしない / failed 上限超過は「処理済み」とみなす
 * - 選出: 生成AIなしの乱数、別ID・生成済みペア・祖先×子孫を避ける
 * - フォーマット: 人手の申請と同一（パーサーを通る）+ 自動申請の目印
 * - APIアダプター: Issue作成・ラベル付与・直近取得のリクエスト形状
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_REQUEST_MARKER,
  AUTO_REQUEST_SOURCE,
  decorateAutoIssueBody,
  isAutoRequestIssue,
  selectAutoPair,
  shouldCreateAutoRequest,
} from '../lib/auto-request.ts';
import { buildIssueForm, newIssueUrl } from '../lib/config.ts';
import { GitHubApiError, addIssueLabels, createIssue, listRecentIssues } from '../lib/github.ts';
import { parseBreedingIssue } from '../lib/issue.ts';
import { looksLikeBreedingIssue, type IssueRecord, type ProcessedIssues } from '../lib/queue.ts';

const NOW = new Date('2026-11-10T12:00:00Z');
const H = 3_600_000;

const issue = (
  number: number,
  createdAt: string,
  opts: { title?: string; body?: string; state?: 'open' | 'closed' } = {},
): IssueRecord => ({
  number,
  title: opts.title ?? `[Breed] protopedia:${number} x protopedia:${number + 1}`,
  body: opts.body ?? `parent_a: protopedia:${number}\nparent_b: protopedia:${number + 1}`,
  createdAt,
});

const decide = (
  recent: IssueRecord[],
  open: IssueRecord[] = [],
  processed: ProcessedIssues = {},
  idleHours = 8,
) => shouldCreateAutoRequest({ recent, open, processed, idleHours, now: NOW });

describe('shouldCreateAutoRequest（直近8時間の判定 / issue #27）', () => {
  it('申請が1件もなければ作成する', () => {
    const d = decide([]);
    expect(d.create).toBe(true);
    expect(d.reason).toContain('8時間');
  });

  it('直近8時間以内の申請（open/closed どちらでも）があれば作成しない', () => {
    const freshOpen = issue(30, new Date(NOW.getTime() - 1 * H).toISOString());
    const freshClosed = issue(29, new Date(NOW.getTime() - 7.9 * H).toISOString(), {
      title: '[Breed] done',
    });
    expect(decide([freshClosed]).create).toBe(false);
    expect(decide([freshOpen], [freshOpen]).create).toBe(false);
    expect(decide([freshOpen]).reason).toContain('#30');
  });

  it('8時間ぴったり前の申請は「直近8時間以内」とみなす（厳密に超えたときだけ作る）', () => {
    const exact = issue(28, new Date(NOW.getTime() - 8 * H).toISOString());
    expect(decide([exact]).create).toBe(false);
    const older = issue(27, new Date(NOW.getTime() - 8 * H - 1).toISOString());
    expect(decide([older]).create).toBe(true);
  });

  it('古い申請だけなら作成する（新しい順のリストで最初の該当件を拾う）', () => {
    const old = issue(26, new Date(NOW.getTime() - 30 * H).toISOString());
    const older = issue(25, new Date(NOW.getTime() - 40 * H).toISOString());
    expect(decide([old, older]).create).toBe(true);
  });

  it('機能追加などのIssueは「申請」と数えない（配合申請に見えるものだけ）', () => {
    const dev = issue(24, new Date(NOW.getTime() - 1 * H).toISOString(), {
      title: '[Auto] 機能追加のissue',
      body: '## 目的\n仕様の本文',
    });
    expect(looksLikeBreedingIssue(dev)).toBe(false);
    expect(decide([dev]).create).toBe(true);
  });

  it('作成日時が読めないIssueは判断材料にしない', () => {
    expect(decide([issue(23, 'not-a-date')]).create).toBe(true);
  });

  it('idleHours: 0 は無効化（作らない）', () => {
    const d = decide([], [], {}, 0);
    expect(d.create).toBe(false);
    expect(d.reason).toContain('無効');
  });

  it('未処理の open 申請があれば積み増さしない', () => {
    const pending = issue(22, new Date(NOW.getTime() - 30 * H).toISOString());
    const d = decide([], [pending]);
    expect(d.create).toBe(false);
    expect(d.reason).toContain('#22');
  });

  it('処理済み（resolved/rejected）の open は「処理済み」とみなして作成を続ける', () => {
    const done = issue(21, new Date(NOW.getTime() - 30 * H).toISOString());
    const processed: ProcessedIssues = {
      21: { issue: 21, status: 'resolved', at: NOW.toISOString(), attempts: 1 },
    };
    expect(decide([], [done], processed).create).toBe(true);
    const rejected: ProcessedIssues = {
      21: { issue: 21, status: 'rejected', at: NOW.toISOString(), attempts: 1 },
    };
    expect(decide([], [done], rejected).create).toBe(true);
  });

  it('failed は再試行上限までは「処理中」、上限に達したら止まらない', () => {
    const failed = issue(20, new Date(NOW.getTime() - 30 * H).toISOString());
    const retrying: ProcessedIssues = {
      20: { issue: 20, status: 'failed', at: NOW.toISOString(), attempts: 1 },
    };
    expect(decide([], [failed], retrying).create).toBe(false);
    const gaveUp: ProcessedIssues = {
      20: { issue: 20, status: 'failed', at: NOW.toISOString(), attempts: 3 },
    };
    expect(decide([], [failed], gaveUp).create).toBe(true);
  });

  it('自動申請のIssueも「申請」として数える（最大8時間に1件の自己制御）', () => {
    const auto = issue(19, new Date(NOW.getTime() - 2 * H).toISOString(), {
      body: `parent_a: protopedia:1\nparent_b: protopedia:2\n${AUTO_REQUEST_MARKER}`,
    });
    expect(isAutoRequestIssue(auto.body)).toBe(true);
    expect(decide([auto]).create).toBe(false);
  });
});

describe('selectAutoPair（ランダム選出・AIなし / issue #27）', () => {
  const pool = ['protopedia:1', 'protopedia:2', 'protopedia:3', 'mashup-000001'];

  it('別々の2IDを返す（不正ID・重複は除外される）', () => {
    const pair = selectAutoPair({
      pool: [...pool, 'protopedia:1', 'evil:id', 'toolong'.repeat(20)],
      offspringPairs: [],
      edges: [],
      rng: () => 0.5,
    });
    expect(pair).not.toBeNull();
    expect(pair?.[0]).not.toBe(pair?.[1]);
    for (const id of pair ?? []) {
      expect(id).toMatch(/^(protopedia:\d{1,9}|mashup-\d{1,9})$/);
    }
  });

  it('有効IDが2件未満なら null', () => {
    expect(selectAutoPair({ pool: ['protopedia:1'], offspringPairs: [], edges: [] })).toBeNull();
    expect(
      selectAutoPair({ pool: ['protopedia:1', 'bad:id'], offspringPairs: [], edges: [] }),
    ).toBeNull();
    expect(selectAutoPair({ pool: [], offspringPairs: [], edges: [] })).toBeNull();
  });

  it('すでに生成済みのペアは選ばない（順不同で判定）', () => {
    const pair = selectAutoPair({
      pool: ['protopedia:1', 'protopedia:2'],
      offspringPairs: [['protopedia:1', 'protopedia:2']],
      edges: [],
      rng: () => 0,
    });
    expect(pair).toBeNull(); // プール2件はそのペアしか無い → 有効ペア0件
    const wider = selectAutoPair({
      pool: ['protopedia:1', 'protopedia:2', 'protopedia:3'],
      offspringPairs: [['protopedia:2', 'protopedia:1']],
      edges: [],
      rng: () => 0,
    });
    expect(wider).not.toBeNull();
    expect(new Set(wider ?? [])).not.toEqual(new Set(['protopedia:1', 'protopedia:2']));
  });

  it('祖先×子孫（系譜上 近親交配）は選ばない', () => {
    // protopedia:1 → mashup-000001 の系譜
    const edges: ReadonlyArray<readonly [string, string]> = [
      ['protopedia:1', 'mashup-000001'],
    ];
    const pair = selectAutoPair({
      pool: ['protopedia:1', 'mashup-000001'],
      offspringPairs: [],
      edges,
      rng: () => 0,
    });
    expect(pair).toBeNull();
    const ok = selectAutoPair({
      pool: ['protopedia:1', 'mashup-000001', 'protopedia:2'],
      offspringPairs: [],
      edges,
      rng: () => 0,
    });
    expect(ok).not.toBeNull();
    expect(ok).toContain('protopedia:2');
  });

  it('同じシード（乱数）なら同じ結果（再実行で申請がぶれない）', () => {
    const opts = { pool, offspringPairs: [], edges: [] };
    const a = selectAutoPair({ ...opts, rng: () => 0.1 });
    const b = selectAutoPair({ ...opts, rng: () => 0.1 });
    expect(a).toEqual(b);
  });

  it('検査回数の上限を超えたら null（無限に走査しない）', () => {
    const big = Array.from({ length: 60 }, (_, i) => `protopedia:${i + 1}`);
    // すべてのペアが生成済み → 検査が上限まで進む
    const pairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < big.length; i++) {
      for (let j = i + 1; j < big.length; j++) pairs.push([big[i], big[j]]);
    }
    expect(
      selectAutoPair({ pool: big, offspringPairs: pairs, edges: [], rng: () => 0, maxChecks: 10 }),
    ).toBeNull();
  });
});

describe('自動申請のフォーマット（人手の申請と同一 / issue #27）', () => {
  const base = buildIssueForm('protopedia:1234', 'protopedia:5678', {
    mode: 'fusion',
    slot: '2026-11-10T1200',
    parentAUrl: 'https://protopedia.net/works/1234',
  });
  const form = decorateAutoIssueBody(base, 8);

  it('タイトル・本文は人手の申請と同一で、ワーカーのパーサーを通る', () => {
    expect(form.title).toBe('[Breed] protopedia:1234 x protopedia:5678');
    const parsed = parseBreedingIssue(form.body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.parentA).toBe('protopedia:1234');
      expect(parsed.request.parentB).toBe('protopedia:5678');
      expect(parsed.request.mode).toBe('fusion');
      expect(parsed.request.slot).toBe('2026-11-10T1200');
      expect(parsed.request.comment).toBeUndefined();
    }
  });

  it('自動申請の目印と選出方法の記録が入る（人間にも見える）', () => {
    expect(isAutoRequestIssue(form.body)).toBe(true);
    expect(form.body).toContain(AUTO_REQUEST_SOURCE);
    expect(form.body).toContain('自動申請');
    expect(form.body).toContain('直近8時間');
    expect(form.body).toContain('生成AIは使っていません');
    expect(isAutoRequestIssue(buildIssueForm('protopedia:1', 'protopedia:2').body)).toBe(false);
  });

  it('newIssueUrl は同じ title/body をURL化している（UIと自動申請が一致）', () => {
    const url = new URL(newIssueUrl({ owner: 'o', repo: 'r' }, 'protopedia:1234', 'protopedia:5678', {
      mode: 'fusion',
      slot: '2026-11-10T1200',
      parentAUrl: 'https://protopedia.net/works/1234',
    }));
    expect(url.searchParams.get('title')).toBe(base.title);
    expect(url.searchParams.get('body')).toBe(base.body);
  });
});

describe('GitHub APIアダプター（作成・ラベル・直近取得）', () => {
  const gh = { token: 'T', repo: 'owner/repo' };

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('createIssue は title/body をJSONで送り、番号を返す', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { title: string; body: string };
      expect(payload.title).toBe('[Breed] a x b');
      expect(payload.body).toContain('parent_a: a');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer T');
      return jsonResponse({ number: 42 });
    });
    const n = await createIssue({ title: '[Breed] a x b', body: 'parent_a: a' }, { ...gh, fetchImpl });
    expect(n).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('createIssue は空タイトル・巨大本文をAPI前に拒否する', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ number: 1 }));
    await expect(createIssue({ title: '  ', body: 'x' }, { ...gh, fetchImpl })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
    await expect(
      createIssue({ title: 't', body: 'x'.repeat(65_537) }, { ...gh, fetchImpl }),
    ).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('createIssue は応答に番号が無ければ失敗として扱う', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(createIssue({ title: 't', body: 'b' }, { ...gh, fetchImpl })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it('addIssueLabels はラベルをJSON配列で送る（ベストエフォート）', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toContain('/issues/42/labels');
      expect(JSON.parse(String(init?.body))).toEqual({ labels: ['breeding-request'] });
      return jsonResponse([{ name: 'breeding-request' }]);
    });
    await addIssueLabels(42, ['breeding-request'], { ...gh, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('listRecentIssues は state=all・新しい順で取得し、PRを除く', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => {
      const url = String(u);
      expect(url).toContain('state=all');
      expect(url).toContain('direction=desc');
      expect(url).toContain('per_page=30');
      return jsonResponse([
        { number: 5, title: 't', body: 'b', created_at: '2026-11-10T11:00:00Z' },
        { number: 4, title: 'pr', body: '', created_at: '2026-11-10T10:00:00Z', pull_request: {} },
        { title: '番号なし' },
      ]);
    });
    const rows = await listRecentIssues({ ...gh, fetchImpl });
    expect(rows).toEqual([
      { number: 5, title: 't', body: 'b', createdAt: '2026-11-10T11:00:00Z' },
    ]);
  });
});
