/**
 * 配合ワーカー: Issue選択 → 検証 → 要素抽出（キャッシュ）→ AI生成 → 画像生成 → 保存。
 * （issue #16 / 追加開発指示 §11「Actions統合」）
 *
 * 使い方:
 *   node --experimental-strip-types scripts/process-breeding.ts            # 本番（Actions）
 *   node --experimental-strip-types scripts/process-breeding.ts --dry-run  # AI・書き込み・Issue操作なし
 *   node --experimental-strip-types scripts/process-breeding.ts --check-ai # 接続確認のみ（1回だけ呼び出す）
 *
 * 処理順（AGENTS.md「交配ワーカーの必須仕様」準拠）:
 *   起床（cronは間隔の確認だけ）→ open Issueから最古1件を選択 → バリデーション（AI呼び出し前）→
 *   間隔・日次上限のゲート → 要素抽出（キャッシュ）→ 生成 → 出力JSON検証 →
 *   画像（失敗しても続行）→ ローカル保存 → （ワークフローがコミット）→
 *   Issueへ結果コメント＆クローズ（ワークフロー側 = コミット後）
 *
 * セキュリティ:
 * - Secrets は環境変数だけ（.env は fs で読む。shell に source しない・表示しない）。
 *   `VITE_` プレフィックスは使わない（ビルド成果物へ漏れるため）。
 * - Issue本文・ユーザーのひとこと・AI出力を shell コマンドや Actions 式へ埋め込まない。
 *   却下・失敗の理由コメントはこのスクリプトが GitHub API へ直接送る。
 *   結果報告コメントのみ、内容をファイル（tmp/breed-report.md）に書いて
 *   ワークフローが `gh --body-file` で読む（シェル文字列化しない）。
 * - エラーログにトークン・シークレットを出さない。
 * - dry-run: AI呼び出し・データ書き込み・Issue操作をすべて禁止（本番枠も消費しない）。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CfError,
  cfAiRun,
  decodeBase64Image,
  extractChatText,
  extractImageBase64,
} from '../lib/cloudflare.ts';
import {
  buildBlendPrompt,
  buildImagePrompt,
  parseBlendResponse,
  type GeneratedIdea,
} from '../lib/blend.ts';
import {
  buildElementsPrompt,
  contentVersion,
  emptyElementCache,
  lookupElements,
  parseElementsResponse,
  parseElementCache,
  putElements,
  type ParentSource,
  type WorkElements,
} from '../lib/elements.ts';
import { commentIssue, getIssue, listOpenIssues, type GhOptions } from '../lib/github.ts';
import { parseBreedingIssue, parentPairKey } from '../lib/issue.ts';
import { isAutoRequestIssue } from '../lib/auto-request.ts';
import { parseParentRef } from '../lib/parent-ref.ts';
import { isRequestHash, requestHashOf } from '../lib/breed-key.ts';
import { detectLanguageRequest } from '../lib/language.ts';
import { parsePromptsConfig, type PromptsConfig } from '../lib/prompts.ts';
import { parseSearchTaxonomy, type SearchTaxonomy } from '../lib/search.ts';
import { computeGeneration, nextOffspringId, slotKey } from '../lib/generation.ts';
import { readDeletedOffspringIds } from '../lib/deleted-offspring.ts';
import { repoConfigFromEnv } from '../lib/config.ts';
import {
  MAX_FAILED_ATTEMPTS,
  emptyProcessedIssues,
  isProcessedIssues,
  selectBreedingIssue,
  type IssueRecord,
  type ProcessedIssues,
} from '../lib/queue.ts';
import {
  breedingFreqLabel,
  breedingSlotsPerDay,
  currentBreedingSlot,
  initialBreedingState,
  isBreedingState,
  parseScheduleConfig,
  recordBreedingAttempt,
  shouldBreed,
  utcDay,
  type BreedingState,
  type ScheduleConfig,
} from '../lib/schedule.ts';
import {
  emptyAiUsage,
  extractTokenUsage,
  parseAiUsage,
  recordAiUsage,
  type AiUsageFile,
} from '../lib/usage.ts';
import {
  BLEND_MODE_LABELS,
  type Offspring,
  type ParentId,
  type ProtopediaWork,
} from '../lib/types.ts';
import { loadDotEnv } from './load-env.ts';

// --- 定数（追加開発指示 §2: 公式ドキュメントで確認したモデル） ------------------

/** 要素抽出・発明生成に使うテキストモデル */
const TEXT_MODEL = '@cf/openai/gpt-oss-20b';
/** サムネイル画像モデル（512x512 JPEG応答をPNG保存） */
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_STEPS = 4; // flux-1-schnell の既定（最大8）
const IMAGE_SIZE = 512;

/** AI呼び出しの上限（1実行あたり。日次上限は config/schedule.json の dailyAiCallLimit）。 */
// パース失敗を含めた再試行の上限（無限リトライしない）。3回: Workers AI が
// 断続的に空応答を返す実測（issue #45 / 24時間で3件中2件の枠を消費）に1回分の余裕を足した。
const MAX_TEXT_ATTEMPTS = 3;
const EXTRACT_MAX_TOKENS = 1200;
const GENERATE_MAX_TOKENS = 2500;
const GEN_TEMPERATURE = 0.9;
const EXTRACT_TEMPERATURE = 0.2;

