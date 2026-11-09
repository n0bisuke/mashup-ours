/**
 * 配合プロンプトの文言設定（config/prompts.json / issue #25）。
 *
 * このモジュールは純関数のみ（Node依存なし）。
 *
 * JSON 化する範囲は「文言」だけ:
 * - 対象: modeInstructions（配合タイプ別指示）/ sharedRules（共通ルール）/
 *   imageStyleSuffix（画像のスタイル後押し）
 * - 対象外（コード固定のまま）:
 *   - 出力JSONスキーマと字数上限（lib/blend.ts の CAP_*）— パーサーと字単位で一致必須
 *   - OUTPUT_LANGUAGE_RULE（lib/language.ts / issue #23）と命令無視の文言 — 剛性が必要
 *
 * 設定が不正なとき: 読み込む側（scripts/process-breeding.ts / scripts/validate-data.ts）は
 * exit 1（= AIを呼ばない）。config/schedule.json と同一の扱い。
 */
import { BREEDING_MODES, type BreedingMode } from './types.ts';

/** 配合プロンプトの設定（config/prompts.json の形）。 */
export interface PromptsConfig {
  /** 配合タイプ別の指示（fusion / genetic / mutation）。 */
  modeInstructions: Record<BreedingMode, string>;
  /** 共通ルールの箇条書き（「- 」始まり。見出し「ルール:」はコード側で付ける）。 */
  sharedRules: string[];
  /** 画像プロンプトの末尾に付くスタイル指定（flux-1-schnell 向け・英語）。 */
  imageStyleSuffix: string;
}

/** 各設定の長さ・件数の上限（プロンプトの暴走を防ぐ）。 */
export const MAX_MODE_INSTRUCTION = 500;
export const MAX_SHARED_RULES = 30;
export const MAX_SHARED_RULE = 300;
/**
 * 画像スタイルの長さ上限。
 * flux-1-schnell のプロンプト上限は2048字（公式ドキュメント）で、
 * buildImagePrompt は「imagePrompt（最大1500字） + '. ' + ここ」を末尾切りするため、
 * 1500 + 2 + 上限 = 2048 に収める（= 末尾の「文字禁止」句が切り落とされない）。
 */
export const MAX_IMAGE_STYLE = 546;

/**
 * 既定の文言（= config/prompts.json と一字一句同じ内容）。
 * 設定ファイルが読めないときに使うが、通常は config/prompts.json 側が正。
 */
export const DEFAULT_PROMPTS: PromptsConfig = {
  modeInstructions: {
    fusion:
      '配合タイプ: 単純配合（fusion）。2つの発明の特徴を自然に組み合わせてください。' +
      '片方だけの案は避け、技術と体験が一体化した「一つの発明」にします。',
    genetic:
      '配合タイプ: 遺伝子配合（genetic）。まず両親から引き継げる要素を個別に見出し、' +
      '新しい構成に組み替えてください。inheritedFromA / inheritedFromB で、' +
      'どの親から何を受け継いだかを具体的に明示します。',
    mutation:
      '配合タイプ: 突然変異配合（mutation）。意外性を優先してください。' +
      '少し飛び抜けた案でも構いませんが、実現方法は説明できる範囲にしてください。',
  },
  sharedRules: [
    '- 2作品は横並びにせず、技術と体験が相互作用する「一つの新しい発明」として生成すること。',
    '- 元作品の良さを尊重し、捨てない。各親から引き継いだものを inheritedFromA / inheritedFromB に書くこと。',
    '- 実現可能性を完全に無視しないが、意外性も優先すること。',
    '- 「実装済み」「発売済み」「特許取得」など、根拠のない主張は書かないこと（これは未実装のアイデア案である）。',
    '- 第三者や元作品の権利を侵害する前提の提案をしないこと。',
    '- 危険な行為（人体への危害・違法行為・武器など）を促す案は出さないこと。',
    '- 出力は指定のJSONのみ。前置き・後書き・コードフェンスは不要。',
  ],
  imageStyleSuffix:
    'Style: retro 16-bit pixel art illustration, flat shading, warm cozy laboratory aesthetic, ' +
    'harmonious with a small 8bit research lab scene. Square 1:1 composition, centered subject, ' +
    'clear silhouette. Show the device appearance, how it works, and a scene of it being used. ' +
    'Original design only: do not imitate characters or art from any existing game or franchise. ' +
    'Not a photograph: no photorealism. ' +
    'IMPORTANT: no text of any kind — no letters, no numbers, no Japanese characters, no logos, no captions, no speech bubbles.',
};

export type PromptsParseResult =
  | { ok: true; config: PromptsConfig }
  | { ok: false; reason: string };

/** 値を理由文に載せるときの短縮（巨大な入力でログが壊れないように）。 */
function sample(value: unknown): string {
  const s = JSON.stringify(value);
  return s === undefined ? 'undefined' : s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function shortString(value: unknown, name: string, max: number): string | null {
  if (typeof value !== 'string') return `${name} は文字列である必要があります（入力: ${sample(value)}）`;
  const trimmed = value.trim();
  if (trimmed === '') return `${name} が空です`;
  if (trimmed.length > max) return `${name} は${max}文字以内である必要があります（入力: ${trimmed.length}文字）`;
  return null;
}

/** config/prompts.json の形を検証する。 */
export function parsePromptsConfig(raw: unknown): PromptsParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `設定はオブジェクトである必要があります（入力: ${sample(raw)}）` };
  }
  const obj = raw as Record<string, unknown>;

  const modeRaw = obj.modeInstructions;
  if (typeof modeRaw !== 'object' || modeRaw === null || Array.isArray(modeRaw)) {
    return {
      ok: false,
      reason: `modeInstructions はオブジェクトである必要があります（入力: ${sample(modeRaw)}）`,
    };
  }
  const modeInstructions = {} as Record<BreedingMode, string>;
  for (const mode of BREEDING_MODES) {
    const err = shortString(
      (modeRaw as Record<string, unknown>)[mode],
      `modeInstructions.${mode}`,
      MAX_MODE_INSTRUCTION,
    );
    if (err) return { ok: false, reason: err };
    modeInstructions[mode] = ((modeRaw as Record<string, unknown>)[mode] as string)
      .trim()
      .replace(/\s+/g, ' ');
  }

  const rulesRaw = obj.sharedRules;
  if (!Array.isArray(rulesRaw)) {
    return { ok: false, reason: `sharedRules は配列である必要があります（入力: ${sample(rulesRaw)}）` };
  }
  if (rulesRaw.length < 1 || rulesRaw.length > MAX_SHARED_RULES) {
    return {
      ok: false,
      reason: `sharedRules は1〜${MAX_SHARED_RULES}件である必要があります（入力: ${rulesRaw.length}件）`,
    };
  }
  const sharedRules: string[] = [];
  for (let i = 0; i < rulesRaw.length; i++) {
    const err = shortString(rulesRaw[i], `sharedRules[${i}]`, MAX_SHARED_RULE);
    if (err) return { ok: false, reason: err };
    sharedRules.push((rulesRaw[i] as string).trim().replace(/\s+/g, ' '));
  }

  const imageErr = shortString(obj.imageStyleSuffix, 'imageStyleSuffix', MAX_IMAGE_STYLE);
  if (imageErr) return { ok: false, reason: imageErr };

  return {
    ok: true,
    config: {
      modeInstructions,
      sharedRules,
      imageStyleSuffix: (obj.imageStyleSuffix as string).trim().replace(/\s+/g, ' '),
    },
  };
}
