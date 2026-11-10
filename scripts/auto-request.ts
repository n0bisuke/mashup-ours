/**
 * 自動配合申請。（issue #27）
 *
 * 直近 autoRequestIdleHours（config/schedule.json・既定8時間）に配合申請がなければ、
 * 現行の配合候補とすでに生まれた子作品から**ランダム（生成AIなし）**に親2件を選び、
 * 人手の申請と同じ形式の Issue を1件作る。作成した Issue は既存のキュー
 * （.github/workflows/breed.yml）が通常どおり処理する。データのコミットはしない。
 *
 * - 作成した Issue 自体が次の判定で「直近の申請」になるため、最大でも待機時間に1件。
 * - 選出は lib/auto-request.ts の乱数のみ。この経路にAI呼び出しは存在しない。
 * - DRY_RUN=true のときは判定と選出だけを行い、Issue は作らない。
 *
 * 使い方:
 *   node --experimental-strip-types scripts/auto-request.ts
 *   DRY_RUN=true node --experimental-strip-types scripts/auto-request.ts
 *
 * 必要な env: GITHUB_TOKEN（github.token）・GITHUB_REPOSITORY（Actionsが自動設定）。
 * 追加のSecretsは不要。データ・設定ファイルだけを読む標準ライブラリ実装。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decorateAutoIssueBody,
  selectAutoPair,
  shouldCreateAutoRequest,
} from '../lib/auto-request.ts';
import { buildIssueForm, repoConfigFromEnv, type IssueLinkOptions } from '../lib/config.ts';
import {
  GitHubApiError,
  addIssueLabels,
  createIssue,
  listOpenIssues,
  listRecentIssues,
} from '../lib/github.ts';
import { isProcessedIssues, type IssueRecord, type ProcessedIssues } from '../lib/queue.ts';
import { DEFAULT_AUTO_REQUEST_IDLE_HOURS, parseScheduleConfig } from '../lib/schedule.ts';
import type { Offspring, ProtopediaWork } from '../lib/types.ts';

/** GITHUB_TOKEN が作った Issue は label-issues.yml を起動しないため、ここで付ける。 */
const BREED_LABEL = 'breeding-request';

const PATHS = {
  schedule: fileURLToPath(new URL('../config/schedule.json', import.meta.url)),
  candidates: fileURLToPath(new URL('../data/current-candidates.json', import.meta.url)),
  offspring: fileURLToPath(new URL('../data/offspring.json', import.meta.url)),
  processed: fileURLToPath(new URL('../data/processed-issues.json', import.meta.url)),
};

