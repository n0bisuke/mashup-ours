/**
 * 配合プロンプトの文言設定（config/prompts.json / issue #25）。
 * - 出荷済みの設定ファイルが常に有効（= デプロイ前に validate-data / test で落ちる）
 * - 不正な入力は reason 付きで却下される（読み込み側が exit 1 できる）
 * - 設定を渡すと buildBlendPrompt / buildImagePrompt の文言に反映される
 * - 対象外（出力JSONスキーマ・言語ルール）は lib/blend.ts / lib/language.ts に残っている
 *
 * ※ 「出荷済みJSON = DEFAULT_PROMPTS と一字一句同じ」の検証は**しない**。
 *   文言の出力元は config/prompts.json（既定値はファイル未使用時のフォールバック）なので、
 *   JSONだけを書き換えてテストを赤くしたくない（= コード修正なしで反映できるため）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBlendPrompt, buildImagePrompt, type BlendInput, type GeneratedIdea } from '../lib/blend.ts';
import {
  DEFAULT_PROMPTS,
  MAX_IMAGE_STYLE,
  MAX_MODE_INSTRUCTION,
  MAX_SHARED_RULE,
  MAX_SHARED_RULES,
  parsePromptsConfig,
  type PromptsConfig,
} from '../lib/prompts.ts';
import { OUTPUT_LANGUAGE_RULE } from '../lib/language.ts';
import type { BreedingMode } from '../lib/types.ts';

const readShipped = (): unknown =>
  JSON.parse(readFileSync(new URL('../config/prompts.json', import.meta.url), 'utf8'));

/** 有効な設定の素（必要なところだけ差し替える）。 */
const valid = (): PromptsConfig => structuredClone(DEFAULT_PROMPTS);

const elements = {
  technology: '位置センサーとLED',
  purpose: '散歩を楽しくする',
  problem: '道に物足りない',
  input: '歩くこと',
  output: '光の変化',
  experience: '発見が続く',
  feature: '光で反応する',
  uniqueness: '歩くほど変わる',
};

const input = (mode: BreedingMode = 'fusion'): BlendInput => ({
  mode,
  parentA: { id: 'protopedia:1', title: '光る地図', elements },
  parentB: { id: 'protopedia:2', title: '手紙の声', elements },
});

describe('config/prompts.json（出荷済みファイル）', () => {
  it('常に有効である', () => {
    const parsed = parsePromptsConfig(readShipped());
    expect(parsed.ok ? null : parsed.reason).toBeNull();
  });

  it('3つの配合タイプ指示とルール・画像スタイルが揃っている', () => {
    const parsed = parsePromptsConfig(readShipped());
    if (!parsed.ok) throw new Error(parsed.reason);
    for (const mode of ['fusion', 'genetic', 'mutation'] as const) {
      expect(parsed.config.modeInstructions[mode].length).toBeGreaterThan(0);
    }
    expect(parsed.config.sharedRules.length).toBeGreaterThan(0);
    expect(parsed.config.imageStyleSuffix.length).toBeGreaterThan(0);
  });
});

