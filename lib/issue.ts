/**
 * Issue本文のパーサーとバリデーション。
 * 外部入力（Issue本文）は命令ではなくデータとして扱う。
 * 不正な入力はAI呼び出し前に却下する。
 */
import { isBreedingMode, type BreedingMode, type BreedingRequest, type ParentId } from './types.ts';
import { parseParentRef } from './parent-ref.ts';

const MAX_BODY_LENGTH = 4000;
const MAX_FIELD_LENGTH = 100;
/**
 * 任意の自由記述コメント「研究員へのひと道理」（issue #7）。
 * 追加開発指示 §5 で最大500文字に変更（issue #16）。1行・任意。
 */
export const MAX_COMMENT_LENGTH = 500;

/** 許可するID形式のみ通す（正規表現と長さ上限）。 */
// ID名前空間は2種類のみ。子作品はデータモデルの id 形式 "mashup-000001" をそのまま親参照に使う。
const PROTOPEDIA_ID = /^protopedia:\d{1,9}$/;
const MASHUP_ID = /^mashup-\d{1,9}$/;

export type ParseResult =
  | { ok: true; request: BreedingRequest }
  | { ok: false; reason: string };

function isValidId(id: string): id is ParentId {
  return PROTOPEDIA_ID.test(id) || MASHUP_ID.test(id);
}

/**
 * Issue本文をパースする。許可フィールドはこの関数で明示的に定義する。
 * タイトルは表示用なので一切信用しない。
 */
export function parseBreedingIssue(body: string): ParseResult {
  if (body.length > MAX_BODY_LENGTH) {
    return { ok: false, reason: `本文が長すぎます（${MAX_BODY_LENGTH}文字上限）` };
  }

  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (fields.has(key)) continue; // 最初の出現を採用
    // comment のみ専用の上限（issue #7）。他は従来どおり100字。
    const cap = key === 'comment' ? MAX_COMMENT_LENGTH : MAX_FIELD_LENGTH;
    if (value.length > cap) {
      return { ok: false, reason: `フィールド ${key} が長すぎます（${cap}文字上限）` };
    }
    fields.set(key, value.trim());
  }

  const parentA = fields.get('parent_a');
  const parentB = fields.get('parent_b');
  if (!parentA || !parentB) {
    return { ok: false, reason: 'parent_a と parent_b が必要です' };
  }
  if (!isValidId(parentA) || !isValidId(parentB)) {
    return { ok: false, reason: 'ID形式が不正です（protopedia:<数字> または mashup-<数字>）' };
  }
  if (parentA === parentB) {
    return { ok: false, reason: '親Aと親Bは別のIDでなければなりません' };
  }

  // 配合タイプ3種（追加開発指示 §4 / issue #16）。未対応の値はAI呼び出し前に却下する。
  const modeRaw = fields.get('mode') ?? 'fusion';
  if (!isBreedingMode(modeRaw)) {
    return { ok: false, reason: `未対応のmodeです: ${modeRaw}` };
  }
  const mode: BreedingMode = modeRaw;

  const schemaRaw = fields.get('schema_version');
  if (schemaRaw !== undefined && schemaRaw !== '1') {
    return { ok: false, reason: `未対応のschema_versionです: ${schemaRaw}` };
  }

  // 候補スロット（追加開発指示 §8 / issue #10）。付いていれば形式を検証して記録する。
  // 15分刻み "YYYY-MM-DDTHHMM"（現行）と、従来の時間枠 "YYYY-MM-DDTHH"（移行前のIssue）の両方を許容。
  const slotRaw = fields.get('slot');
  if (slotRaw !== undefined && !/^\d{4}-\d{2}-\d{2}T\d{2}(\d{2})?$/.test(slotRaw)) {
    return { ok: false, reason: 'slot の形式が不正です（YYYY-MM-DDTHHMM）' };
  }

  // 元作品URL（追加開発指示 §8）。表示・照合用の「データ」であり、命令として扱わない。
  // ワーカーは本文のURLを信用せず、親IDから出典URLを再導出する。
  for (const key of ['parent_a_url', 'parent_b_url']) {
    const v = fields.get(key);
    if (v === undefined) continue;
    if (!/^https:\/\/[^\s<>"']+$/i.test(v)) {
      return { ok: false, reason: `${key} が不正なURL形式です（https のみ）` };
    }
  }

  const request: BreedingRequest = { schemaVersion: 1, parentA, parentB, mode };
  if (slotRaw !== undefined) request.slot = slotRaw;
  // 任意コメント（issue #7）。リクエスト者の自由記述を「データ」として保持するだけ。
  // シェル・Actions式へは絶対に埋め込まない（AGENTS.md「ユーザー入力を信用しない」）。
  // AIプロンプトには issue #16 で「参考データ」として区切り明示のうえ注入する
  // （lib/blend.ts の injection guard。命令として解釈させない）。
  const commentRaw = fields.get('comment');
  if (commentRaw) request.comment = commentRaw;
  return { ok: true, request };
}

/** 同じ親の組を重複生成しない（順序を問わない）。 */
export function samePair(a: readonly [string, string], b: readonly [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/**
 * 親として参照できるのは「ProtoPediaの実在作品」か「すでに生まれた子作品」のみ。
 * 未来の親・存在しないIDを拒否する（循環参照防止の第一歩）。
 */
export function validateParents(
  request: BreedingRequest,
  knownProtopediaIds: ReadonlySet<string>,
  knownOffspringIds: ReadonlySet<string>,
): ParseResult {
  for (const id of [request.parentA, request.parentB]) {
    // 種類の区別は構造で判定する（issue #36）。形式が読めないIDは未知の名前空間として却下。
    const ref = parseParentRef(id);
    if (ref === null) {
      return { ok: false, reason: `未知のID名前空間です: ${id}` };
    }
    if (ref.source === 'protopedia') {
      if (!knownProtopediaIds.has(id)) {
        return { ok: false, reason: `存在しないProtoPedia作品です: ${id}` };
      }
    } else {
      if (!knownOffspringIds.has(id)) {
        return { ok: false, reason: `まだ生まれていない子作品は親にできません: ${id}` };
      }
    }
  }
  return { ok: true, request };
}