const PATHS = {
  schedule: fileURLToPath(new URL('../config/schedule.json', import.meta.url)),
  prompts: fileURLToPath(new URL('../config/prompts.json', import.meta.url)),
  taxonomy: fileURLToPath(new URL('../config/search-taxonomy.json', import.meta.url)),
  offspring: fileURLToPath(new URL('../data/offspring.json', import.meta.url)),
  prototypes: fileURLToPath(new URL('../data/prototypes.json', import.meta.url)),
  samplePrototypes: fileURLToPath(new URL('../data/sample-prototypes.json', import.meta.url)),
  elementCache: fileURLToPath(new URL('../data/element-cache.json', import.meta.url)),
  processed: fileURLToPath(new URL('../data/processed-issues.json', import.meta.url)),
  usage: fileURLToPath(new URL('../data/ai-usage.json', import.meta.url)),
  state: fileURLToPath(new URL('../data/breeding-state.json', import.meta.url)),
  imageDir: fileURLToPath(new URL('../public/static/assets/inventions/', import.meta.url)),
  report: fileURLToPath(new URL('../tmp/breed-report.md', import.meta.url)),
  tmpDir: fileURLToPath(new URL('../tmp/', import.meta.url)),
  env: fileURLToPath(new URL('../.env', import.meta.url)),
};

// --- ヘルパー ------------------------------------------------------------------

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 原子的JSON書き込み（tmp → rename。書き込み途中の断片で壊れない）。 */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Actions の出力。値は自前のID・番号・enumだけ（外部入力を含めない）。 */
function setOutput(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file || !/^[A-Za-z0-9_-]+$/.test(key)) return;
  if (/[\r\n=]/.test(value)) return;
  appendFileSync(file, `${key}=${value}\n`);
}

