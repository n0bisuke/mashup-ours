/**
 * data/offspring.json の検証。
 * 使い方: npm run validate-data
 */
import { existsSync, readFileSync } from 'node:fs';
import { CANDIDATES_PER_SLOT, isCandidatesFile } from '../lib/candidates.ts';
import { computeGeneration, isAncestorDescendantPair, nextOffspringId } from '../lib/generation.ts';
import { samePair } from '../lib/issue.ts';
import {
  DEFAULT_AUTO_REQUEST_IDLE_HOURS,
  isBreedingState,
  parseScheduleConfig,
} from '../lib/schedule.ts';
import { parsePromptsConfig } from '../lib/prompts.ts';
import { ELEMENT_KEYS, isWorkElements } from '../lib/elements.ts';
import { isProcessedIssues } from '../lib/queue.ts';
import { isBreedingMode, statusLabel, type Offspring, type Workset } from '../lib/types.ts';

const FILE = new URL('../data/offspring.json', import.meta.url);
const WORKSET_FILE = new URL('../data/prototypes.json', import.meta.url);

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

// --- config/schedule.json（頻度設定 / issue #15） -----------------------------
// 最初に検証する（設定が不正な場合は処理を停止してエラーを通知する）。
const SCHEDULE_FILE = new URL('../config/schedule.json', import.meta.url);
let schedRaw: unknown;
try {
  schedRaw = JSON.parse(readFileSync(SCHEDULE_FILE, 'utf8'));
} catch (e) {
  fail(`config/schedule.json を読めません: ${String(e)}`);
}
const sched = parseScheduleConfig(schedRaw);
if (!sched.ok) fail(`config/schedule.json が不正です: ${sched.reason}`);
const scheduleCfg = sched.config;
const idleHours = scheduleCfg.autoRequestIdleHours ?? DEFAULT_AUTO_REQUEST_IDLE_HOURS;
console.log(
  `✅ config/schedule.json OK（候補更新 ${scheduleCfg.candidateRotationMinutes}分 / 配合 ${scheduleCfg.breedingIntervalMinutes}分 / 最大${scheduleCfg.maxCandidates}件 / 自動申請 ${idleHours === 0 ? '無効' : `${idleHours}時間`}）`,
);

// --- config/prompts.json（プロンプト文言設定 / issue #25） -------------------
const PROMPTS_FILE = new URL('../config/prompts.json', import.meta.url);
let promptsRaw: unknown;
try {
  promptsRaw = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8'));
} catch (e) {
  fail(`config/prompts.json を読めません: ${String(e)}`);
}
const promptsParsed = parsePromptsConfig(promptsRaw);
if (!promptsParsed.ok) fail(`config/prompts.json が不正です: ${promptsParsed.reason}`);
console.log(
  `✅ config/prompts.json OK（配合タイプ指示${Object.keys(promptsParsed.config.modeInstructions).length}件 / ルール${promptsParsed.config.sharedRules.length}件 / 画像スタイル${promptsParsed.config.imageStyleSuffix.length}字）`,
);

let data: unknown;
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  fail(`data/offspring.json を読めません: ${String(e)}`);
}

if (!Array.isArray(data)) fail('offspring.json は配列である必要があります');

const items = data as Offspring[];
const ids = new Set<string>();
const edges: [string, string][] = [];
let expectedNextId: string[] = [];

