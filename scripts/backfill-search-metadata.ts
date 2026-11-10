/**
 * 既存データへの検索メタデータ補完（issue #38 §5）。
 *
 * **発明名・概要・仕組み・利用シーン・画像・親子関係は一切変更しない**。
 * 追加するのは technologies / domains のみ（keywords は信頼できるルールが無いため触らない）。
 *
 * - ルールベース（**APIキー不要・無料**）: lib/search.ts の suggestTechnologies /
 *   suggestDomains。技術名が本文に明示されているときだけ、分野の語が明確に現れたときだけ付与
 *   （「Difyを使わない発明にDifyタグを付けない」）。
 * - **既定はドライラン**: 差分を表示するだけで書き込まない。書き込むには明示的に --write。
 * - すでに technologies / domains を持つ作品（新規生成分）は上書きしない。
 * - AI（--ai）での補完は**実装していない**: 有料APIを呼び出すため、明示的な指示が要る。
 *
 * 使い方:
 *   node --experimental-strip-types scripts/backfill-search-metadata.ts           # ドライラン
 *   node --experimental-strip-types scripts/backfill-search-metadata.ts --write   # 書き込み
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseSearchTaxonomy,
  suggestDomains,
  suggestTechnologies,
} from '../lib/search.ts';
import type { Offspring } from '../lib/types.ts';

const TAXONOMY_PATH = fileURLToPath(new URL('../config/search-taxonomy.json', import.meta.url));
const OFFSPRING_PATH = fileURLToPath(new URL('../data/offspring.json', import.meta.url));

/** 検索メタデータの上限（lib/blend.ts の生成時と同じ基準）。 */
const MAX_TAGS = 6;

const writeMode = process.argv.slice(2).includes('--write');

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --- taxonomy（不正なら何もしない） ------------------------------------------
let rawTaxonomy: unknown;
try {
  rawTaxonomy = readJson(TAXONOMY_PATH);
} catch (e) {
  fail(`config/search-taxonomy.json を読めません: ${e instanceof Error ? e.message : String(e)}`);
}
const parsedTaxonomy = parseSearchTaxonomy(rawTaxonomy);
if (!parsedTaxonomy.ok) fail(`config/search-taxonomy.json が不正です: ${parsedTaxonomy.reason}`);
const taxonomy = parsedTaxonomy.config;

// --- offspring ----------------------------------------------------------------
let rawOffspring: unknown;
try {
  rawOffspring = readJson(OFFSPRING_PATH);
} catch (e) {
  fail(`data/offspring.json を読めません: ${e instanceof Error ? e.message : String(e)}`);
}
if (!Array.isArray(rawOffspring)) fail('data/offspring.json が配列ではありません');
const offspring = rawOffspring as Offspring[];

/** 検索対象のテキスト（発明名・概要・仕組み・利用シーン）。ここからだけ判定する。 */
function searchTextOf(c: Offspring): string {
  return [c.title, c.summary, c.concept, c.mechanism, ...(c.useCases ?? [])]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' ');
}

interface Change {
  id: string;
  fields: { name: string; before: string[]; after: string[] }[];
}

const changes: Change[] = [];
const unchanged: string[] = [];
let alreadyHad = 0;

for (const c of offspring) {
  const text = searchTextOf(c);
  const change: Change = { id: c.id, fields: [] };

  // technologies: 未付与のときだけルール補完（AIが出した値は上書きしない）
  if (c.technologies === undefined) {
    const after = suggestTechnologies(text, taxonomy).slice(0, MAX_TAGS);
    if (after.length > 0) change.fields.push({ name: 'technologies', before: [], after });
  } else {
    alreadyHad += 1;
  }
  // domains: 同上
  if (c.domains === undefined) {
    const after = suggestDomains(text, taxonomy);
    if (after.length > 0) change.fields.push({ name: 'domains', before: [], after });
  }
  // keywords: 信頼できる決定的なルールが無いため補完しない（推測で付けない）。

  if (change.fields.length > 0) changes.push(change);
  else unchanged.push(c.id);
}

// --- 出力 ---------------------------------------------------------------------
console.log(`ℹ️ 対象: data/offspring.json の ${offspring.length} 件 / 分類: 分野${taxonomy.domains.length}件・技術${taxonomy.technologies.length}件`);
if (alreadyHad > 0) {
  console.log(`   すでにメタデータを持つ作品: ${alreadyHad} 件（上書きしません）`);
}
if (changes.length === 0) {
  console.log('✅ 補完できる項目はありません（変更なし）。');
  process.exit(0);
}
for (const ch of changes) {
  for (const f of ch.fields) {
    console.log(`   ${ch.id}: ${f.name} ← ${f.after.join(' / ')}`);
  }
}
console.log(`合計 ${changes.length} 件を補完候補にしました（未変更 ${unchanged.length} 件）。`);

if (!writeMode) {
  console.log('🔎 ドライランです。書き込むには --write を付けてください。');
  process.exit(0);
}

// --- 書き込み（原子的: tmp → rename。発明名・説明・画像・親子関係は無変更） -------
const changeMap = new Map(changes.map((ch) => [ch.id, ch]));
const updated = offspring.map((c) => {
  const ch = changeMap.get(c.id);
  if (!ch) return c;
  const next: Offspring = { ...c };
  for (const f of ch.fields) {
    if (f.name === 'technologies') next.technologies = f.after;
    if (f.name === 'domains') next.domains = f.after;
  }
  return next;
});
const tmp = `${OFFSPRING_PATH}.tmp`;
writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
renameSync(tmp, OFFSPRING_PATH);
console.log(`💾 data/offspring.json に ${changes.length} 件のメタデータを追記しました。`);
console.log(`   （keywords は補完していません / 上限: 技術・分野 各${MAX_TAGS}件）`);
