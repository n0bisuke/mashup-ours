/**
 * 既存の生成済み発明データだけを日本語へ翻訳する専用コマンド。（issue #23 §6）
 *
 * - **配合処理を一切再実行しない**: Issue操作・キュー・時間枠・キャッシュ・利用量記録は触らない。
 *   AI に渡すのは表示文章の JSON だけで、呼び出しもこのコマンドを実行したときだけ。
 * - **`imagePrompt` は翻訳しない**（画像モデル用は英語のままが正）。
 * - id / parents / generation / createdAt / sourceIssue / slot などの記録欄は**不変**。
 *   翻訳後に一致しない場合は書き込まない（データを壊さない）。
 * - 既定は dry-run（対象の列挙のみ・**AIを呼ばない**）。AI呼び出し・書き込みは
 *   `--write` を明示したときだけ（有料APIは明示実行時のみ）。
 *
 * 使い方:
 *   npm run translate:offspring -- --id=mashup-000001          # 対象の確認（AI呼び出しなし）
 *   npm run translate:offspring -- --id=mashup-000001 --write  # 1件を翻訳して書き込み
 *   npm run translate:offspring -- --all --write                # 日本語でない全件を書き込み
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CfError, cfAiRun, extractChatText } from '../lib/cloudflare.ts';
import { hasJapanese } from '../lib/language.ts';
import { loadDotEnv } from './load-env.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH_OFFSPRING = join(ROOT, 'data', 'offspring.json');

const TEXT_MODEL = '@cf/openai/gpt-oss-20b';
const MAX_TOKENS = 3000;
const TEMPERATURE = 0.2;
const MAX_ATTEMPTS = 2; // パース失敗の再試行上限（無限リトライしない）

/** 翻訳対象（サイトに表示する文章）。記録欄・imagePrompt は含めない。 */
const TEXT_FIELDS = ['title', 'summary', 'concept', 'mechanism', 'whyInteresting', 'implementationSketch'] as const;

function log(msg: string): void {
  console.log(msg);
}

interface RawRecord {
  id: string;
  [key: string]: unknown;
}

function isJapaneseNeeded(rec: RawRecord): boolean {
  for (const f of TEXT_FIELDS) {
    const v = rec[f];
    if (typeof v === 'string' && v.trim() && !hasJapanese(v)) return true;
  }
  if (Array.isArray(rec.useCases)) {
    for (const u of rec.useCases) {
      if (typeof u === 'string' && u.trim() && !hasJapanese(u)) return true;
    }
  }
  if (Array.isArray(rec.inheritedTraits)) {
    for (const t of rec.inheritedTraits) {
      const trait = (t as { trait?: unknown })?.trait;
      if (typeof trait === 'string' && trait.trim() && !hasJapanese(trait)) return true;
    }
  }
  return false;
}

/** 翻訳対象だけを抜き出した JSON（AI へ渡す最小の入力）。 */
function translatableView(rec: RawRecord): Record<string, unknown> {
  const view: Record<string, unknown> = { id: rec.id };
  for (const f of TEXT_FIELDS) if (typeof rec[f] === 'string') view[f] = rec[f];
  if (Array.isArray(rec.useCases)) view.useCases = rec.useCases;
  if (Array.isArray(rec.inheritedTraits)) {
    view.inheritedTraits = rec.inheritedTraits.map((t) => ({
      parentId: (t as { parentId?: unknown })?.parentId,
      trait: (t as { trait?: unknown })?.trait,
    }));
  }
  return view;
}

const SYSTEM = [
  'あなたは日本のサービス「Mashup Ours」の校閲担当です。',
  '与えられた JSON の**値だけ**を自然な日本語に翻訳してください。',
  '- キー名・JSONの構造・id・parentId・配列の数は一切変えないでください。',
  '- imagePrompt が含まれていても翻訳しないでください（画像生成用のため英語のまま）。',
  '- 固有名詞・製品名・技術名は原語のままにしてください。',
  '- 直訳調を避け、簡潔で親しみやすい文体にしてください。',
  '- 出力は翻訳後の JSON オブジェクトのみ。前置き・後書き・コードフェンスは不要です。',
].join('\n');

function parseJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('出力にJSONがありません');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 記録欄が変わらないか・対象フィールドが日本語になっているかを確認。 */
function verify(original: RawRecord, translated: unknown): string | null {
  if (typeof translated !== 'object' || translated === null || Array.isArray(translated)) {
    return '翻訳結果がJSONオブジェクトではありません';
  }
  const t = translated as Record<string, unknown>;
  // 記録欄は不変（id / parents / generation / 日時 / Issue番号 など）
  for (const [k, v] of Object.entries(original)) {
    if (k === 'id') {
      if (t.id !== v) return 'id が変わりました';
      continue;
    }
    if ((TEXT_FIELDS as readonly string[]).includes(k) || k === 'useCases' || k === 'inheritedTraits') {
      continue; // 翻訳対象
    }
    if (JSON.stringify(t[k] ?? v) !== JSON.stringify(v)) {
      return `記録欄 ${k} が変更されています`;
    }
  }
  for (const f of TEXT_FIELDS) {
    const v = t[f] ?? original[f];
    if (typeof v === 'string' && v.trim() && !hasJapanese(v)) {
      // title は固有名詞主体でも日本語が無いと「日本語化されていない」ので失敗扱い
      return `${f} がまだ日本語ではありません`;
    }
  }
  if (Array.isArray(t.useCases)) {
    for (const u of t.useCases) {
      if (typeof u === 'string' && u.trim() && !hasJapanese(u)) return 'useCases に日本語でない項目があります';
    }
  }
  if (Array.isArray(t.inheritedTraits)) {
    for (const item of t.inheritedTraits) {
      const trait = (item as { trait?: unknown })?.trait;
      if (typeof trait === 'string' && trait.trim() && !hasJapanese(trait)) {
        return 'inheritedTraits に日本語でない項目があります';
      }
      const parentId = (item as { parentId?: unknown })?.parentId;
      const src = Array.isArray(original.inheritedTraits)
        ? original.inheritedTraits.find((x) => (x as { parentId?: unknown }).parentId === parentId)
        : undefined;
      if (src && (item as { parentId?: unknown }).parentId !== parentId) return 'parentId が変わりました';
    }
  }
  return null;
}