for (const item of items) {
  const at = (cond: boolean, msg: string) => {
    if (!cond) fail(`${item.id ?? '(ID不明)'}: ${msg}`);
  };

  at(typeof item.id === 'string' && /^mashup-\d{6}$/.test(item.id), 'id 形式が不正');
  at(!ids.has(item.id), 'id が重複しています');
  ids.add(item.id);

  at(item.schemaVersion === 1, 'schemaVersion が 1 ではありません');
  at(item.status === 'idea', 'status は idea である必要があります');
  at(item.parents?.length === 2, 'parents は2つ必要');
  at(item.parents[0] !== item.parents[1], '親が同一');
  at(typeof item.generation === 'number', 'generation がありません');
  at(/^protopedia:\d{1,9}$|^mashup-\d{1,9}$/.test(item.parents[0]), 'parent id 形式が不正');
  at(/^protopedia:\d{1,9}$|^mashup-\d{1,9}$/.test(item.parents[1]), 'parent id 形式が不正');
  at(Array.isArray(item.inheritedTraits) && item.inheritedTraits.length === 2, 'inheritedTraits は2件必要');
  at(/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(item.slot), 'slot 形式が不正（YYYY-MM-DDTHH）');
  at(typeof item.sourceIssue === 'number', 'sourceIssue がありません');
  // 配合タイプ3種（issue #16 / 追加開発指示 §4）
  at(isBreedingMode(item.mode), `mode が未対応の値です: ${String(item.mode)}`);
  // サムネイル（issue #16 / 追加開発指示 §8）: null=画像生成失敗（許容）、ありなら実ファイル必須
  if (item.imagePath !== undefined && item.imagePath !== null) {
    at(
      /^assets\/inventions\/mashup-\d{6}\.png$/.test(item.imagePath),
      `imagePath 形式が不正: ${String(item.imagePath)}`,
    );
    if (!existsSync(new URL(`../public/static/${item.imagePath}`, import.meta.url))) {
      fail(`${item.id}: imagePath の画像ファイルが存在しません: public/${item.imagePath}`);
    }
  }
  if (item.imagePrompt !== undefined) at(typeof item.imagePrompt === 'string', 'imagePrompt が文字列ではありません');
  if (item.useCases !== undefined) {
    at(
      Array.isArray(item.useCases) && item.useCases.every((u) => typeof u === 'string' && u.length > 0),
      'useCases は文字列の配列である必要があります',
    );
  }

  for (const p of item.parents) {
    if (p.startsWith('mashup-') && !ids.has(p)) {
      fail(`${item.id}: 未登録の子作品を親にしています: ${p}（並び順が世代順ではありませんか）`);
    }
    edges.push([p, item.id]);
  }
  expectedNextId.push(item.id);
}

// 世代計算の再検証
const genOf = new Map<string, number>();
for (const item of items) {
  const parentGens = item.parents.map((p) =>
    p.startsWith('protopedia:') ? 0 : genOf.get(p) ?? -1,
  );
  if (parentGens.some((g) => g < 0)) fail(`${item.id}: 親の世代が未解決`);
  const expected = computeGeneration(parentGens);
  if (expected !== item.generation) {
    fail(`${item.id}: generation が不正（${item.generation} ≠ 期待値 ${expected}）`);
  }
  genOf.set(item.id, item.generation);
}

// 循環参照・重複ペア
for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    if (samePair(items[i].parents, items[j].parents)) {
      fail(`同じ親の組み合わせが重複: ${items[i].id} / ${items[j].id}`);
    }
  }
}
for (const item of items) {
  const others = edges.filter(([, c]) => c !== item.id);
  if (isAncestorDescendantPair(item.parents[0], item.parents[1], others)) {
    fail(`${item.id}: 親の一方がもう一方の先祖です（近親交配）`);
  }
}

const next = nextOffspringId(expectedNextId);
console.log(`✅ ${items.length}件の子作品が検証OK（次のID: ${next}）`);

// --- data/prototypes.json（ProtoPedia同期データ） --------------------------
// 未同期（works: []）は正常状態。壊れた形だけを検出する。

/** 制作状態コード（供養/開発中/完成）の形チェック。未設定はOK（status未保存の旧データ対応）。 */
function checkStatus(prefix: string, w: { id?: unknown; status?: unknown }): void {
  if (w.status === undefined) return;
  if (typeof w.status !== 'number' || !Number.isInteger(w.status) || w.status < 1 || w.status > 99) {
    fail(`${prefix} ${String(w.id)}: status が不正（1..99の整数である必要があります）`);
  }
}

let worksetRaw: unknown;
try {
  worksetRaw = JSON.parse(readFileSync(WORKSET_FILE, 'utf8'));
} catch (e) {
  fail(`data/prototypes.json を読めません: ${String(e)}`);
}

if (typeof worksetRaw !== 'object' || worksetRaw === null) {
  fail('prototypes.json はオブジェクトである必要があります');
}
const workset = worksetRaw as Workset;
if (workset.schemaVersion !== 1) fail('prototypes.json: schemaVersion が 1 ではありません');
if (workset.source !== 'protopedia-api-v2' && workset.source !== 'mock') {
  fail('prototypes.json: source が不正');
}
if (workset.syncedAt !== null && typeof workset.syncedAt !== 'string') {
  fail('prototypes.json: syncedAt は文字列または null');
}
if (!Array.isArray(workset.works)) fail('prototypes.json: works が配列ではありません');

