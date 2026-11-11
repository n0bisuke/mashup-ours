/**
 * scripts/sync-data.mjs — data/*.json を origin/main 側と union する（issue #52）。
 *
 * 背景: data/*.json は GitHub Actions がほぼ毎時コミットするため、ローカルで
 * 同じファイルを編集して gitpush（pull --rebase）するとコンフリクトになる。
 * gitpush は **add/commit の前に** 本スクリプトを呼ぶので、コミット diff は
 * ローカル側の意図した変更だけで済む → rebase がデータで衝突しない。
 *
 * 前提: 先に `git fetch origin` する（gitpush から呼ぶ。単体で使うときは手動で）。
 *
 * 使い方:
 *   node scripts/sync-data.mjs          # dry-run: 適用される変更を表示のみ
 *   node scripts/sync-data.mjs --apply  # data/ に書き込む
 *
 * 戦略（触らないファイルは明示的に skip）:
 *   offspring.json            id で union（削除台帳IDは再追加しない / 同一ID内容違いはローカル優先+警告）
 *   deleted-offspring.json    deletedIds と notes を union
 *   processed-issues.json     Issue番号で union（同一は attempts 最大・at 新）
 *   ai-usage.json             日次カウンタは最大値を union（二重加算を防ぐ）
 *   breeding-state.json       同上（lastSlot 等の文字列は新しい方を採用）
 *   current-candidates.json   毎時再生成なので remote-wins
 *   element-cache.json / その他 skip（コンフリ時は個別対応）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = resolve(ROOT, 'data');
const APPLY = process.argv.includes('--apply');

/** 削除台帳のID。union 済み（呼び出し前に算出するため外部から渡す）。 */
export function unionOffspring(local, remote, deletedIds) {
  if (!Array.isArray(local) || !Array.isArray(remote)) throw new Error('offspring.json は配列');
  const localIds = new Set(local.map((o) => o?.id));
  const added = [];
  for (const o of remote) {
    if (!o || typeof o.id !== 'string') continue;
    if (deletedIds.has(o.id)) continue; // 削除済み = 両側で再追加しない
    if (localIds.has(o.id)) continue;
    added.push(o);
  }
  const result = [...local, ...added];
  return { result, addedIds: added.map((o) => o.id) };
}

export function unionLedger(local, remote) {
  const a = local ?? { schemaVersion: 1, deletedIds: [], notes: [] };
  const b = remote ?? { deletedIds: [], notes: [] };
  const deletedIds = [...new Set([...(a.deletedIds ?? []), ...(b.deletedIds ?? [])])];
  const notes = [...new Set([...(a.notes ?? []), ...(b.notes ?? [])])];
  return { schemaVersion: 1, deletedIds, notes };
}

export function unionProcessed(local, remote) {
  const out = { ...local };
  let merged = 0;
  for (const [k, v] of Object.entries(remote ?? {})) {
    const cur = out[k];
    if (!cur || typeof cur !== 'object') {
      out[k] = v;
      merged++;
      continue;
    }
    if ((v.attempts ?? 0) > (cur.attempts ?? 0) || String(v.at ?? '') > String(cur.at ?? '')) {
      out[k] = { ...cur, ...v };
      merged++;
    }
  }
  return { result: out, merged };
}

const COUNTER_KEYS = ['textCalls', 'imageCalls', 'inputTokens', 'outputTokens', 'neurons'];

/** 日次カウンタを最大値で union（両側が同じ日を数えても二重にしない）。 */
export function unionCounters(local, remote) {
  const out = structuredClone(local ?? {});
  const days = remote?.days ?? {};
  let merged = 0;
  for (const [day, v] of Object.entries(days)) {
    const cur = out.days?.[day];
    if (!cur) {
      out.days = out.days ?? {};
      out.days[day] = v;
      merged++;
      continue;
    }
    let changed = false;
    for (const k of COUNTER_KEYS) {
      const r = Number(v?.[k]);
      if (Number.isFinite(r) && r > Number(cur[k] ?? -Infinity)) {
        cur[k] = r;
        changed = true;
      }
    }
    if (changed) merged++;
  }
  return { result: out, merged };
}

/** breeding-state: lastSlot/時刻は新しい方、カウンタ（aiCalls など）は最大値。 */
export function unionBreedingState(local, remote) {
  const out = structuredClone(local ?? {});
  let merged = 0;
  for (const [day, v] of Object.entries(remote?.aiCalls ?? {})) {
    const r = Number(v);
    if (Number.isFinite(r) && r > Number(out.aiCalls?.[day] ?? -Infinity)) {
      out.aiCalls = out.aiCalls ?? {};
      out.aiCalls[day] = r;
      merged++;
    }
  }
  for (const k of ['consecutiveFailures', 'lastSlot', 'lastSuccessAt', 'lastAttemptAt']) {
    const r = remote?.[k];
    if (r === undefined) continue;
    if (k === 'consecutiveFailures') {
      if (typeof r === 'number' && r > Number(out[k] ?? -Infinity)) {
        out[k] = r;
        merged++;
      }
    } else if (String(r) > String(out[k] ?? '')) {
      out[k] = r;
      merged++;
    }
  }
  return { result: out, merged };
}