function log(msg: string): void {
  console.log(msg);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readWorkset(path: string): ProtopediaWork[] {
  if (!existsSync(path)) return [];
  const raw = readJson(path) as { works?: unknown };
  if (!Array.isArray(raw.works)) throw new Error(`${path} の works が配列ではありません`);
  return raw.works.filter(
    (w): w is ProtopediaWork =>
      !!w && typeof w === 'object' && typeof w.id === 'string' && typeof w.title === 'string',
  );
}

function readOffspringFile(path: string): Offspring[] {
  if (!existsSync(path)) return [];
  const raw = readJson(path);
  if (!Array.isArray(raw)) throw new Error('data/offspring.json が配列ではありません');
  return raw as Offspring[];
}

/** config/schedule.json（不正なら exit 1 = 処理停止）。 */
function loadSchedule(): ScheduleConfig {
  const parsed = parseScheduleConfig(readJson(PATHS.schedule));
  if (!parsed.ok) fail(`config/schedule.json が不正なため処理を停止します: ${parsed.reason}`);
  return parsed.config;
}

/** config/schedule.json を読めない場合も exit 1（failProcess内での保険）。 */
function loadScheduleOrThrow(): ScheduleConfig {
  const parsed = parseScheduleConfig(readJson(PATHS.schedule));
  if (!parsed.ok) throw new Error(`config/schedule.json が不正: ${parsed.reason}`);
  return parsed.config;
}

/**
 * config/prompts.json（プロンプトの文言 / issue #25）。
 * 読めない・不正なら exit 1 = AIを呼ばない（config/schedule.json と同一の扱い）。
 */
function loadPrompts(): PromptsConfig {
  let raw: unknown;
  try {
    raw = readJson(PATHS.prompts);
  } catch (e) {
    fail(`config/prompts.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parsePromptsConfig(raw);
  if (!parsed.ok) fail(`config/prompts.json が不正なため処理を停止します: ${parsed.reason}`);
  return parsed.config;
}

/**
 * config/search-taxonomy.json（検索用の分野・技術分類 / issue #38）。
 * 読めない・不正なら exit 1 = AIを呼ばない（config/prompts.json と同一の扱い）。
 * 生成プロンプトに正規の分野リストを埋め込み、AIの分類ゆれを減らす。
 */
function loadTaxonomy(): SearchTaxonomy {
  let raw: unknown;
  try {
    raw = readJson(PATHS.taxonomy);
  } catch (e) {
    fail(`config/search-taxonomy.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseSearchTaxonomy(raw);
  if (!parsed.ok) fail(`config/search-taxonomy.json が不正なため処理を停止します: ${parsed.reason}`);
  return parsed.config;
}

/** data/breeding-state.json（壊れていると間隔制御ができない → 停止）。 */
function loadState(): BreedingState {
  if (!existsSync(PATHS.state)) return initialBreedingState();
  const raw = readJson(PATHS.state);
  if (!isBreedingState(raw)) throw new Error('data/breeding-state.json の形式が不正');
  return raw;
}

/** data/processed-issues.json（壊れていると二重処理になる → 停止）。 */
function loadProcessed(): ProcessedIssues {
  if (!existsSync(PATHS.processed)) return emptyProcessedIssues();
  const raw = readJson(PATHS.processed);
  if (!isProcessedIssues(raw)) throw new Error('data/processed-issues.json の形式が不正');
  return raw;
}

/** data/ai-usage.json（壊れていると利用量を推定できない → 停止 / 追加開発指示 §10）。 */
function loadUsage(): AiUsageFile {
  if (!existsSync(PATHS.usage)) return emptyAiUsage();
  const raw = readJson(PATHS.usage);
  if (typeof raw !== 'object' || raw === null || (raw as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error('data/ai-usage.json の形式が不正');
  }
  return parseAiUsage(raw);
}

// --- check-ai（接続確認 / 追加開発指示 §13-1） ----------------------------------

async function checkAi(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
  if (!accountId || !apiToken) {
    fail('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定です（.env または Actions Secrets）');
  }
  log(`🔎 テキスト生成の接続確認: ${TEXT_MODEL}`);
  try {
    const result = await cfAiRun({
      accountId,
      apiToken,
      model: TEXT_MODEL,
      body: {
        messages: [{ role: 'user', content: '「OK」とだけ返してください。' }],
        // gpt-oss は**推論モデル**: max_tokens は思考も含む予算。
        // 20 では思考だけで枯渇し content=null / finish_reason=length になる（実測 2026-11）。
        // 300 で本文が確実に返ることを確認済み。include_reasoning で思考を応答本文に混ぜない
        // （reasoning_effort はこのエンドポイントで HTTP 400 = 不可、include_reasoning は受理）。
        max_tokens: 300,
        temperature: 0,
        include_reasoning: false,
      },
      retries: 0,
      timeoutMs: 30_000,
    });
    const text = extractChatText(result).trim();
    if (!text) {
      // 切り分け情報を残す（値は出力しない。トークン・応答本文の秘匿性には影響しない範囲だけ）。
      const obj = (result !== null && typeof result === 'object' ? result : {}) as Record<string, unknown>;
      const choices = Array.isArray(obj.choices) ? obj.choices : [];
      const c0 = (choices[0] !== null && typeof choices[0] === 'object' ? choices[0] : {}) as Record<
        string,
        unknown
      >;
      const finish = typeof c0.finish_reason === 'string' ? c0.finish_reason : '不明';
      const usage = obj.usage !== undefined ? JSON.stringify(obj.usage) : 'なし';
      fail(
        `接続は成功しましたが本文を取得できません（finish_reason=${finish} / usage=${usage}）` +
          (finish === 'length'
            ? ' — max_tokens が不足しています（推論モデルの思考が予算を消費）。'
            : ' — 応答形式は lib/cloudflare.ts の抽出候補を確認してください。'),
      );
    }
    log(`✅ 接続OK: 応答「${text.slice(0, 40)}」（${text.length}文字）`);
    process.exit(0);
  } catch (e) {
    if (e instanceof CfError) fail(`接続確認に失敗しました [${e.kind}] ${e.message}`);
    fail(`接続確認に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- 本体 ----------------------------------------------------------------------

interface ResolvedParent {
  id: ParentId;
  title: string;
  summary: string;
  /** 抽出用の補足（ProtoPedia=systemDescription / 子作品=concept+mechanism） */
  extra?: string;
  generation: number;
}

async function main(): Promise<void> {
  loadDotEnv(PATHS.env); // 設定済みの環境変数（Actions Secrets）は上書きしない

  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run') || process.env.DRY_RUN === 'true';
  if (args.has('--check-ai')) {
    await checkAi();
    return;
  }

  const cfg = loadSchedule();
  // 時間帯別設定（issue #41）なら時間帯、なければ従来の間隔を表示する。
  const freqText = cfg.breedingWindows
    ? `${breedingFreqLabel(cfg)}・1日${breedingSlotsPerDay(cfg)}枠`
    : `配合間隔 ${cfg.breedingIntervalMinutes}分`;
  log(`ℹ️ 頻度設定: ${freqText} / 日次AI上限 ${cfg.dailyAiCallLimit ?? '（未設定）'}回${dryRun ? ' / DRY-RUN' : ''}`);

  // プロンプト文言の読み込み（不正ならここで exit 1 = AIを呼ばない / issue #25）
  const prompts = loadPrompts();
  log(
    `ℹ️ プロンプト設定: config/prompts.json（配合タイプ指示${Object.keys(prompts.modeInstructions).length}件 / ルール${prompts.sharedRules.length}件 / 画像スタイル${prompts.imageStyleSuffix.length}字）`,
  );

  // 検索用の分野・技術分類（issue #38）。不正なら AI を呼ばず停止する。
  const taxonomy = loadTaxonomy();
  log(
    `ℹ️ 検索分類: config/search-taxonomy.json（分野${taxonomy.domains.length}件 / 技術${taxonomy.technologies.length}件）`,
  );

  const repoCfg = repoConfigFromEnv(process.env);
  if (!repoCfg) {
    fail('GITHUB_REPOSITORY（owner/repo）が未設定です。Issue取得ができないため停止します。');
  }
  const ghOpts: GhOptions = {
    // Actions は GITHUB_TOKEN。ローカル（dry-run含む）は .env の GH_TOKEN を流用（scripts/gh.mjs と同じ扱い）。
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '',
    repo: `${repoCfg.owner}/${repoCfg.repo}`,
  };

  // --- ローカルデータ（外部APIはProtoPediaを呼ばない。AIはCloudflareだけ） -------
  const offspring = readOffspringFile(PATHS.offspring);
  // 削除済みID台帳（issue #32）。壊れていたらAI呼び出しの前に停止する。
  const retiredIds = readDeletedOffspringIds();
  const processed = loadProcessed();
  const usage = loadUsage();
  let state = loadState();

  // キャッシュは壊れていても再抽出するだけ（コストは dailyAiCallLimit が守る） → 空として続行
  let cache = emptyElementCache();
  try {
    if (existsSync(PATHS.elementCache)) cache = parseElementCache(readJson(PATHS.elementCache));
  } catch {
    log('⚠️ data/element-cache.json を読めませんでした（キャッシュ無効で続行します）');
  }

  const poolWorks = [...readWorkset(PATHS.prototypes), ...readWorkset(PATHS.samplePrototypes)];
  const poolById = new Map<string, ProtopediaWork>(poolWorks.map((w) => [w.id, w]));
  const offspringById = new Map(offspring.map((o) => [o.id, o]));
  const knownProtopediaIds = new Set<string>(poolById.keys());
  const knownOffspringIds = new Set<string>(offspringById.keys());
  const edges = offspring.flatMap((o) => o.parents.map((p): [string, string] => [p, o.id]));

  // --- 0. 既存親ペアのインデックス（同じ親の組を重複生成しない / issue #47） -----
  // 順序無視の親ペア → 子作品ID。配合タイプ・コメントが違う再申請は
  // requestHash（4項目一致）では拾えないため、ペア単位で別途判定する。
  // 削除済みの子（deleted-offspring.json）はここに載らない = ペアの解放を許す。
  const existingByParentPair = new Map<string, string>();
  for (const o of offspring) {
    const [pa, pb] = o.parents;
    if (typeof pa !== 'string' || typeof pb !== 'string') continue;
    const pairKey = parentPairKey(pa, pb);
    if (!existingByParentPair.has(pairKey)) existingByParentPair.set(pairKey, o.id);
  }

  // --- 1. 配合条件インデックス（重複判定 / issue #37） --------------------------
  // 同じ条件（親A・親B・配合タイプ・コメント）の発明がすでにあれば、AIを呼ばずに
  // 既存の発明を返す。requestHash の無い既存データは**元のIssue本文から復元**し、
  // 復元できなければ推測せず「重複判定できないデータ」として明示する。
  const existingByRequestHash = new Map<string, string>();
  /** 復元できた既存データ（通常の生成時だけ offspring.json へ書き戻す） */
  const rebuiltHashes = new Map<string, string>();
  const unresolvable: string[] = [];
  for (const o of offspring) {
    if (isRequestHash(o.requestHash)) {
      if (!existingByRequestHash.has(o.requestHash)) existingByRequestHash.set(o.requestHash, o.id);
      continue;
    }
    if (!o.sourceIssue || o.sourceIssue <= 0) {
      unresolvable.push(`${o.id}（元のIssue参照がありません）`);
      continue;
    }
    if (!ghOpts.token) {
      unresolvable.push(`${o.id}（Issueを取得するトークンがありません）`);
      continue;
    }
    try {
      const rec = await getIssue(o.sourceIssue, ghOpts);
      const parsed = parseBreedingIssue(rec.body);
      if (!parsed.ok) throw new Error(parsed.reason);
      // 元Issueの条件が保存データと一致するときだけ信頼する（他人のIssueと取り違えない）
      if (
        parsed.request.parentA !== o.parents[0] ||
        parsed.request.parentB !== o.parents[1] ||
        parsed.request.mode !== o.mode
      ) {
        throw new Error('元のIssueの配合条件が保存データと一致しません');
      }
      const h = requestHashOf(parsed.request);
      if (!existingByRequestHash.has(h)) existingByRequestHash.set(h, o.id);
      rebuiltHashes.set(o.id, h);
    } catch (e) {
      unresolvable.push(`${o.id}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  log(
    `   配合条件インデックス: ${existingByRequestHash.size}件（Issueからの復元 ${rebuiltHashes.size}件）`,
  );
  if (unresolvable.length > 0) {
    log(
      `   ⚠️ 重複判定できない既存データ（推測せず対象外）: ${unresolvable.join(' / ')}`,
    );
  }

  // --- 1. キュー取得（open Issue / 作成日時昇順 / ラベル非信用） -----------------
  log('🔎 open Issueを取得しています…');
  const issues: IssueRecord[] = await listOpenIssues(ghOpts).catch((e: unknown): never => {
    fail(`Issue一覧を取得できません: ${e instanceof Error ? e.message : String(e)}`);
  });
  log(`   ${issues.length}件のopen Issue`);

  const selection = selectBreedingIssue(issues, {
    processed,
    knownProtopediaIds,
    knownOffspringIds,
    existingByRequestHash,
    existingByParentPair,
    edges,
  });

  if (selection.action === 'none') {
    log('⏭ 処理対象の配合申請はありません（未処理で有効なIssueなし）');
    setOutput('outcome', 'none');
    return;
  }

  const now = new Date();
  const day = utcDay(now);

  // --- 2. 却下（AI呼び出し前。理由をコメントして記録 = 無限再処理しない） --------
  if (selection.action === 'reject') {
    const { issue, reason, key } = selection;
    log(`🚫 Issue #${issue.number} を却下します（AIは呼び出しません）: ${reason}`);
    if (dryRun) {
      log('🏁 dry-run: 却下コメントは投稿せず、記録もしません。');
      setOutput('outcome', 'dry-run');
      return;
    }
    const attempts = (processed[key]?.attempts ?? 0) + 1;
    const comment = [
      'この配合申請は処理せずに却下しました（AIは呼び出していません）。',
      '',
      `理由: ${reason}`,
      '',
      `同じIssueは再処理しません（処理状況は data/processed-issues.json に記録・${attempts}回目）。`,
      '内容を直して試したい場合は、新しいIssueで再申請してください。',
    ].join('\n');
    try {
      await commentIssue(issue.number, comment, ghOpts);
    } catch (e) {
      // コメントできなければ記録もしない（= 次回もう一度試す。理由が伝わらないまま永久にスキップしない）
      fail(`却下コメントの投稿に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    processed[key] = { issue: issue.number, status: 'rejected', reason, at: now.toISOString(), attempts };
    writeJsonAtomic(PATHS.processed, processed);
    setOutput('outcome', 'rejected');
    setOutput('issue_number', String(issue.number));
    return;
  }

  // --- 2.5 キャッシュヒット（同じ配合条件の発明がすでに存在する / issue #37） ----
  // これは却下ではなく**正常な処理**: AIを呼び出さず、新IDも画像も作らず、
  // 既存の発明へのリンクをIssueへコメントして処理済みとしてクローズする。
  // 間隔ゲートも消費しない（生成を行わないため、時間枠を空ける必要がない）。
  if (selection.action === 'reuse') {
    const { issue, request, key, existingId } = selection;
    const existing = offspringById.get(existingId);
    log(
      `♻️ 同じ配合条件の発明がすでにあります: ${existingId}（Issue #${issue.number} は新規生成しません / AI呼び出し 0回）`,
    );
    if (dryRun) {
      log(`🏁 dry-run: 本番なら ${existingId}「${existing?.title ?? ''}」を案内してIssueを閉じます。`);
      setOutput('outcome', 'dry-run');
      setOutput('issue_number', String(issue.number));
      return;
    }

    // --- 保存は process-breeding の通常処理と同様、失敗しても記録を残さない ---
    const attempts = (processed[key]?.attempts ?? 0) + 1;
    processed[key] = {
      issue: issue.number,
      status: 'resolved',
      reason: `cache-hit: ${existingId}`,
      at: new Date().toISOString(),
      attempts,
    };
    writeJsonAtomic(PATHS.processed, processed);

    // コメントはこのスクリプトがファイルに書き、ワークフローが --body-file で読む
    // （AI出力・ユーザー入力を shell / Actions式へ埋め込まない）。
    const siteUrl = (process.env.SITE_URL ?? `https://${repoCfg.owner}.github.io/${repoCfg.repo}/`).replace(/\/+$/, '');
    const lines = [
      `♻️ すでに同じ配合で生まれた発明があります: ${existingId}${existing ? `「${existing.title}」` : ''}`,
      '',
      '親A・親B・配合タイプ・ひとことが同じだったため、新規生成は行わず既存の発明をご案内します（生成AIは呼び出していません）。',
      '',
      `配合: ${request.parentA} × ${request.parentB} / ${BLEND_MODE_LABELS[request.mode]}`,
      `詳細を見る: ${siteUrl}/?id=${existingId}`,
      '',
      '同じ親でも、配合タイプかひとこと（コメント）を変えると新しい発明を生成できます。',
      '',
      '※ これはAIが考えた未実装の発明アイデアです（実際に製作したものではありません）。',
    ];
    mkdirSync(PATHS.tmpDir, { recursive: true });
    writeFileSync(PATHS.report, `${lines.join('\n')}\n`, 'utf8');

    setOutput('outcome', 'reused');
    setOutput('issue_number', String(issue.number));
    setOutput('offspring_id', existingId);
    return;
  }

  // --- 3. 妥当な申請1件（最も古いもの） ----------------------------------------
  const { issue, request, key } = selection;
  log(`🧬 Issue #${issue.number} を処理します: ${request.parentA} × ${request.parentB} / mode=${request.mode}`);

  // 配合ゲート（間隔・連続失敗冷却・日次上限 / issue #15）。dry-runでは確認だけして続行。
  const decision = shouldBreed(state, cfg, now);
  if (!decision.run && !dryRun) {
    log(`⏭ スキップ: ${decision.reason}（Issueはopenのまま、次回の起床で再確認します）`);
    setOutput('outcome', 'gated');
    setOutput('issue_number', String(issue.number));
    return;
  }
  log(decision.run ? `   実行可否: ${decision.reason}` : `ℹ️ dry-run: 通常ならスキップされます（${decision.reason}）— 確認のみ続行します`);

  // --- dry-run ここまで（AI呼び出し・書き込み・Issue操作は一切しない） ----------
  if (dryRun) {
    log('🏁 dry-run: ここから先（要素抽出・AI生成・画像・保存・Issue操作）は実行しません。');
    log(`   対象: Issue #${issue.number} / 親: ${request.parentA} × ${request.parentB} / 配合タイプ: ${BLEND_MODE_LABELS[request.mode]}`);
    log(`   研究員へのひとこと: ${request.comment ? 'あり（内容はログに出しません）' : 'なし'}`);
    setOutput('outcome', 'dry-run');
    setOutput('issue_number', String(issue.number));
    return;
  }

  // --- 4. Cloudflare Credentials（未設定ならAI前に停止 = コスト0） --------------
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
  if (!accountId || !apiToken) {
    fail('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN が未設定のため生成できません（Actions Secrets / .env を確認してください）');
  }

  // --- 5. 失敗処理（この実行でのみ使うクロージャ） ------------------------------
  let aiCallsMade = 0;
  let usageFile = usage;

  /**
   * 選択済みIssueの失敗処理。
   * - 理由をIssueへコメント（試行は最大 MAX_FAILED_ATTEMPTS 回 → 超過は無限再処理しない）
   * - processed-issues に failed 記録 / breeding-state に失敗記録 / 抽出済みキャッシュ・利用量を保存
   * コメント投稿に失敗しても記録はする（次回の試行で再びコメントする）。
   */
  const failProcess = async (reason: string): Promise<void> => {
    console.error(`❌ 配合処理に失敗しました: ${reason}`);
    const attempts = (processed[key]?.attempts ?? 0) + 1;
    processed[key] = { issue: issue.number, status: 'failed', reason, at: new Date().toISOString(), attempts };
    try {
      writeJsonAtomic(PATHS.processed, processed);
    } catch (e) {
      console.error(`⚠️ processed-issues の保存に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const fcfg = loadScheduleOrThrow();
      const fnow = new Date();
      let next = recordBreedingAttempt(state, fcfg, { now: fnow, success: false });
      // 実際のAI呼び出し回数で日次カウントを合わせる（既定の+1を実呼び出し数に補正）
      const fday = utcDay(fnow);
      next = {
        ...next,
        aiCalls: { ...next.aiCalls, [fday]: Math.max(0, (next.aiCalls[fday] ?? 0) + (aiCallsMade - 1)) },
      };
      writeJsonAtomic(PATHS.state, next);
      state = next;
    } catch (e) {
      console.error(`⚠️ breeding-state の保存に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      writeJsonAtomic(PATHS.elementCache, cache);
      writeJsonAtomic(PATHS.usage, usageFile);
    } catch {
      /* キャッシュ・利用量の保存失敗は次回の再抽出/記録で吸収する（致命的ではない） */
    }

    const giveUp = attempts >= MAX_FAILED_ATTEMPTS;
    const comment = [
      '配合処理に失敗しました（新しい発明は生まれていません）。',
      '',
      `理由: ${reason}`,
      '',
      giveUp
        ? `試行回数が上限（${MAX_FAILED_ATTEMPTS}回）に達したため、このIssueの再処理は行いません。必要なら新しいIssueで再申請してください。`
        : `試行 ${attempts}/${MAX_FAILED_ATTEMPTS} — 一時的な失敗の可能性があるため、次の実行で再試行します。`,
    ].join('\n');
    try {
      await commentIssue(issue.number, comment, ghOpts);
    } catch (e) {
      console.error(`⚠️ 失敗コメントの投稿に失敗（次回の試行で再コメントします）: ${e instanceof Error ? e.message : String(e)}`);
    }
    setOutput('outcome', 'failed');
    setOutput('issue_number', String(issue.number));
  };

  const resolveParent = (id: string): ResolvedParent | null => {
    // 種類は構造で判定（issue #36）。ProtoPedia側も**APIを呼ばず**保存済みプールから読む
    // （AI生成親に対してProtoPedia APIを呼ぶことはもとと無い = ここはJSON参照だけ）。
    const ref = parseParentRef(id);
    if (ref === null) return null;
    if (ref.source === 'protopedia') {
      const w = poolById.get(id);
      if (!w) return null;
      return { id: w.id, title: w.title, summary: w.summary, extra: w.systemDescription, generation: 0 };
    }
    const o = offspringById.get(id);
    if (!o) return null;
    return {
      // mashup-<数字> 形式は validateParents（キュー選択）で検証済み
      id: o.id as ParentId,
      title: o.title,
      summary: o.summary,
      // AI生成親の入力は保存済みJSON（発明名・概要・仕組み・継承要素）だけ
      extra: `${o.concept} ${o.mechanism} 継承: ${o.inheritedTraits
        .map((t) => `${t.parentId} から ${t.trait}`)
        .join(' / ')}`,
      generation: o.generation,
    };
  };

  const parentA = resolveParent(request.parentA);
  const parentB = resolveParent(request.parentB);
  if (!parentA || !parentB) {
    await failProcess(
      `親作品の保存済みデータが見つかりません（${!parentA ? request.parentA : request.parentB}）。`,
    );
    process.exit(1);
  }

  const recordText = (result: unknown): void => {
    usageFile = recordAiUsage(usageFile, day, { kind: 'text', ...extractTokenUsage(result) }, now);
  };

  // --- 6. 要素抽出（作品ID + 内容バージョンのキャッシュ。有効ならAIを呼ばない） ---
  const extractElements = async (src: ResolvedParent): Promise<WorkElements> => {
    const version = contentVersion({ title: src.title, summary: src.summary, extra: src.extra });
    const hit = lookupElements(cache, src.id, version);
    if (hit) {
      log(`   要素抽出: ${src.id} はキャッシュヒット（内容バージョン ${version}）— AIを呼びません`);
      return hit;
    }
    const prompt = buildElementsPrompt({
      id: src.id,
      title: src.title,
      summary: src.summary,
      extra: src.extra,
    } satisfies ParentSource);

    let authFailed = false;
    for (let attempt = 1; attempt <= MAX_TEXT_ATTEMPTS; attempt++) {
      log(`   要素抽出: ${src.id} をAIで分析します（試行 ${attempt}/${MAX_TEXT_ATTEMPTS}）`);
      try {
        const result = await cfAiRun({
          accountId,
          apiToken,
          model: TEXT_MODEL,
          body: {
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            max_tokens: EXTRACT_MAX_TOKENS,
            temperature: EXTRACT_TEMPERATURE,
          },
          retries: 0, // 再試行はこのループで管理（呼び出し回数を正確に数えるため）
        });
        aiCallsMade += 1;
        recordText(result);
        const elements = parseElementsResponse(extractChatText(result));
        if (elements) {
          cache = putElements(cache, src.id, version, elements, TEXT_MODEL, now);
          return elements;
        }
        log('   ⚠️ 抽出結果が不正なJSONでした');
      } catch (e) {
        aiCallsMade += 1;
        const label = e instanceof CfError ? `[${e.kind}]` : '';
        log(`   ⚠️ 要素抽出に失敗しました ${label}`);
        if (e instanceof CfError && !e.retryable) {
          authFailed = e.kind === 'auth';
          break; // auth / bad-request は再試行しても無駄
        }
      }
    }
    throw new Error(
      authFailed
        ? 'Cloudflare Workers AI の認証に失敗しました（CLOUDFLARE_* を確認してください）'
        : '要素抽出が上限回数に達しても成功しませんでした',
    );
  };

  // --- 7. 生成（配合タイプ別プロンプト + JSON検証） -----------------------------
  let idea: GeneratedIdea;
  let elementsA: WorkElements;
  let elementsB: WorkElements;
  try {
    elementsA = await extractElements(parentA);
    elementsB = await extractElements(parentB);
  } catch (e) {
    await failProcess(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  {
    const prompt = buildBlendPrompt({
      mode: request.mode,
      parentA: { id: parentA.id, title: parentA.title, elements: elementsA },
      parentB: { id: parentB.id, title: parentB.title, elements: elementsB },
      comment: request.comment,
      // 言語指定は申請コメント（許可された入力）のみから（issue #23 §4）。
      // 元作品の説明文が英語でも日本語のまま。
      language: detectLanguageRequest(request.comment),
    }, prompts, taxonomy); // 文言は config/prompts.json（issue #25）/ 分類は search-taxonomy.json（issue #38）

    let lastReason = '不明なエラー';
    let generated: GeneratedIdea | null = null;
    for (let attempt = 1; attempt <= MAX_TEXT_ATTEMPTS && !generated; attempt++) {
      log(`   発明を生成しています…（試行 ${attempt}/${MAX_TEXT_ATTEMPTS}）`);
      try {
        const result = await cfAiRun({
          accountId,
          apiToken,
          model: TEXT_MODEL,
          body: {
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            max_tokens: GENERATE_MAX_TOKENS,
            temperature: GEN_TEMPERATURE,
          },
          retries: 0,
        });
        aiCallsMade += 1;
        recordText(result);
        const parsed = parseBlendResponse(
          extractChatText(result),
          request.mode,
          detectLanguageRequest(request.comment) ?? 'ja',
        );
        if (parsed.ok) {
          generated = parsed.idea;
        } else {
          lastReason = parsed.reason;
          log(`   ⚠️ 出力検証に失敗: ${parsed.reason}`);
        }
      } catch (e) {
        aiCallsMade += 1;
        lastReason = e instanceof CfError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e);
        if (e instanceof CfError && !e.retryable) break; // auth / bad-request は再試行しない
        log('   ⚠️ 生成に失敗しました（再試行します）');
      }
    }
    if (!generated) {
      await failProcess(`発明の生成に失敗しました: ${lastReason}`);
      process.exit(1);
    }
    idea = generated;
  }

  // --- 8. Offspring を組み立てる ------------------------------------------------
  const id = nextOffspringId(
    offspring.map((o) => o.id),
    retiredIds, // 削除済みIDは再利用しない（issue #32）
  );
  const generation = computeGeneration([parentA.generation, parentB.generation]);
  const imagePromptText = buildImagePrompt(idea, prompts); // スタイル文言は config/prompts.json

  // --- 9. 画像（FLUX）。**失敗してもテキスト先行保存**（最重要事項: 系譜蓄積優先） -
  let imagePath: string | null = null;
  try {
    log(`   サムネイルを生成しています…（${IMAGE_MODEL} / ${IMAGE_SIZE}x${IMAGE_SIZE}）`);
    const result = await cfAiRun({
      accountId,
      apiToken,
      model: IMAGE_MODEL,
      body: { prompt: imagePromptText, steps: IMAGE_STEPS },
      retries: 1, // 画像の自動再試行は1回まで（追加開発指示 §10）
      timeoutMs: 90_000,
    });
    aiCallsMade += 1;
    usageFile = recordAiUsage(usageFile, day, { kind: 'image', steps: IMAGE_STEPS }, now);
    const b64 = extractImageBase64(result);
    if (!b64) throw new CfError('response', '応答に画像が含まれていません', { model: IMAGE_MODEL });
    const buf = decodeBase64Image(b64);
    const sharp = (await import('sharp')).default;
    mkdirSync(PATHS.imageDir, { recursive: true });
    await sharp(buf).resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'cover' }).png().toFile(`${PATHS.imageDir}${id}.png`);
    imagePath = `assets/inventions/${id}.png`; // サイトルート相対（先頭スラッシュなし）
    log(`   💾 画像を保存しました: ${imagePath}`);
  } catch (e) {
    const reason = e instanceof CfError ? `[${e.kind}] ${e.message}` : e instanceof Error ? e.message : String(e);
    log(`   ⚠️ 画像生成に失敗しました: ${reason}`);
    log('   → テキストデータを先行保存します（imagePath=null / 系譜の蓄積を優先）');
    imagePath = null;
  }

  const createdAt = now.toISOString();
  // 自動申請由来か（issue #49）。本文のマーカーで判定（login やタイトルは信用しない）。
  const issueAutoRequest = isAutoRequestIssue(issue.body);
  const newChild: Offspring = {
    id,
    schemaVersion: 1,
    title: idea.name,
    summary: idea.summary,
    concept: idea.description,
    mechanism: idea.mechanism,
    useCases: idea.useCases,
    inheritedTraits: [
      { parentId: parentA.id, trait: idea.inheritedFromA },
      { parentId: parentB.id, trait: idea.inheritedFromB },
    ],
    parents: [parentA.id, parentB.id],
    generation,
    mode: request.mode,
    sourceIssue: issue.number,
    slot: slotKey(now),
    createdAt,
    model: TEXT_MODEL,
    status: 'idea',
    imagePrompt: imagePromptText,
    imagePath,
    // 配合条件のキー（issue #37）。同じ条件の次回申請からAI呼び出しを省く。
    requestHash: requestHashOf(request),
    // 自動申請由来のときは `requesterAuto` を立て、人の `requester` は保存しない
    // （自動と人手で「申し込んだ人」の表示を分ける / issue #49）。
    // 判定は本文マーカー（isAutoRequestIssue）。login の文字列で推測しない。
    ...(issueAutoRequest ? { requesterAuto: true as const } : {}),
    // 申請者の公開情報（issue #42）。GitHub APIのIssue件から、書式を通った
    // login / avatar_url の2項目だけ。無い・不正なら省く（= 表示も出さない）。
    requester: issueAutoRequest ? undefined : issue.user,
    // 検索用メタデータ（issue #38）。**この生成と同じAI出力**から取る
    // （検索のためだけの追加リクエストは無い）。空なら付けない
    // （= 判断できなかったことを隠さず、既存データと同じ「テキストから検索」に戻る）。
    ...(idea.technologies.length > 0 ? { technologies: idea.technologies } : {}),
    ...(idea.domains.length > 0 ? { domains: idea.domains } : {}),
    ...(idea.keywords.length > 0 ? { keywords: idea.keywords } : {}),
  };

  // --- 10. 保存（全ファイル原子書き込み。ワークフローがコミットする） ------------
  // 既存データの requestHash 復元（元Issueから）があれば、このタイミングだけ書き戻す
  // （キャッシュヒット経路では既存の発明データを変更しない / issue #37 §3・§5）。
  const offspringToSave = offspring.map((o) => {
    const h = rebuiltHashes.get(o.id);
    return h !== undefined && !o.requestHash ? { ...o, requestHash: h } : o;
  });
  writeJsonAtomic(PATHS.offspring, [...offspringToSave, newChild]);
  writeJsonAtomic(PATHS.elementCache, cache);
  writeJsonAtomic(PATHS.usage, usageFile);

  processed[key] = {
    issue: issue.number,
    status: 'resolved',
    at: createdAt,
    attempts: (processed[key]?.attempts ?? 0) + 1,
  };
  writeJsonAtomic(PATHS.processed, processed);

  // 状態（成功）。AI呼び出し回数は実際の呼び出し回数に合わせて補正する。
  // 時間帯別設定（issue #41）では**実行した枠**を lastSlot に残し、同じ枠の二重生成を防ぐ。
  const doneSlot = currentBreedingSlot(cfg, now);
  let nextState = recordBreedingAttempt(state, cfg, { now, success: true, slotKey: doneSlot?.key ?? null });
  nextState = {
    ...nextState,
    aiCalls: {
      ...nextState.aiCalls,
      [day]: Math.max(0, (nextState.aiCalls[day] ?? 0) + (aiCallsMade - 1)),
    },
  };
  writeJsonAtomic(PATHS.state, nextState);

  log(
    `✅ ${id}「${newChild.title}」を保存しました（Issue #${issue.number} / スロット ${newChild.slot}${doneSlot ? ` / 配合枠 ${doneSlot.key}` : ''}）`,
  );
  log(
    `   本日のAI呼び出し: ${nextState.aiCalls[day] ?? 0}回${cfg.dailyAiCallLimit !== undefined ? ` / 上限 ${cfg.dailyAiCallLimit}回` : ''}`,
  );

  // --- 11. 結果報告（コメント＆クローズは**コミット後**のワークフロー側で） ------
  // ファイルに書いて渡す = AI出力（title/summary）を shell・Actions式へ埋め込まない。
  const siteUrl = (process.env.SITE_URL ?? `https://${repoCfg.owner}.github.io/${repoCfg.repo}/`).replace(/\/+$/, '');
  const report = [
    `🧬 新しい発明が生まれました: ${id}「${newChild.title}」`,
    '',
    newChild.summary,
    '',
    `配合タイプ: ${BLEND_MODE_LABELS[request.mode]}`,
    `親: ${parentA.id} × ${parentB.id}`,
    `サムネイル: ${newChild.imagePath ? 'あり' : 'なし（画像生成に失敗したため、アイデアのテキストのみ保存しました）'}`,
    '',
    `詳細を見る: ${siteUrl}/?id=${id}`,
    '',
    '※ これはAIが考えた未実装の発明アイデアです（実際に製作したものではありません）。',
  ].join('\n');
  mkdirSync(PATHS.tmpDir, { recursive: true });
  writeFileSync(PATHS.report, `${report}\n`, 'utf8');

  setOutput('outcome', 'success');
  setOutput('issue_number', String(issue.number));
  setOutput('offspring_id', id);
}

main().catch((e: unknown) => {
  console.error(`❌ 予期しないエラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