const workIds = new Set<string>();
for (const w of workset.works) {
  const wfail = (msg: string): never => fail(`prototypes.json ${w?.id ?? '(不明)'}: ${msg}`);
  if (typeof w?.id !== 'string' || !/^protopedia:\d{1,9}$/.test(w.id)) wfail('id 形式が不正');
  if (workIds.has(w.id)) wfail('id が重複しています');
  workIds.add(w.id);
  if (w.generation !== 0) wfail('generation は 0 である必要があります');
  if (typeof w.title !== 'string' || w.title.length === 0) wfail('title が空');
  if (typeof w.sourceUrl !== 'string' || !w.sourceUrl.startsWith('https://protopedia.net/')) {
    wfail(`sourceUrl が想定外: ${String(w.sourceUrl)}`);
  }
  if (w.sample) wfail('本番データに sample フラグは付かない');
  checkStatus('prototypes.json', w);
}
console.log(
  `✅ prototypes.json ${workset.works.length}件 OK（同期: ${workset.syncedAt ?? '未実施'}）`,
);

// --- data/sample-prototypes.json（試作取得データ・任意） --------------------
// 存在しなくてよい。壊れた形だけを検出する。候補プールの一部として数える。

const SAMPLE_FILE = new URL('../data/sample-prototypes.json', import.meta.url);
const poolIds = new Set(workIds); // prototypes.json ∪ sample-prototypes.json = 候補プール

if (existsSync(SAMPLE_FILE)) {
  let sampleRaw: unknown;
  try {
    sampleRaw = JSON.parse(readFileSync(SAMPLE_FILE, 'utf8'));
  } catch (e) {
    fail(`data/sample-prototypes.json を読めません: ${String(e)}`);
  }
  if (typeof sampleRaw !== 'object' || sampleRaw === null) {
    fail('sample-prototypes.json はオブジェクトである必要があります');
  }
  const sample = sampleRaw as Workset;
  if (sample.schemaVersion !== 1) fail('sample-prototypes.json: schemaVersion が 1 ではありません');
  if (!Array.isArray(sample.works)) fail('sample-prototypes.json: works が配列ではありません');

  for (const w of sample.works) {
    const wfail = (msg: string): never =>
      fail(`sample-prototypes.json ${w?.id ?? '(不明)'}: ${msg}`);
    if (typeof w?.id !== 'string' || !/^protopedia:\d{1,9}$/.test(w.id)) wfail('id 形式が不正');
    if (poolIds.has(w.id)) wfail('id がプールに重複しています');
    if (w.generation !== 0) wfail('generation は 0 である必要があります');
    if (typeof w.title !== 'string' || w.title.length === 0) wfail('title が空');
    if (typeof w.sourceUrl !== 'string' || !w.sourceUrl.startsWith('https://protopedia.net/')) {
      wfail(`sourceUrl が想定外: ${String(w.sourceUrl)}`);
    }
    if (w.sample) wfail('実API取得データに sample フラグは付かない');
    // 仕様§10: 利用条件が確認できない作品は保存しない方針（fetch時のフィールドと二重確認）
    if (typeof w.licenseType !== 'string' || w.licenseType.length === 0) {
      wfail('licenseType が無い（利用条件を確認できない作品）');
    }
    checkStatus('sample-prototypes.json', w);
    poolIds.add(w.id);
  }
  console.log(`✅ sample-prototypes.json ${sample.works.length}件 OK`);
} else {
  console.log('ℹ️ sample-prototypes.json は無し（npm run fetch:sample で取得できます）');
}

// --- data/current-candidates.json（15分ごとの配合候補） --------------------------

const CAND_FILE = new URL('../data/current-candidates.json', import.meta.url);
let candRaw: unknown;
try {
  candRaw = JSON.parse(readFileSync(CAND_FILE, 'utf8'));
} catch {
  fail('data/current-candidates.json がありません（npm run rotate:candidates を実行してください）');
}
// 読み取りガードの上限は max(設定値, 既定6)（設定を引き下げた直後の既存ファイルを壊さない / issue #15）
const candFileMax = Math.max(scheduleCfg.maxCandidates, CANDIDATES_PER_SLOT);
if (!isCandidatesFile(candRaw, candFileMax)) {
  fail('current-candidates.json の形式が不正です（npm run rotate:candidates で作り直してください）');
}
const cand = candRaw;

