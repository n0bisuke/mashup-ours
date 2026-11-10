/**
 * ProtoPedia 制作状態（供養/開発中/完成）の表示ラベル（issue #29）。
 *
 * 対応は2026-11-10のAPI実測（カタログHTMLのバッジと status の18件照合・矛盾0）。
 * 公式ドキュメントとの照合は未検証なので、未知コードは黙って隠す挙動を固定する。
 */
import { describe, expect, it } from 'vitest';
import { PROTOPEDIA_STATUS_LABELS, statusLabel } from '../lib/types.ts';

describe('statusLabel（制作状態ラベル）', () => {
  it('実測マッピング 2/3/4 を返す', () => {
    expect(statusLabel(2)).toBe('開発中');
    expect(statusLabel(3)).toBe('完成');
    expect(statusLabel(4)).toBe('供養');
    expect(PROTOPEDIA_STATUS_LABELS[4]).toBe('供養');
    expect(PROTOPEDIA_STATUS_LABELS[2]).toBe('開発中');
    expect(PROTOPEDIA_STATUS_LABELS[3]).toBe('完成');
  });

  it('状態バッジなし(1)・未知コード・未設定は空文字＝表示しない', () => {
    expect(statusLabel(1)).toBe('');
    expect(statusLabel(undefined)).toBe('');
    expect(statusLabel(0)).toBe('');
    expect(statusLabel(-1)).toBe('');
    expect(statusLabel(5)).toBe(''); // 将来追加されても捏造ラベルを出さない
    expect(statusLabel(99)).toBe('');
    expect(statusLabel(Number.NaN)).toBe('');
  });

  it('供養はタグではなく status 由来（tagNm=供養 では0件だった実測に対応）', () => {
    // ラベルは status コードからしか出さない（タグ名に「供養」があってもラベルは変わらない）
    expect(statusLabel(4)).toBe('供養');
    expect(PROTOPEDIA_STATUS_LABELS).not.toHaveProperty('供養');
  });
});