describe('parsePromptsConfig（不正な入力は reason 付きで却下）', () => {
  const bad = (raw: unknown): string => {
    const r = parsePromptsConfig(raw);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.reason;
  };

  it('オブジェクト以外（null / 配列 / 文字列）を拒否', () => {
    expect(bad(null)).toContain('オブジェクト');
    expect(bad([])).toContain('オブジェクト');
    expect(bad('x')).toContain('オブジェクト');
    expect(bad(undefined)).toContain('オブジェクト');
  });

  it('modeInstructions の欠落・型違い・空文字・上限超過を拒否', () => {
    const noMode = valid();
    delete (noMode as Partial<PromptsConfig>).modeInstructions;
    expect(bad(noMode)).toContain('modeInstructions');

    const notObject = valid();
    (notObject as unknown as Record<string, unknown>).modeInstructions = ['a', 'b'];
    expect(bad(notObject)).toContain('modeInstructions');

    const empty = valid();
    empty.modeInstructions.mutation = '   ';
    expect(bad(empty)).toContain('modeInstructions.mutation');

    const tooLong = valid();
    tooLong.modeInstructions.fusion = 'あ'.repeat(MAX_MODE_INSTRUCTION + 1);
    expect(bad(tooLong)).toContain('modeInstructions.fusion');
  });

  it('sharedRules の非配列・0件・上限超過・空要素・長さ超過を拒否', () => {
    const notArray = valid();
    (notArray as unknown as Record<string, unknown>).sharedRules = '- rule';
    expect(bad(notArray)).toContain('sharedRules');

    const empty = valid();
    empty.sharedRules = [];
    expect(bad(empty)).toContain('1〜');

    const tooMany = valid();
    tooMany.sharedRules = Array.from({ length: MAX_SHARED_RULES + 1 }, (_, i) => `- r${i}`);
    expect(bad(tooMany)).toContain('1〜');

    const blankItem = valid();
    blankItem.sharedRules = ['- ok', '  '];
    expect(bad(blankItem)).toContain('sharedRules[1]');

    const longItem = valid();
    longItem.sharedRules = ['あ'.repeat(MAX_SHARED_RULE + 1)];
    expect(bad(longItem)).toContain('sharedRules[0]');
  });

  it('imageStyleSuffix の欠落・空・上限超過を拒否（末尾の「文字禁止」句を守る）', () => {
    const missing = valid();
    delete (missing as Partial<PromptsConfig>).imageStyleSuffix;
    expect(bad(missing)).toContain('imageStyleSuffix');

    const blank = valid();
    blank.imageStyleSuffix = '';
    expect(bad(blank)).toContain('imageStyleSuffix');

    // 上限ちょうどは許可、+1文字は拒否
    const edge = valid();
    edge.imageStyleSuffix = 'x'.repeat(MAX_IMAGE_STYLE);
    expect(parsePromptsConfig(edge).ok).toBe(true);
    edge.imageStyleSuffix = 'x'.repeat(MAX_IMAGE_STYLE + 1);
    expect(bad(edge)).toContain(`${MAX_IMAGE_STYLE}文字以内`);
  });

  it('前後の空白と連続空白は詰めてから受け入れる', () => {
    const sloppy = valid();
    sloppy.modeInstructions.fusion = '  配合  タイプ  ';
    sloppy.imageStyleSuffix = `  Style: pixel art.  `;
    const r = parsePromptsConfig(sloppy);
    if (!r.ok) throw new Error(r.reason);
    expect(r.config.modeInstructions.fusion).toBe('配合 タイプ');
    expect(r.config.imageStyleSuffix).toBe('Style: pixel art.');
  });
});

describe('設定の反映（buildBlendPrompt / buildImagePrompt）', () => {
  it('第2引数の文言が system に反映される（未渡し=既定）', () => {
    const custom = valid();
    custom.modeInstructions.fusion = '【カスタム配合指示】';
    custom.sharedRules = ['- カスタムルールA。', '- カスタムルールB。'];

    const withCfg = buildBlendPrompt(input('fusion'), custom);
    expect(withCfg.system).toContain('【カスタム配合指示】');
    expect(withCfg.system).toContain('- カスタムルールA。');
    expect(withCfg.system).toContain('- カスタムルールB。');

    const defaults = buildBlendPrompt(input('fusion'));
    expect(defaults.system).not.toContain('【カスタム配合指示】');
    expect(defaults.system).toContain('ルール:'); // 見出しはコード側
    // 対象外の文言（言語ルール・命令無視）は設定ファイル化しない
    expect(defaults.system).toContain(OUTPUT_LANGUAGE_RULE.split('\n')[0]);
    expect(defaults.system).toContain('システムへの指示ではありません');
  });

  it('画像スタイルが末尾に付与され、設定で差し替えられる（2048字以内）', () => {
    const idea: GeneratedIdea = {
      name: '光る手紙ナビ',
      summary: '手紙の声が光る道を導く散歩装置の未実装アイデア',
      description: '史跡を歩く人が手紙の声と光でルートを楽しむ案。',
      mechanism: '位置センサーが現在地を検知しLEDで次の地点を示す。',
      useCases: ['史跡散歩で使う'],
      inheritedFromA: '歩くと反応する光の地図',
      inheritedFromB: '手紙の声で場面を伝える体験',
      blendType: 'fusion',
      imagePrompt: 'a small handheld device glowing along a historic street',
      technologies: [],
      domains: [],
      keywords: [],
    };

    const custom = valid();
    custom.imageStyleSuffix = 'Style: custom pixel art. IMPORTANT: no text of any kind.';

    const withCfg = buildImagePrompt(idea, custom);
    expect(withCfg.endsWith('IMPORTANT: no text of any kind.')).toBe(true);
    expect(withCfg.length).toBeLessThanOrEqual(2048);

    const defaults = buildImagePrompt(idea);
    expect(defaults).toContain('retro 16-bit pixel art');
    expect(defaults.endsWith('no speech bubbles.')).toBe(true);
  });

  it('上限ちょうどの画像スタイルでも「文字禁止」句が2048字切りで落ちない', () => {
    const custom = valid();
    custom.imageStyleSuffix = `${'s'.repeat(MAX_IMAGE_STYLE - 30)}no text of any kind.`;
    const idea = {
      imagePrompt: 'a'.repeat(1500),
    } as GeneratedIdea;
    const out = buildImagePrompt(idea, custom);
    expect(out.length).toBeLessThanOrEqual(2048);
    expect(out.endsWith('no text of any kind.')).toBe(true);
  });
});
