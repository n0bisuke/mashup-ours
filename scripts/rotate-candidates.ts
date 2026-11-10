/**
 * 配合候補の更新。（追加開発指示 §7 / issue #10、間隔の設定化 issue #15）
 *
 * 保存済みの作品データから、スロット（UTC "YYYY-MM-DDTHHMM"）に決定的に
 * maxCandidates 件を選ぶ。
 * - 同じスロットなら常に同じ候補（Actionsの再実行・ローカル実行でも同じ結果）
 * - data/current-candidates.json に slot / generatedAt / nextSlot / 候補を記録
 * - プール0件・不正データ時は exit 1。既存の current-candidates.json は無変更。
 *
 * 実行可否（issue #15 §3/§4）:
 * - cron は一定間隔で「起床」するだけ。間隔（candidateRotationMinutes）の判定は
 *   ここが行う: 現在時刻から算出した currentSlot と既存ファイルの slot が一致すれば
 *   まだ間隔が空いていない → 何もしない（AIは呼ばない・書き込まない）。
 * - これにより「間隔ごとに必ず生成」ではなく「間隔を空けて最大1件」になり、
 *   Actionsの遅延・手動実行（workflow_dispatch）でも二重生成しない。
 * - --force はローカル開発用の明示的な制限解除（ワークフローからは渡さない）。
 * - config/schedule.json が不正なら exit 1（= 処理を停止してエラーを通知）。
 *
 * 使い方:
 *   node --experimental-strip-types scripts/rotate-candidates.ts
 *   node --experimental-strip-types scripts/rotate-candidates.ts --slot=2026-11-09T1415
 *   node --experimental-strip-types scripts/rotate-candidates.ts --dry-run
 *   node --experimental-strip-types scripts/rotate-candidates.ts --force
 *
 * ProtoPedia APIは呼ばない（トークン不要）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCandidatesFile, candidateSlotKey, nextSlotKey } from '../lib/candidates.ts';
import { readDeletedOffspringIds } from '../lib/deleted-offspring.ts';
import {
  intervalLabel,
  parseScheduleConfig,
  type ScheduleConfig,
} from '../lib/schedule.ts';
import type { Offspring, ProtopediaWork } from '../lib/types.ts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_PATH = fileURLToPath(new URL('../data/current-candidates.json', import.meta.url));
const SCHEDULE_PATH = fileURLToPath(new URL('../config/schedule.json', import.meta.url));
/** 候補元に使う保存済みデータ（優先順）。試作段階では sample-prototypes が実績を持つ。 */
const POOL_FILES = [
  fileURLToPath(new URL('../data/prototypes.json', import.meta.url)),
  fileURLToPath(new URL('../data/sample-prototypes.json', import.meta.url)),
];
/** AI生成アイデアの候補元（issue #36）。読み込み失敗・不正は「候補なし」として扱う。 */
const OFFSPRING_FILE = fileURLToPath(new URL('../data/offspring.json', import.meta.url));

/**
 * 候補にできるAI生成アイデアのID。
 * - 削除済み（data/deleted-offspring.json の台帳）は除外 = 削除済み発明が候補に復活しない
 * - 開発用サンプル（sample）は除外（本番の候補と混同させない）
 * - `status: 'idea'` 以外（公開していない状態）は除外
 * - 読めない・形が不正なら空（= ProtoPedia候補で埋まる）にして続行する
 */
function readEligibleOffspringIds(): string[] {
  if (!existsSync(OFFSPRING_FILE)) return [];
  let retired: string[] = [];
  try {
    retired = readDeletedOffspringIds();
  } catch {
    console.error('⚠️ data/deleted-offspring.json を読めないため、削除済みIDの除外ができません（候補のAI生成アイデアを0件にします）');
    return [];
  }
  const retiredSet = new Set(retired);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(OFFSPRING_FILE, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const item of raw as Partial<Offspring>[]) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.id !== 'string' || !/^mashup-\d{1,9}$/.test(item.id)) continue;
    if (retiredSet.has(item.id)) continue; // 削除済みは再登場させない（issue #32 / #36）
    if (item.sample === true) continue; // 開発用サンプルは本番候補に混ぜない
    if (item.status !== 'idea') continue; // 未公開・失敗などは候補にしない
    ids.push(item.id);
  }
  return ids;
}

/**
 * config/schedule.json を読み込み検証する。
 * 不正なら exit 1（設定が不正な場合は処理を停止してエラーを通知する / issue #15）。
 */