// slot/nextSlotの整合。比較は config の値に依存しない（設定変更の直後に
// 設定変更前の生成結果を壊さないため、「次枠が1分後〜1週間後」であることだけを見る / issue #15）
const slotToMs = (s: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})$/.exec(s);
  if (!m) return Number.NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
};
const slotGapMinutes = (slotToMs(cand.nextSlot) - slotToMs(cand.slot)) / 60_000;
if (!(slotGapMinutes >= 1 && slotGapMinutes <= 10080)) {
  fail(`current-candidates.json: nextSlot（${cand.nextSlot}）が slot（${cand.slot}）の次枠として不正です`);
}
if (Number.isNaN(Date.parse(cand.generatedAt))) {
  fail('current-candidates.json: generatedAt が日時として読めません');
}
// sourceは実行環境の絶対パスを持ち込まない（再現性の担保）
if (cand.source.startsWith('/') || cand.source.includes('..')) {
  fail(`current-candidates.json: source がリポジトリ相対ではありません: ${cand.source}`);
}
const statusByLabel = new Map<string, number>();
for (const c of cand.candidates) {
  if (c.sample) fail(`current-candidates.json: 候補 ${c.id} に sample フラグが付いています`);
  if (!poolIds.has(c.id)) {
    fail(
      `current-candidates.json: 候補 ${c.id} が保存済み作品プールに存在しません（npm run rotate:candidates で候補を更新してください）`,
    );
  }
  checkStatus('current-candidates.json', c);
  const lb = statusLabel(c.status);
  if (lb) statusByLabel.set(lb, (statusByLabel.get(lb) ?? 0) + 1);
}
const statusSummary =
  [...statusByLabel.entries()].map(([lb, n]) => `${lb}${n}`).join(' / ') || '状態バッジなし';
console.log(
  `✅ current-candidates.json slot=${cand.slot} 候補${cand.candidates.length}件 OK（次回: ${cand.nextSlot} / source: ${cand.source} / 制作状態: ${statusSummary}）`,
);

// --- data/breeding-state.json（配合ワーカーの実行状態 / issue #15） ----------
// 「前回の配合成功日時」を永続化し、間隔内のAI重複実行を防ぐ状態ファイル。
// 候補更新の状態（current-candidates.json の slot）とは別物。
const STATE_FILE = new URL('../data/breeding-state.json', import.meta.url);
if (existsSync(STATE_FILE)) {
  let stateRaw: unknown;
  try {
    stateRaw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    fail(`data/breeding-state.json を読めません: ${String(e)}`);
  }
  if (!isBreedingState(stateRaw)) fail('data/breeding-state.json の形式が不正です');
  console.log(
    `✅ breeding-state.json OK（前回成功: ${stateRaw.lastSuccessAt ?? 'なし'} / 連続失敗: ${stateRaw.consecutiveFailures} 回）`,
  );
} else {
  console.log('ℹ️ breeding-state.json は無し（配合ワーカー初回実行時に作成されます）');
}

// --- data/offspring.sample.json（開発用サンプル・任意） -----------------------
// 存在しなくてよい。壊れた形だけを検出する（imagePath は実ファイル必須）。

const SAMPLE_OFFSPRING_FILE = new URL('../data/offspring.sample.json', import.meta.url);
if (existsSync(SAMPLE_OFFSPRING_FILE)) {
  let sraw: unknown;
  try {
    sraw = JSON.parse(readFileSync(SAMPLE_OFFSPRING_FILE, 'utf8'));
  } catch (e) {
    fail(`data/offspring.sample.json を読めません: ${String(e)}`);
  }
  if (!Array.isArray(sraw)) fail('offspring.sample.json は配列である必要があります');
  const sampleIds = new Set<string>();
  for (const s of sraw as Offspring[]) {
    const sfail = (msg: string): never => fail(`offspring.sample.json ${s?.id ?? '(不明)'}: ${msg}`);
    if (typeof s?.id !== 'string' || !/^mashup-\d{6}$/.test(s.id)) sfail('id 形式が不正');
    if (sampleIds.has(s.id)) sfail('id が重複しています');
    sampleIds.add(s.id);
    if (!isBreedingMode(s.mode)) sfail(`mode が未対応の値です: ${String(s.mode)}`);
    if (s.imagePath !== undefined && s.imagePath !== null) {
      if (!/^assets\/inventions\/mashup-\d{6}\.png$/.test(s.imagePath)) sfail('imagePath 形式が不正');
      if (!existsSync(new URL(`../public/static/${s.imagePath}`, import.meta.url))) {
        sfail(`imagePath の画像ファイルが存在しません: public/static/${s.imagePath}`);
      }
    }
  }
  console.log(`✅ offspring.sample.json ${sampleIds.size}件 OK（開発用サンプル）`);
}

// --- data/element-cache.json（要素抽出キャッシュ / issue #16） ----------------
// 壊れたエントリはワーカー側でも読み飛ばされるが、ここでは「壊れていること」自体を検出する。

