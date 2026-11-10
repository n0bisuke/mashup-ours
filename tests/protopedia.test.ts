import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTOPEDIA_SITE_BASE,
  buildWorkset,
  fetchAllWorks,
  isPublicRelease,
  normalizeWork,
  stripToText,
  writeWorksetAtomic,
} from '../lib/protopedia.ts';

/** fetchの最小モック（検証対象はURL・ヘッダ・本文処理だけ）。 */
function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe('stripToText', () => {
  it('HTMLタグを除去して文字参照をデコードする', () => {
    expect(stripToText('<p>Hello <b>World</b></p>', 100)).toBe('Hello World');
    expect(stripToText('A&amp;B &lt;tag&gt; &#65;', 100)).toBe('A&B <tag> A');
  });

  it('空白を圧縮し、非文字列は空にする', () => {
    expect(stripToText('  a\n\n  b  ', 100)).toBe('a b');
    expect(stripToText(null, 100)).toBe('');
    expect(stripToText(42, 100)).toBe('');
  });

  it('長さ上限で切り詰める（末尾に…）', () => {
    const out = stripToText('あ'.repeat(50), 10);
    expect([...out]).toHaveLength(11); // 10文字 + …
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isPublicRelease', () => {
  it('欠損は公開扱い、明示的な非公開のみ除外（仕様書§11の未確認項目を踏まえた暫定）', () => {
    expect(isPublicRelease(undefined)).toBe(true);
    expect(isPublicRelease(null)).toBe(true);
    expect(isPublicRelease(true)).toBe(true);
    expect(isPublicRelease(1)).toBe(true);
    expect(isPublicRelease('Y')).toBe(true);
    expect(isPublicRelease(false)).toBe(false);
    expect(isPublicRelease(0)).toBe(false);
    expect(isPublicRelease('N')).toBe(false);
    expect(isPublicRelease('private')).toBe(false);
  });
});

describe('normalizeWork', () => {
  const valid = {
    id: 1234,
    prototypeNm: '光る地図スタンド',
    summary: '<b>概要</b>テキスト',
    users: [{ userNm: '作者A' }, { userNm: '作者B' }],
    tags: [{ tagNm: 'Arduino' }, { tagNm: '光' }],
    licenseType: 'CC BY 4.0',
    releaseFlg: true,
    mainUrl: 'https://example.com/img.png',
    systemDescription: 'Arduino + LED',
    freeComment: '詳細説明',
  };

  it('検証済みフィールドに正規化する', () => {
    const w = normalizeWork(valid);
    expect(w).not.toBeNull();
    expect(w!.id).toBe('protopedia:1234');
    expect(w!.title).toBe('光る地図スタンド');
    expect(w!.summary).toBe('概要テキスト');
    expect(w!.sourceUrl).toBe(`${PROTOPEDIA_SITE_BASE}/prototype/1234`);
    expect(w!.authors).toEqual(['作者A', '作者B']);
    expect(w!.tags).toEqual(['Arduino', '光']);
    expect(w!.licenseType).toBe('CC BY 4.0');
    expect(w!.mainUrl).toBe('https://example.com/img.png');
    expect(w!.systemDescription).toBe('Arduino + LED');
    // 詳細説明（freeComment）は仕様書§7により保存しない
    expect('description' in w!).toBe(false);
    expect(w!.generation).toBe(0);
    expect(w!.sample).toBeUndefined();
  });

  it('実API形式: users/tags は |-区切り文字列（作者は name@handle のまま）、licenseType 1 → CC BY 4+', () => {
    const w = normalizeWork({
      id: 5,
      prototypeNm: '実測形式の作品',
      summary: '概要',
      releaseFlg: 2,
      users: 'ひさやん@hisayan|@erikosakashita',
      tags: 'おもちゃ|クラッピーチャレンジ',
      licenseType: 1,
    });
    expect(w).not.toBeNull();
    expect(w!.authors).toEqual(['ひさやん@hisayan', '@erikosakashita']);
    expect(w!.tags).toEqual(['おもちゃ', 'クラッピーチャレンジ']);
    expect(w!.licenseType).toBe('CC BY 4+');
  });

  it('制作状態 status を保存し、想定外の値は保存しない（issue #29）', () => {
    expect(normalizeWork({ ...valid, status: 4 })!.status).toBe(4); // 供養
    expect(normalizeWork({ ...valid, status: 2 })!.status).toBe(2); // 開発中
    expect(normalizeWork({ ...valid, status: 1 })!.status).toBe(1); // 状態バッジなし
    expect(normalizeWork({ ...valid, status: '3' })!.status).toBe(3); // 文字列でも整数化
    expect(normalizeWork(valid)!.status).toBeUndefined(); // 欠損は保存しない
    expect(normalizeWork({ ...valid, status: 0 })!.status).toBeUndefined();
    expect(normalizeWork({ ...valid, status: -4 })!.status).toBeUndefined();
    expect(normalizeWork({ ...valid, status: 1.5 })!.status).toBeUndefined();
    expect(normalizeWork({ ...valid, status: '供養' })!.status).toBeUndefined(); // 数値以外
    expect(normalizeWork({ ...valid, status: null })!.status).toBeUndefined();
    expect(normalizeWork({ ...valid, status: 100 })!.status).toBeUndefined();
    expect(normalizeWork({ ...valid, status: {} })!.status).toBeUndefined();
  });

  it('未知の licenseType 数値は捏造せず保存しない', () => {
    expect(normalizeWork({ ...valid, licenseType: 7 })!.licenseType).toBeUndefined();
    expect(normalizeWork({ ...valid, licenseType: 'CC BY 4.0' })!.licenseType).toBe('CC BY 4.0');
  });

  it('IDなし・作品名なし・非公開は null（壊れたレコードを黙って通さない）', () => {
    expect(normalizeWork({ prototypeNm: '名前だけ' })).toBeNull();
    expect(normalizeWork({ id: 1234 })).toBeNull();
    expect(normalizeWork({ ...valid, releaseFlg: false })).toBeNull();
    expect(normalizeWork(null)).toBeNull();
    expect(normalizeWork('文字列レスポンス')).toBeNull();
    expect(normalizeWork({ ...valid, id: 'abc' })).toBeNull();
  });

  it('出典URLは protopedia.net 以外を拒否して組み立てURLに落とす', () => {
    const w = normalizeWork({ ...valid, url: 'https://evil.example/steal' });
    expect(w!.sourceUrl).toBe(`${PROTOPEDIA_SITE_BASE}/prototype/1234`);
    const w2 = normalizeWork({ ...valid, url: 'javascript:alert(1)' });
    expect(w2!.sourceUrl).toBe(`${PROTOPEDIA_SITE_BASE}/prototype/1234`);
  });

  it('http画像は捨て、httpsのみ保持', () => {
    expect(normalizeWork({ ...valid, mainUrl: 'http://insecure/x.png' })!.mainUrl).toBeUndefined();
    expect(normalizeWork({ ...valid, mainUrl: 'not a url' })!.mainUrl).toBeUndefined();
  });

  it('summaryが空ならfreeCommentの冒頭で代用し、概要は上限で切る', () => {
    const w = normalizeWork({ ...valid, summary: '', freeComment: 'あ'.repeat(5000) });
    expect(w!.summary).toBe('あ'.repeat(600) + '…');
    // freeComment 全文は保存しない（仕様書§7）
    expect('description' in w!).toBe(false);
  });
});

describe('fetchAllWorks', () => {
  const page = (ids: number[]) => ({ results: ids.map((id) => ({ id, prototypeNm: `作品${id}` })) });

  it('limit/offsetでページングし、Bearerトークンで呼ぶ', async () => {
    const { impl, calls } = mockFetch((url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      return offset === 0 ? { status: 200, body: page([1, 2]) } : { status: 200, body: page([3]) };
    });
    const result = await fetchAllWorks({
      token: 'test-token',
      pageSize: 2,
      pageDelayMs: 0,
      fetchImpl: impl,
    });
    expect(result.works.map((w) => w.id)).toEqual(['protopedia:1', 'protopedia:2', 'protopedia:3']);
    expect(result.pages).toBe(2);
    expect(calls[0]).toContain('limit=2&offset=0');
    expect(calls[1]).toContain('offset=2');
    // トークンはヘッダだけ（URLに入れない）
    expect(calls[0]).not.toContain('test-token');
  });

  it('status 指定で &status= を付ける。指定なしなら付けない（issue #29）', async () => {
    const { impl, calls } = mockFetch(() => ({ status: 200, body: page([1]) }));
    await fetchAllWorks({ token: 't', status: 4, fetchImpl: impl, pageDelayMs: 0 });
    expect(calls[0]).toContain('&status=4'); // 4=供養（数値のみ。文字列はHTTP 500の実測あり）
    await fetchAllWorks({ token: 't', fetchImpl: impl, pageDelayMs: 0 });
    expect(calls[1]).not.toContain('status=');
    // 想定外の値はAPIに送る前に拒否
    for (const bad of [0, -1, 1.5, 100]) {
      await expect(fetchAllWorks({ token: 't', status: bad, fetchImpl: impl })).rejects.toThrow('1..99');
    }
    expect(calls).toHaveLength(2); // 拒否分は1リクエストも送らない
  });

  it('5xxは1回だけ再試行してから成功する', async () => {
    let n = 0;
    const { impl } = mockFetch(() => {
      n += 1;
      return n === 1 ? { status: 500, body: {} } : { status: 200, body: page([1]) };
    });
    const result = await fetchAllWorks({ token: 't', pageSize: 10, fetchImpl: impl });
    expect(result.works).toHaveLength(1);
    expect(n).toBe(2);
  });

  it('常に失敗なら例外（=同期スクリプトは既存データを保持する）', async () => {
    const { impl } = mockFetch(() => ({ status: 401, body: {} }));
    await expect(fetchAllWorks({ token: 'bad', retries: 1, fetchImpl: impl })).rejects.toThrow(
      'HTTP 401',
    );
  });

  it('結果配列がないレスポンスは例外', async () => {
    const { impl } = mockFetch(() => ({ status: 200, body: { unexpected: true } }));
    await expect(fetchAllWorks({ token: 't', fetchImpl: impl })).rejects.toThrow(
      '結果配列が見つかりません',
    );
  });

  it('件数外オフセット（count:0 で results キー無し）は正常終了する', async () => {
    // 実測形状: カタログを超える offset では HTTP 200 + count:0 + results無し。
    // これは最終ページの後ろ = 空ページなので、例外にせずここで打ち切る。
    const { impl } = mockFetch((url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      return offset === 0
        ? { status: 200, body: page([1, 2]) }
        : { status: 200, body: { metadata: { status: 200 }, count: 0, links: {} } };
    });
    const result = await fetchAllWorks({ token: 't', pageSize: 2, pageDelayMs: 0, fetchImpl: impl });
    expect(result.works.map((w) => w.id)).toEqual(['protopedia:1', 'protopedia:2']);
    expect(result.pages).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('同一IDの重複レコードは1件目だけ採用する（offset無視対策）', async () => {
    const { impl } = mockFetch((url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      // 2ページ目が同じ内容を返してきた想定
      return { status: 200, body: page(offset === 0 ? [1, 2] : [1, 2]) };
    });
    const result = await fetchAllWorks({ token: 't', pageSize: 2, pageDelayMs: 0, fetchImpl: impl });
    expect(result.works.map((w) => w.id)).toEqual(['protopedia:1', 'protopedia:2']);
    expect(result.duplicates).toBe(2);
    expect(result.pages).toBe(2); // 進捗ゼロで打ち切る（無限ループしない）
  });

  it('不正レコードは落として数え、maxWorksで打ち切る', async () => {
    const { impl } = mockFetch((url) => {
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      const ids = offset === 0 ? [1, -5, 3] : [4, 5];
      return { status: 200, body: page(ids) };
    });
    const result = await fetchAllWorks({
      token: 't',
      pageSize: 3,
      maxWorks: 4,
      pageDelayMs: 0,
      fetchImpl: impl,
    });
    expect(result.works.length).toBeLessThanOrEqual(4);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(true);
  });

  it('トークン未設定は即例外', async () => {
    await expect(fetchAllWorks({ token: '' })).rejects.toThrow('トークン');
  });

  it('maxPages で取得ページ数を上限つきにできる（試作取得の暴走防止）', async () => {
    const { impl, calls } = mockFetch(() => ({ status: 200, body: page([1, 2]) }));
    const result = await fetchAllWorks({
      token: 't',
      pageSize: 2,
      maxPages: 1,
      pageDelayMs: 0,
      fetchImpl: impl,
    });
    expect(result.pages).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('offsetStart で取得開始位置をずらせる', async () => {
    const { impl, calls } = mockFetch(() => ({ status: 200, body: page([7]) }));
    await fetchAllWorks({ token: 't', pageSize: 1, offsetStart: 500, pageDelayMs: 0, fetchImpl: impl });
    expect(calls[0]).toContain('offset=500');
  });
});

describe('writeWorksetAtomic（キャッシュ保護）', () => {
  it('0件は拒否して既存ファイルを変更しない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mashup-'));
    const out = join(dir, 'prototypes.json');
    writeFileSync(out, '{"previous":"data"}', 'utf8');
    const empty = buildWorkset([], 'protopedia-api-v2');
    expect(() => writeWorksetAtomic(out, empty)).toThrow('0件');
    expect(readFileSync(out, 'utf8')).toBe('{"previous":"data"}');
  });

  it('成功時はJSONを書き、一時ファイルを残さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mashup-'));
    const out = join(dir, 'prototypes.json');
    const workset = buildWorkset(
      [
        {
          id: 'protopedia:1',
          title: 'T',
          sourceUrl: `${PROTOPEDIA_SITE_BASE}/prototype/1`,
          summary: 'S',
          generation: 0,
        },
      ],
      'protopedia-api-v2',
    );
    writeWorksetAtomic(out, workset);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.works).toHaveLength(1);
    expect(typeof parsed.syncedAt).toBe('string');
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });
});
