import { describe, expect, it } from 'vitest';
import {
  computeGeneration,
  isAncestorDescendantPair,
  nextOffspringId,
  slotKey,
} from '../lib/generation.ts';
import { newIssueUrl, repoConfigFromEnv } from '../lib/config.ts';

describe('computeGeneration', () => {
  it('ProtoPedia親のみなら第1世代', () => {
    expect(computeGeneration([0, 0])).toBe(1);
  });
  it('子を親にすると世代が増える', () => {
    expect(computeGeneration([0, 2])).toBe(3);
  });
  it('親がいないとエラー', () => {
    expect(() => computeGeneration([])).toThrow();
  });
});

describe('nextOffspringId', () => {
  it('空のデータから 000001 を発行する', () => {
    expect(nextOffspringId([])).toBe('mashup-000001');
  });
  it('既存IDと重複しない次のIDを発行する', () => {
    expect(nextOffspringId(['mashup-000001', 'mashup-000007'])).toBe('mashup-000008');
  });
  it('不正なIDは無視する', () => {
    expect(nextOffspringId(['garbage'])).toBe('mashup-000001');
  });
  it('削除済みIDは採番で再利用しない（issue #32）', () => {
    // 削除済みIDは既存IDと合わせて最大値の計算に使う
    expect(nextOffspringId(['mashup-000002'], ['mashup-000001'])).toBe('mashup-000003');
    // 本番データが0件でも、削除済みIDを飛び越えて採番する
    expect(nextOffspringId([], ['mashup-000001'])).toBe('mashup-000002');
    expect(nextOffspringId([], ['mashup-000007'])).toBe('mashup-000008');
    // 引数省略は従来どおり（台帳が無い運用でも壊さない）
    expect(nextOffspringId(['mashup-000001'])).toBe('mashup-000002');
  });
});

describe('slotKey', () => {
  it('UTC基準の YYYY-MM-DDTHH 形式', () => {
    expect(slotKey(new Date('2026-11-09T12:07:00Z'))).toBe('2026-11-09T12');
    expect(slotKey(new Date('2026-01-01T00:59:59Z'))).toBe('2026-01-01T00');
    expect(slotKey(new Date('2026-01-01T01:00:00Z'))).toBe('2026-01-01T01');
  });
});

describe('isAncestorDescendantPair', () => {
  // mashup-000001 の親は protopedia:1,2 / mashup-000002 の親は mashup-000001, protopedia:3
  const edges: [string, string][] = [
    ['protopedia:1', 'mashup-000001'],
    ['protopedia:2', 'mashup-000001'],
    ['mashup-000001', 'mashup-000002'],
    ['protopedia:3', 'mashup-000002'],
  ];

  it('先祖と子孫の組み合わせ（近親交配）を検出する', () => {
    expect(isAncestorDescendantPair('mashup-000002', 'mashup-000001', edges)).toBe(true);
    expect(isAncestorDescendantPair('mashup-000002', 'protopedia:1', edges)).toBe(true);
    expect(isAncestorDescendantPair('mashup-000002', 'protopedia:2', edges)).toBe(true);
  });

  it('先祖・子孫関係にならない組み合わせは許可', () => {
    // protopedia:1 と 3 は互いに先祖ではない
    expect(isAncestorDescendantPair('protopedia:1', 'protopedia:3', edges)).toBe(false);
    // 共通の子を持つ（ダイヤモンド）だけならよい
    expect(isAncestorDescendantPair('protopedia:1', 'protopedia:2', edges)).toBe(false);
    expect(isAncestorDescendantPair('mashup-000001', 'protopedia:3', edges)).toBe(false);
  });
});

describe('repoConfigFromEnv / newIssueUrl', () => {
  it('未設定ならnull（フォロントが警告を出す）', () => {
    expect(repoConfigFromEnv({})).toBeNull();
  });

  it('VITE_* を優先して読む', () => {
    expect(repoConfigFromEnv({ VITE_GITHUB_OWNER: 'o', VITE_GITHUB_REPO: 'r' })).toEqual({
      owner: 'o',
      repo: 'r',
    });
  });

  it('Actionsの GITHUB_REPOSITORY を読む', () => {
    expect(repoConfigFromEnv({ GITHUB_REPOSITORY: 'o/r' })).toEqual({ owner: 'o', repo: 'r' });
  });

  it('Issue作成URLに親IDと本文がURLエンコードされて含まれる', () => {
    const url = newIssueUrl({ owner: 'n0bisuke', repo: 'mashup-ours' }, 'protopedia:1234', 'protopedia:5678');
    expect(url.startsWith('https://github.com/n0bisuke/mashup-ours/issues/new?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('[Breed] protopedia:1234 x protopedia:5678');
    expect(params.get('body')).toContain('parent_a: protopedia:1234');
    expect(params.get('body')).toContain('parent_b: protopedia:5678');
    expect(params.get('body')).toContain('mode: fusion');
  });

  it('リポジトリ名は設定値から来る（ハードコードされていない）', () => {
    const url = newIssueUrl({ owner: 'anyone', repo: 'any-repo' }, 'protopedia:1', 'mashup-000001');
    expect(url).toContain('https://github.com/anyone/any-repo/');
  });
});