const CACHE_FILE = new URL('../data/element-cache.json', import.meta.url);
if (existsSync(CACHE_FILE)) {
  let craw: unknown;
  try {
    craw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    fail(`data/element-cache.json を読めません: ${String(e)}`);
  }
  if (typeof craw !== 'object' || craw === null) fail('element-cache.json はオブジェクトである必要があります');
  const cache = craw as { schemaVersion?: unknown; entries?: unknown };
  if (cache.schemaVersion !== 1) fail('element-cache.json: schemaVersion が 1 ではありません');
  if (typeof cache.entries !== 'object' || cache.entries === null || Array.isArray(cache.entries)) {
    fail('element-cache.json: entries がオブジェクトではありません');
  }
  for (const [key, value] of Object.entries(cache.entries as Record<string, unknown>)) {
    const cfail = (msg: string): never => fail(`element-cache.json ${key}: ${msg}`);
    if (typeof value !== 'object' || value === null) cfail('エントリがオブジェクトではありません');
    const e = value as Record<string, unknown>;
    if (e.id !== key) cfail('key と id が一致しません');
    if (typeof e.id !== 'string' || !/^(protopedia:\d{1,9}|mashup-\d{1,9})$/.test(e.id)) {
      cfail('id 形式が不正');
    }
    if (typeof e.version !== 'string' || e.version.length === 0) cfail('version がありません');
    if (!isWorkElements(e.elements)) cfail('elements が8項目揃っていません');
    for (const k of ELEMENT_KEYS) {
      const field = (e.elements as Record<string, unknown>)[k];
      if (typeof field !== 'string' || field.length > 400) cfail(`elements.${k} が長すぎ/不正`);
    }
  }
  console.log(`✅ element-cache.json ${Object.keys(cache.entries as object).length}件 OK`);
} else {
  console.log('ℹ️ element-cache.json は無し（配合ワーカー初回実行時に作成されます）');
}

// --- data/processed-issues.json（処理済みIssue / issue #16） -------------------
// 壊れていると二重処理になるため、ここでも形を検証する。

const PROCESSED_FILE = new URL('../data/processed-issues.json', import.meta.url);
if (existsSync(PROCESSED_FILE)) {
  let praw: unknown;
  try {
    praw = JSON.parse(readFileSync(PROCESSED_FILE, 'utf8'));
  } catch (e) {
    fail(`data/processed-issues.json を読めません: ${String(e)}`);
  }
  if (!isProcessedIssues(praw)) fail('processed-issues.json の形式が不正です（二重処理の防止に使えません）');
  console.log(`✅ processed-issues.json ${Object.keys(praw).length}件 OK`);
} else {
  console.log('ℹ️ processed-issues.json は無し（配合ワーカー初回実行時に作成されます）');
}

// --- data/ai-usage.json（利用量記録 / issue #16 §10） --------------------------
// 壊れていると利用量を推定できないため検証する（試算値であっても記録自体は壊さない）。

const USAGE_FILE = new URL('../data/ai-usage.json', import.meta.url);
if (existsSync(USAGE_FILE)) {
  let uraw: unknown;
  try {
    uraw = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
  } catch (e) {
    fail(`data/ai-usage.json を読めません: ${String(e)}`);
  }
  if (typeof uraw !== 'object' || uraw === null) fail('ai-usage.json はオブジェクトである必要があります');
  const usage = uraw as { schemaVersion?: unknown; days?: unknown };
  if (usage.schemaVersion !== 1) fail('ai-usage.json: schemaVersion が 1 ではありません');
  if (typeof usage.days !== 'object' || usage.days === null || Array.isArray(usage.days)) {
    fail('ai-usage.json: days がオブジェクトではありません');
  }
  for (const [day, value] of Object.entries(usage.days as Record<string, unknown>)) {
    const ufail = (msg: string): never => fail(`ai-usage.json ${day}: ${msg}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) ufail('日付キーが不正');
    if (typeof value !== 'object' || value === null) ufail('エントリがオブジェクトではありません');
    for (const k of ['textCalls', 'imageCalls', 'inputTokens', 'outputTokens', 'estimatedNeurons']) {
      const n = (value as Record<string, unknown>)[k];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) ufail(`${k} が非負整数ではありません`);
    }
  }
  console.log(`✅ ai-usage.json ${Object.keys(usage.days as object).length}日分 OK（Neuronsは試算値）`);
} else {
  console.log('ℹ️ ai-usage.json は無し（配合ワーカー初回実行時に作成されます）');
}