// --- エントリ ---------------------------------------------------------------
// （テストからは純関数だけ import する）

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['rev-parse', '--verify', 'origin/main'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    console.error('⚠ origin/main が参照できません。先に git fetch origin を実行してください。');
    process.exit(1);
  }
  const readLocal = (f) =>
    existsSync(resolve(DATA, f)) ? JSON.parse(readFileSync(resolve(DATA, f), 'utf8')) : null;
  const readOrigin = (f) => {
    const s = execFileSync('git', ['show', `origin/main:data/${f}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return JSON.parse(s);
  };

  let changes = 0;
  const out = {};

  // 1) 削除台帳を先に計算（offspring union から削除済みを除外するため）
  const ledgerSrc = { local: readLocal('deleted-offspring.json'), remote: readOrigin('deleted-offspring.json') };
  const ledger = unionLedger(ledgerSrc.local, ledgerSrc.remote);
  const deletedIds = new Set(ledger.deletedIds);

  // 2) offspring union
  const offLocal = readLocal('offspring.json') ?? [];
  const offRemote = readOrigin('offspring.json') ?? [];
  for (const o of offLocal) {
    const twin = offRemote.find((r) => r?.id === o.id);
    if (twin && JSON.stringify(twin) !== JSON.stringify(o)) {
      console.warn(`⚠ offspring.json: ${o.id} は両側で内容が異なるためローカルを優先します（要確認）`);
    }
  }
  const off = unionOffspring(offLocal, offRemote, deletedIds);
  if (off.addedIds.length) {
    console.log(`+ offspring.json: リモートから追加 ${off.addedIds.join(', ')}`);
    out['offspring.json'] = off.result;
    changes++;
  }

  // 3) 台帳
  if (JSON.stringify(ledger) !== JSON.stringify(ledgerSrc.local ?? {})) {
    console.log(`+ deleted-offspring.json: deletedIds=${ledger.deletedIds.length}件 に union`);
    out['deleted-offspring.json'] = ledger;
    changes++;
  }

  // 4) processed-issues
  const pLocal = readLocal('processed-issues.json') ?? {};
  const pRemote = readOrigin('processed-issues.json') ?? {};
  const p = unionProcessed(pLocal, pRemote);
  if (p.merged > 0) {
    console.log(`+ processed-issues.json: ${p.merged}件をリモート側から union`);
    out['processed-issues.json'] = p.result;
    changes++;
  }

  // 5) ai-usage
  const uLocal = readLocal('ai-usage.json');
  const uRemote = readOrigin('ai-usage.json');
  if (uLocal && uRemote) {
    const u = unionCounters(uLocal, uRemote);
    if (u.merged > 0) {
      console.log(`+ ai-usage.json: ${u.merged}箇所を最大値で union`);
      out['ai-usage.json'] = u.result;
      changes++;
    }
  }

  // 6) breeding-state（aiCalls含む・lastSlot は新しい方）
  const sLocal = readLocal('breeding-state.json');
  const sRemote = readOrigin('breeding-state.json');
  if (sLocal && sRemote) {
    const s = unionBreedingState(sLocal, sRemote);
    if (JSON.stringify(s.result) !== JSON.stringify(sLocal)) {
      console.log(`+ breeding-state.json: lastSlot/カウンタを union`);
      out['breeding-state.json'] = s.result;
      changes++;
    }
  }

  // 7) current-candidates（remote-wins）
  const cLocal = readLocal('current-candidates.json');
  const cRemote = readOrigin('current-candidates.json');
  if (cLocal && cRemote && JSON.stringify(cLocal) !== JSON.stringify(cRemote)) {
    const newer =
      typeof cRemote.generatedAt === 'string' && cRemote.generatedAt > String(cLocal.generatedAt ?? '');
    if (newer) {
      console.log(`+ current-candidates.json: リモートの再生成結果を採用（generatedAt ${cRemote.generatedAt}）`);
      out['current-candidates.json'] = cRemote;
      changes++;
    }
  }

  if (changes === 0) {
    console.log('sync-data: 差分なし（全データファイルは origin/main と整合）');
  } else if (!APPLY) {
    console.log(`（dry-run）適用するには: node scripts/sync-data.mjs --apply`);
  } else {
    for (const [f, v] of Object.entries(out)) {
      writeFileSync(resolve(DATA, f), `${JSON.stringify(v, null, 2)}\n`);
    }
    console.log(`✅ sync-data: ${changes}ファイルを data/ に書き込みました`);
  }
}