async function main(): Promise<void> {
  loadDotEnv(join(ROOT, '.env'));

  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const all = args.includes('--all');
  const idArg = args.find((a) => a.startsWith('--id='))?.slice('--id='.length);

  if (!idArg && !all) {
    log('使い方: npm run translate:offspring -- --id=<子作品ID> [--write]  または  --all [--write]');
    process.exit(1);
  }

  // APIキーの確認は --write（AIを呼ぶとき）だけ。dry-run はキーなしでも動く。
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
  if (write && (!accountId || !apiToken)) {
    log('❌ CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定です（.env または Secrets）。');
    process.exit(1);
  }

  const list = JSON.parse(readFileSync(PATH_OFFSPRING, 'utf8')) as RawRecord[];
  if (!Array.isArray(list)) {
    log('❌ data/offspring.json が配列ではありません');
    process.exit(1);
  }

  const targets = list.filter((r) => {
    if (all) return isJapaneseNeeded(r);
    return r.id === idArg;
  });

  if (idArg && targets.length === 0) {
    log(`❌ ${idArg} が data/offspring.json にありません`);
    process.exit(1);
  }
  if (targets.length === 0) {
    log('対象なし（すべて日本語、または該当IDなし）。AIは呼びません。');
    return;
  }

  const needsWork = targets.filter((t) => isJapaneseNeeded(t));
  if (!write) {
    log(`📄 翻訳対象候補: ${targets.map((t) => t.id).join(', ')}`);
    for (const t of targets) {
      log(`   ${t.id}: ${isJapaneseNeeded(t) ? '日本語でない項目あり → 翻訳が必要' : '日本語化済み → スキップ'}`);
    }
    log('ℹ️ dry-run のため AI は呼びません。翻訳するには --write を付けてください。');
    return;
  }
  if (needsWork.length === 0) {
    log('すべて日本語化済みのため AI は呼びません。');
    return;
  }
  log(`📄 翻訳対象: ${needsWork.map((t) => t.id).join(', ')}（AI呼び出し ${needsWork.length} 回）`);

  let changed = 0;
  for (const rec of targets) {
    if (!isJapaneseNeeded(rec)) {
      log(`   ${rec.id}: 日本語化済みのためスキップ`);
      continue;
    }
    const view = translatableView(rec);
    const user = `次の JSON の値を日本語に翻訳してください:\n${JSON.stringify(view, null, 2)}`;

    let translated: unknown = null;
    let lastReason = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && translated === null; attempt++) {
      try {
        const result = await cfAiRun({
          accountId,
          apiToken,
          model: TEXT_MODEL,
          body: {
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: user },
            ],
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            include_reasoning: false,
          },
          retries: 0,
        });
        try {
          translated = parseJson(extractChatText(result));
        } catch (e) {
          lastReason = e instanceof Error ? e.message : String(e);
          log(`   ⚠️ ${rec.id}: 翻訳結果をJSONとして読めません（試行 ${attempt}/${MAX_ATTEMPTS}）`);
        }
      } catch (e) {
        lastReason = e instanceof CfError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e);
        log(`   ⚠️ ${rec.id}: AI呼び出しに失敗（試行 ${attempt}/${MAX_ATTEMPTS}）`);
        if (e instanceof CfError && !e.retryable) break;
      }
    }

    if (translated === null) {
      log(`   ❌ ${rec.id}: 翻訳できませんでした（${lastReason}）。既存データは変更しません。`);
      continue;
    }

    const problem = verify(rec, translated);
    if (problem) {
      log(`   ❌ ${rec.id}: 検証失敗「${problem}」。既存データは変更しません。`);
      continue;
    }

    const idx = list.findIndex((x) => x.id === rec.id);
    list[idx] = { ...rec, ...(translated as RawRecord), id: rec.id };
    changed += 1;
    log(`   ✅ ${rec.id}: 日本語に翻訳しました`);
  }

  if (changed === 0) {
    log('変更なし（ファイルは書き込みません）。');
    return;
  }
  writeFileSync(PATH_OFFSPRING, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  log(`💾 data/offspring.json を更新しました（${changed} 件）。`);
}

main().catch((e: unknown) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
