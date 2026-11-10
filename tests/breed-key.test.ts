// @vitest-environment node
/**
 * 配合条件の一意キー（issue #37）。
 * - 親A / 親B / 配合タイプ / 正規化したコメント の4項目だけがキーになる
 * - Issue番号・申請日時・スロットはキーに含めない
 * - 親の順序（A×B / B×A）は区別する
 * - コメントなしと空白だけのコメントは同一、内容が違えば別
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalCondition,
  isRequestHash,
  normalizeComment,
  requestHashOf,
} from '../lib/breed-key.ts';
import type { BreedingRequest } from '../lib/types.ts';

const req = (over: Partial<BreedingRequest> = {}): BreedingRequest => ({
  schemaVersion: 1,
  parentA: 'protopedia:1',
  parentB: 'protopedia:2',
  mode: 'fusion',
  ...over,
});

describe('normalizeComment', () => {
  it('前後の空白と改行コードを正規化する', () => {
    expect(normalizeComment(undefined)).toBe('');
    expect(normalizeComment('')).toBe('');
    expect(normalizeComment('   ')).toBe(''); // 空白だけ = なし
    expect(normalizeComment(' \n \t ')).toBe('');
    expect(normalizeComment('  子どもが遊ぶ  ')).toBe('子どもが遊ぶ');
    expect(normalizeComment('あ\r\nい\nう\rお')).toBe('あ\nい\nう\nお');
  });
});

describe('requestHashOf', () => {
  it('SHA-256の16進64文字で、同じ入力なら常に同じ値', () => {
    const h = requestHashOf(req({ comment: '子育て向け' }));
    expect(isRequestHash(h)).toBe(true);
    expect(h).toHaveLength(64);
    expect(requestHashOf(req({ comment: '子育て向け' }))).toBe(h);
    // canonical JSON はキー順が固定
    expect(canonicalCondition(req({ comment: '子育て向け' }))).toBe(
      '{"parentA":"protopedia:1","parentB":"protopedia:2","mode":"fusion","comment":"子育て向け"}',
    );
  });

  it('コメントなしと空白だけのコメントは同一キー', () => {
    const none = requestHashOf(req());
    expect(requestHashOf(req({ comment: '' }))).toBe(none);
    expect(requestHashOf(req({ comment: '   ' }))).toBe(none);
    expect(requestHashOf(req({ comment: '\n\t  \n' }))).toBe(none);
  });

  it('内容が違うコメントは別のキー', () => {
    const a = requestHashOf(req({ comment: '公園で' }));
    const b = requestHashOf(req({ comment: '公園で！' }));
    expect(a).not.toBe(b);
  });

  it('親Aと親Bの順序を区別する（A×B と B×A は別の配合）', () => {
    const ab = requestHashOf(req());
    const ba = requestHashOf(req({ parentA: 'protopedia:2', parentB: 'protopedia:1' }));
    expect(ab).not.toBe(ba);
  });

  it('配合タイプが違えば別のキー', () => {
    expect(requestHashOf(req({ mode: 'genetic' }))).not.toBe(requestHashOf(req()));
    expect(requestHashOf(req({ mode: 'mutation' }))).not.toBe(requestHashOf(req({ mode: 'genetic' })));
  });

  it('スロット（申請日時）はキーに含めない', () => {
    expect(requestHashOf(req({ slot: '2026-11-10T0900' }))).toBe(requestHashOf(req()));
    expect(canonicalCondition(req({ slot: '2026-11-10T0900' }))).not.toContain('2026-11-10');
  });

  it('isRequestHash は不正な値を拒否する', () => {
    expect(isRequestHash('a'.repeat(64))).toBe(true);
    expect(isRequestHash('A'.repeat(64))).toBe(false); // 小文字のみ
    expect(isRequestHash('a'.repeat(63))).toBe(false);
    expect(isRequestHash(undefined)).toBe(false);
    expect(isRequestHash(1234)).toBe(false);
  });
});
