/**
 * 親識別子の構造化（issue #36）。
 * 画面・内部では { source, id } で種類を区別し、Issue本文・データのID文字列は
 * 従来形式（protopedia:123 / mashup-000001）のまま維持する（過去の申請との互換）。
 */
import { describe, expect, it } from 'vitest';
import { isProtopediaRef, parseParentRef, parentRefToId } from '../lib/parent-ref.ts';

describe('parseParentRef', () => {
  it('protopedia:<数字> は ProtoPedia の元作品として読む', () => {
    expect(parseParentRef('protopedia:123')).toEqual({ source: 'protopedia', id: '123' });
    expect(parseParentRef('protopedia:0')).toEqual({ source: 'protopedia', id: '0' });
  });

  it('mashup-<数字> は AI生成アイデア（mashup-ours）として読む', () => {
    expect(parseParentRef('mashup-000001')).toEqual({ source: 'mashup-ours', id: '000001' });
    expect(parseParentRef('mashup-42')).toEqual({ source: 'mashup-ours', id: '42' });
  });

  it('未知の名前空間・形式不正は null（呼び出し側が却下する）', () => {
    for (const bad of [
      '',
      'github:1',
      'protopedia:',
      'protopedia:abc',
      'mashup',
      'mashup-',
      'MASHUP-000001',
      'protopedia:1234567890', // 10桁（上限9桁）
      'mashup-000001 ',
      'protopedia:1/x',
    ]) {
      expect(parseParentRef(bad), `${JSON.stringify(bad)} は拒否されるべき`).toBeNull();
    }
  });

  it('長すぎる数字は null（正規表現と長さ上限）', () => {
    expect(parseParentRef(`protopedia:${'9'.repeat(20)}`)).toBeNull();
    expect(parseParentRef(`mashup-${'9'.repeat(20)}`)).toBeNull();
  });
});

describe('parentRefToId（往復）', () => {
  it('構造 → 文字列 → 構造 で戻る（Issue形式の互換維持）', () => {
    for (const id of ['protopedia:123', 'protopedia:9', 'mashup-000001', 'mashup-7']) {
      const ref = parseParentRef(id);
      expect(ref).not.toBeNull();
      expect(parentRefToId(ref!)).toBe(id);
    }
  });

  it('source ごとに名前空間を切り替える', () => {
    expect(parentRefToId({ source: 'protopedia', id: '88' })).toBe('protopedia:88');
    expect(parentRefToId({ source: 'mashup-ours', id: '000008' })).toBe('mashup-000008');
  });
});

describe('isProtopediaRef', () => {
  it('元作品だけ true（AI生成アイデアは false）', () => {
    expect(isProtopediaRef({ source: 'protopedia', id: '1' })).toBe(true);
    expect(isProtopediaRef({ source: 'mashup-ours', id: '000001' })).toBe(false);
  });
});
