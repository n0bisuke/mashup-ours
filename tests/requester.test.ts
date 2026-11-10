/**
 * 配合申請者のGitHub情報（issue #42）。
 * - `isRequester` の書式検証（login / avatarUrl は avatars.githubusercontent.com のみ）
 * - GitHub API の Issue JSON から user の2項目だけを抽出する（listOpenIssues）
 * - 不正・欠損は項目ごと省く（処理を止めない fail-safe）
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REQUESTER_AVATAR_RE,
  REQUESTER_LOGIN_RE,
  isRequester,
  type Offspring,
} from '../lib/types.ts';
import { listOpenIssues } from '../lib/github.ts';

const ok = { login: 'n0bisuke', avatarUrl: 'https://avatars.githubusercontent.com/u/12345?v=4' };

describe('isRequester / 書式', () => {
  it('login の書式（英数とハイフン・ハイフン始終端不可）', () => {
    expect(REQUESTER_LOGIN_RE.test('a')).toBe(true);
    expect(REQUESTER_LOGIN_RE.test('n0bisuke')).toBe(true);
    expect(REQUESTER_LOGIN_RE.test('a-b-c')).toBe(true);
    expect(REQUESTER_LOGIN_RE.test('-abc')).toBe(false);
    expect(REQUESTER_LOGIN_RE.test('abc-')).toBe(false);
    expect(REQUESTER_LOGIN_RE.test('bad login!')).toBe(false);
    expect(REQUESTER_LOGIN_RE.test('')).toBe(false);
    // 1文字（上限39の半角）は許可・40文字以上は不許可
    expect(REQUESTER_LOGIN_RE.test('a'.repeat(39))).toBe(true);
    expect(REQUESTER_LOGIN_RE.test('a'.repeat(40))).toBe(false);
    expect(REQUESTER_LOGIN_RE.test('あ')).toBe(false);
  });

  it('avatarUrl は GitHub のアバターCDNのみ受理する', () => {
    expect(REQUESTER_AVATAR_RE.test('https://avatars.githubusercontent.com/u/12345')).toBe(true);
    expect(REQUESTER_AVATAR_RE.test('https://avatars.githubusercontent.com/u/12345?v=4&s=88')).toBe(true);
    // 任意のURLは信用しない（リダイレクタ・他ドメイン・http・パス偽装を全部拒否）
    expect(REQUESTER_AVATAR_RE.test('https://evil.example.com/u/1')).toBe(false);
    expect(REQUESTER_AVATAR_RE.test('http://avatars.githubusercontent.com/u/1')).toBe(false);
    expect(REQUESTER_AVATAR_RE.test('https://avatars.githubusercontent.com.example.com/u/1')).toBe(false);
    expect(REQUESTER_AVATAR_RE.test('https://github.com/avatars/u/1')).toBe(false);
    // ユーザーアバター（/u/<数字>）以外の形（組織・リポジトリ画像など）も受理しない
    expect(REQUESTER_AVATAR_RE.test('https://avatars.githubusercontent.com/in-org/1')).toBe(false);
    expect(REQUESTER_AVATAR_RE.test('https://avatars.githubusercontent.com/u/')).toBe(false);
  });

  it('isRequester は正しい形だけ通す', () => {
    expect(isRequester(ok)).toBe(true);
    expect(isRequester({ login: 'a', avatarUrl: 'https://avatars.githubusercontent.com/u/1' })).toBe(true);
    expect(isRequester(null)).toBe(false);
    expect(isRequester([])).toBe(false);
    expect(isRequester({ login: '', avatarUrl: 'https://avatars.githubusercontent.com/u/1' })).toBe(false);
    expect(isRequester({ login: ok.login })).toBe(false); // avatarUrl 欠損
    expect(isRequester({ ...ok, avatarUrl: 'https://x' })).toBe(false);
    // 余計なフィールド（email 等）が混ざったオブジェクトは型としては通るが、
    // 保存側（lib/github.ts）が login / avatarUrl の2項目だけを持つ。
    expect(isRequester({ ...ok, email: 'x@example.com', name: '誰か' })).toBe(true);
  });
});

describe('GitHub API → IssueRecord の抽出（issue #42）', () => {
  const gh = { token: 'T', repo: 'owner/repo' };
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  async function fetchOnce(row: unknown): Promise<ReturnType<typeof listOpenIssues>> {
    return listOpenIssues({
      ...gh,
      maxPages: 1,
      fetchImpl: vi.fn(async () => jsonResponse([row])),
    });
  }

  it('user.login / user.avatar_url の2項目だけを保持する（他の公開情報は保存しない）', async () => {
    const recs = await fetchOnce({
      number: 42,
      title: '[Breed] test',
      body: 'parent_a: protopedia:1',
      created_at: '2026-11-10T00:00:00Z',
      user: { login: 'someone', avatar_url: 'https://avatars.githubusercontent.com/u/9', html_url: 'x', type: 'User' },
    });
    const u = (recs[0].user ?? null) as Offspring['requester'];
    expect(u).toEqual({ login: 'someone', avatarUrl: 'https://avatars.githubusercontent.com/u/9' });
  });

  it('user 無し・書式不正・Bot っぽいIDでも処理を止めない（項目を省く）', async () => {
    const base = {
      title: '[Breed] test',
      body: 'parent_a: protopedia:1',
      created_at: '2026-11-10T00:00:00Z',
    };
    for (const user of [undefined, null, {}, { login: 'bad login!', avatar_url: 'https://x' }]) {
      const recs = await fetchOnce({ ...base, number: 43, user });
      expect(recs[0].number).toBe(43);
      expect(recs[0].user).toBeUndefined();
    }
    // avatarUrl が不正（GitHubのCDN以外）→ 項目ごと省く
    const badUrl = await fetchOnce({
      ...base,
      number: 44,
      user: { login: 'ok-login', avatar_url: 'https://evil.example.com/u/1' },
    });
    expect(badUrl[0].user).toBeUndefined();
  });
});