function log(msg: string): void {
  console.log(msg);
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** config/schedule.json（不正なら exit 1 = 何も作らない）。 */
function loadIdleHours(): number {
  let raw: unknown;
  try {
    raw = readJson(PATHS.schedule);
  } catch (e) {
    fail(`config/schedule.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseScheduleConfig(raw);
  if (!parsed.ok) fail(`config/schedule.json が不正なため処理を停止します: ${parsed.reason}`);
  return parsed.config.autoRequestIdleHours ?? DEFAULT_AUTO_REQUEST_IDLE_HOURS;
}

/** data/processed-issues.json（壊れていると判定を誤る → 停止）。 */
function loadProcessed(): ProcessedIssues {
  let raw: unknown;
  try {
    raw = readJson(PATHS.processed);
  } catch (e) {
    fail(`data/processed-issues.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isProcessedIssues(raw)) fail('data/processed-issues.json の形式が不正です');
  return raw;
}

/** data/offspring.json（壊れていると親候補・系譜を誤る → 停止）。 */
function loadOffspring(): Offspring[] {
  let raw: unknown;
  try {
    raw = readJson(PATHS.offspring);
  } catch (e) {
    fail(`data/offspring.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) fail('data/offspring.json が配列ではありません');
  return raw as Offspring[];
}

/**
 * data/current-candidates.json（無くても動く: 子作品だけで選ぶ）。
 * ロックされても配合申請だけは止めないため、ここでは exit しない。
 */
function loadCandidates(): { ids: string[]; sourceUrl: Map<string, string>; slot?: string } {
  const ids: string[] = [];
  const sourceUrl = new Map<string, string>();
  if (!existsSync(PATHS.candidates)) {
    log('⚠️ data/current-candidates.json が無いため、子作品のみから選びます');
    return { ids, sourceUrl };
  }
  try {
    const raw = readJson(PATHS.candidates) as { slot?: unknown; candidates?: unknown };
    if (typeof raw.slot === 'string') {
      const { ids: i, sourceUrl: u } = collectWorks(Array.isArray(raw.candidates) ? raw.candidates : []);
      ids.push(...i);
      for (const [k, v] of u) sourceUrl.set(k, v);
      return { ids, sourceUrl, slot: raw.slot };
    }
    log('⚠️ current-candidates.json の形が想定外のため候補を無視して続行します');
  } catch (e) {
    log(`⚠️ current-candidates.json を読めなかったため続行します: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ids, sourceUrl };
}

function collectWorks(rows: unknown[]): { ids: string[]; sourceUrl: Map<string, string> } {
  const ids: string[] = [];
  const sourceUrl = new Map<string, string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const w = row as Partial<ProtopediaWork>;
    if (typeof w.id !== 'string' || typeof w.title !== 'string') continue;
    ids.push(w.id);
    if (typeof w.sourceUrl === 'string') sourceUrl.set(w.id, w.sourceUrl);
  }
  return { ids, sourceUrl };
}

async function main(): Promise<void> {
  const idleHours = loadIdleHours();
  if (idleHours <= 0) {
    log('ℹ️ 自動申請は無効です（autoRequestIdleHours: 0）。何もしません。');
    return;
  }

  const repoCfg = repoConfigFromEnv(process.env);
  if (!repoCfg) fail('GITHUB_REPOSITORY が未設定のため処理を停止します');
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) fail('GITHUB_TOKEN が未設定のため処理を停止します');
  const dryRun = process.env.DRY_RUN === 'true';
  const gh = { token, repo: `${repoCfg.owner}/${repoCfg.repo}` };

  const processed = loadProcessed();
  const offspring = loadOffspring();
  const candidates = loadCandidates();

  // 1) 判定: 直近の申請（state=all）と未処理の open 申請（state=open）。
  let recent: IssueRecord[];
  let open: IssueRecord[];
  try {
    [recent, open] = await Promise.all([listRecentIssues(gh), listOpenIssues(gh)]);
  } catch (e) {
    // 一時障害では「申請が無い」と誤判定しない（次回の起床でやり直す）
    fail(`GitHub API の呼び出しに失敗したため判定しません: ${e instanceof GitHubApiError ? e.message : String(e)}`);
  }

  const decision = shouldCreateAutoRequest({ recent, open, processed, idleHours });
  if (!decision.create) {
    log(`⏭️ 作成しません: ${decision.reason}`);
    return;
  }

  // 2) ランダム選出（生成AIなし）: 現行の配合候補 + すでに生まれた子作品。
  const pairs: Array<readonly [string, string]> = [];
  const edges: Array<readonly [string, string]> = [];
  const offspringIds: string[] = [];
  for (const o of offspring) {
    if (!o || typeof o.id !== 'string' || !Array.isArray(o.parents) || o.parents.length !== 2) continue;
    offspringIds.push(o.id);
    const pair: [string, string] = [o.parents[0], o.parents[1]];
    pairs.push(pair);
    edges.push(pair);
  }
  const pool = [...candidates.ids, ...offspringIds];
  const pair = selectAutoPair({ pool, offspringPairs: pairs, edges });
  if (!pair) {
    log(`⚠️ 親候補 ${pool.length}件 から有効な組み合わせを見つけられませんでした（作成しません）`);
    return;
  }

  // 3) 人手の申請と同じフォーマットで組み立てる（mode は初期仕様どおり fusion 固定）。
  const opts: IssueLinkOptions = { mode: 'fusion' };
  if (candidates.slot) opts.slot = candidates.slot;
  const urlA = candidates.sourceUrl.get(pair[0]);
  const urlB = candidates.sourceUrl.get(pair[1]);
  if (urlA) opts.parentAUrl = urlA;
  if (urlB) opts.parentBUrl = urlB;
  const form = decorateAutoIssueBody(buildIssueForm(pair[0], pair[1], opts), idleHours);

  log(`ℹ️ ${decision.reason}`);
  log(`ℹ️ ランダム選出（AIなし）: ${pair[0]} x ${pair[1]} / プール${pool.length}件`);

  if (dryRun) {
    log('🧪 DRY-RUN: Issue は作成しません');
    log(`   title: ${form.title}`);
    log(`   body:\n${form.body.split('\n').map((l) => `     ${l}`).join('\n')}`);
    return;
  }

  // 4) 作成 → ラベルはベストエフォート（失敗しても申請は成立している）。
  const number = await createIssue(form, gh);
  log(`✅ 配合申請 #${number} を作成しました: https://github.com/${gh.repo}/issues/${number}`);
  try {
    await addIssueLabels(number, [BREED_LABEL], gh);
    log(`🏷️ ラベル ${BREED_LABEL} を付与しました`);
  } catch (e) {
    log(`⚠️ ラベル付与に失敗（申請自体は成立）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

main().catch((e: unknown) => {
  fail(`予期しない失敗: ${e instanceof Error ? e.message : String(e)}`);
});
