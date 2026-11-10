/**
 * 親の識別子を「種類 + ID」の構造として扱う（issue #36）。
 *
 * 画面・内部では `{ source, id }` で種類を区別し、
 * **Issue本文（`parent_a: protopedia:123`）は従来どおりの文字列形式のまま**
 * （過去の申請も処理できる互換性を維持するため）。
 *
 *   protopedia:123  → { source: 'protopedia',   id: '123' }
 *   mashup-000001   → { source: 'mashup-ours',  id: '000001' }
 *
 * 純関数のみ（Node依存なし）。フロント・ワーカー・テストで共有する。
 */

export type ParentIdSource = 'protopedia' | 'mashup-ours';

export interface ParentRef {
  source: ParentIdSource;
  /** 名前空間を取り除いたローカルID（protopedia=数字 / mashup-ours=ゼロ埋め数字） */
  id: string;
}

const PROTOPEDIA_RE = /^protopedia:(\d{1,9})$/;
const MASHUP_RE = /^mashup-(\d{1,9})$/;

/**
 * 文字列ID → 構造。許可されていない形式は null（呼び出し側が却下する）。
 * 許可形式は lib/issue.ts の ID ルールと一致させる。
 */
export function parseParentRef(id: string): ParentRef | null {
  const p = PROTOPEDIA_RE.exec(id);
  if (p) return { source: 'protopedia', id: p[1] };
  const m = MASHUP_RE.exec(id);
  if (m) return { source: 'mashup-ours', id: m[1] };
  return null;
}

/** 構造 → 文字列ID（Issue本文・系譜図・データのIDはこの形式）。 */
export function parentRefToId(ref: ParentRef): string {
  return ref.source === 'protopedia' ? `protopedia:${ref.id}` : `mashup-${ref.id}`;
}

/** ProtoPediaの元作品（第0世代）か / AI生成アイデアか。 */
export function isProtopediaRef(ref: ParentRef): boolean {
  return ref.source === 'protopedia';
}