function loadSchedule(): ScheduleConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
  } catch (e) {
    console.error(
      `❌ config/schedule.json を読めないため処理を停止します: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
  const parsed = parseScheduleConfig(raw);
  if (!parsed.ok) {
    console.error(`❌ config/schedule.json が不正なため処理を停止します: ${parsed.reason}`);
    process.exit(1);
  }
  return parsed.config;
}

/** JSONには実行環境の絶対パスを書かない（リポジトリ相対で記録する）。 */
function repoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).replaceAll('\\', '/');
}

function readPool(path: string): ProtopediaWork[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { works?: unknown };
    if (!Array.isArray(raw.works)) return [];
    return raw.works.filter(
      (w): w is ProtopediaWork =>
        !!w &&
        typeof w === 'object' &&
        typeof (w as ProtopediaWork).id === 'string' &&
        /^protopedia:\d{1,9}$/.test((w as ProtopediaWork).id) &&
        typeof (w as ProtopediaWork).title === 'string' &&
        (w as ProtopediaWork).title.length > 0,
    );
  } catch {
    return []; // 壊れたファイルは無視して次のソースへ（表示データは検証済みのものだけ）
  }
}

function main(): void {
  const cfg = loadSchedule();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const slotArg = args.find((a) => a.startsWith('--slot='));
  const slot = slotArg
    ? slotArg.slice('--slot='.length)
    : candidateSlotKey(new Date(), cfg.candidateRotationMinutes);
  // 形式検証（不正なら例外で落とす = 書き込まない）
  nextSlotKey(slot, cfg.candidateRotationMinutes);

  // --- 実行可否（間隔制限 / issue #15 §3・§4） -------------------------------
  // 前回の生成（既存ファイルの slot）と、設定間隔から算出した現在の slot が
  // 一致すればまだ間隔が空いていない。dispatch の明示 slot 指定も同じ比較で通す
  // （同一枠への再生成 = 二重処理はしない）。dry-run は書き込まないため判定のみ表示。
  if (!force && existsSync(OUT_PATH)) {
    let prevSlot: unknown;
    try {
      prevSlot = (JSON.parse(readFileSync(OUT_PATH, 'utf8')) as { slot?: unknown }).slot;
    } catch {
      prevSlot = undefined; // 壊れた既存ファイルは再生成する
    }
    if (prevSlot === slot) {
      console.log(
        `⏭ スキップ: slot=${slot} は生成済みです（候補の更新間隔は ${intervalLabel(cfg.candidateRotationMinutes)}。間隔を空けてから実行されます）`,
      );
      return;
    }
  }

  // プール選択: maxCandidates 以上確保できるファイルを優先し、なければ件数の多いファイルへ。
  // （全件同期を有効にすれば prototypes.json が自動的に優先される。試作段階では sample-prototypes）
  let pool: ProtopediaWork[] = [];
  let source = '';
  for (const file of POOL_FILES) {
    const works = readPool(file);
    if (works.length >= cfg.maxCandidates) {
      pool = works;
      source = file;
      break;
    }
    if (works.length > pool.length) {
      pool = works;
      source = file;
    }
  }
  if (pool.length === 0) {
    console.error(
      '❌ 候補元の作品データがありません（data/sample-prototypes.json を先に作成してください: npm run fetch:sample）',
    );
    process.exit(1);
  }

  // AI生成アイデアの候補（issue #36）。0件なら ProtoPedia 候補だけで埋まる。
  const offspringIds = readEligibleOffspringIds();

  // buildCandidatesFile はプール0件で例外（= ここに来るのは1件以上）。
  const file = buildCandidatesFile(pool, slot, repoRelative(source), new Date(), {
    slotMinutes: cfg.candidateRotationMinutes,
    maxCandidates: cfg.maxCandidates,
    offspringIds,
  });

  console.log(
    `✅ slot=${file.slot} 候補${file.candidates.length + (file.offspringCandidates?.length ?? 0)}件` +
      `（ProtoPedia ${file.candidates.length}件 + AI生成 ${file.offspringCandidates?.length ?? 0}件 / プール${pool.length}件 / source=${source}）`,
  );
  for (const c of file.candidates) {
    const by = c.authors && c.authors.length > 0 ? ` / ${c.authors[0]}` : '';
    console.log(`   - ${c.id} ${c.title}${by}`);
  }
  for (const id of file.offspringCandidates ?? []) {
    console.log(`   - ${id}（AI生成アイデア・候補元 ${offspringIds.length}件から選出）`);
  }
  console.log(
    `   次回更新予定: ${file.nextSlot}（UTCの${cfg.candidateRotationMinutes}分間隔の境界で切り替わり）`,
  );

  if (dryRun) {
    console.log('🏁 dry-run: data/current-candidates.json は変更していません。');
    return;
  }

  // 原子保存: 一時ファイルに書いてからリネーム（書き込み途中の断片で壊れない）。
  const tmp = `${OUT_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  renameSync(tmp, OUT_PATH);
  console.log(`💾 data/current-candidates.json を更新しました（生成: ${file.generatedAt}）`);
}

main();
