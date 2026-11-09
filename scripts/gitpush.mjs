/**
 * npm run gitpush -- "コミットメッセージ"
 *
 * git add -A → commit → pull（rebase）→ push を一発で行う。
 * - 変更がなければ commit しない。ただし**未pushのコミットが残っていれば push する**
 *   （「変更なし」で終了して push されていない状態を防ぐ / issue #22）。
 * - **push 前に fetch → 必要なときだけ pull --rebase**:
 *   GitHub Actions（配合ワーカー等）が途中で push していると remote が進み、
 *   そのまま push すると non-fast-forward で失敗する（実発生 / issue #22）。
 *   `--rebase` は明示フラグなので、リポジトリの `pull.rebase` 設定に依存しない。
 *   rebase は remote 側のコミットを土台に載せるため、merge commit を増やさない。
 * - rebase がコンフリクトした場合のみ手動対処の手順を表示して終了（自動解決はしない）。
 * - push 先は現在のブランチ（初回は -u で upstream 設定）。
 * - Claude Code が関与したコミットとして Co-Authored-By を付ける。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts });
  return r;
}

function gitOrDie(args) {
  const r = git(args);
  if (r.status !== 0) {
    console.error(`❌ git ${args.join(' ')} が失敗しました`);
    if (r.stderr) console.error(r.stderr.trim());
    process.exit(r.status ?? 1);
  }
  return r.stdout.trim();
}

// --- 未完了の rebase / merge を検知 ------------------------------------------
// 途中状態で add -A すると「コンフリクトマーカー付きのまま」コミットしてしまう
//（実検証で発生）。先に停止して手順を促す（自動解決はしない / issue #22）。
const gitDir = resolve(gitOrDie(['rev-parse', '--git-dir']));
for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
  if (existsSync(resolve(gitDir, marker))) {
    console.error(`❌ git の ${marker} 処理が未完了です（rebase / merge / cherry-pick の途中）。`);
    console.error('   このままコミットすると途中状態が固まります。先に完了または中断してください。');
    console.error('   例: git status → 解決 → git add <file> → git rebase --continue');
    console.error('        中断する場合 → git rebase --abort / git merge --abort');
    process.exit(1);
  }
}

// --- add -------------------------------------------------------------------
gitOrDie(['add', '-A']);

const staged = git(['diff', '--cached', '--name-only']).stdout.trim();

// --- commit ----------------------------------------------------------------
let committed = false;
let fileCount = 0;

if (staged) {
  const message = process.argv[2] ?? `update: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const fullMessage = `${message}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`;
  gitOrDie(['commit', '-m', fullMessage]);
  console.log(`✅ コミットしました: ${message}`);
  committed = true;
  fileCount = staged.split('\n').length;
}

const branch = gitOrDie(['rev-parse', '--abbrev-ref', 'HEAD']);
// detached HEAD や異常な参照（rebase 中など）では push 先を確定できない。
if (branch === 'HEAD' || branch.startsWith('origin/HEAD')) {
  console.error(`❌ 現在のブランチ名を取得できません（${branch}）。`);
  console.error('   detached HEAD になっていないか確認してください: git status');
  process.exit(1);
}

// --- pull（rebase）----------------------------------------------------------
// fetch は非破壊。失敗しても push の結果で判断できるので続行する
// （オフライン等では push も失敗し、そのエラーがそのまま出る）。
const fetch = git(['fetch', 'origin']);
if (fetch.status !== 0) {
  console.warn('⚠ origin への fetch に失敗しました（ネットワーク / 認証を確認）');
} else {
  // A...B の左=Aのみに存在する数（behind）、右=Bのみに存在する数（ahead）
  const [behind, ahead] = gitOrDie(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`])
    .split(/\s+/)
    .map((n) => Number(n));

  if (behind > 0) {
    console.log(`⤵ origin/${branch} が ${behind} コミット進んでいるため pull（rebase）します`);
    const pull = git(['pull', '--rebase', 'origin', branch]);
    if (pull.status !== 0) {
      console.error('❌ pull（rebase）に失敗しました（コンフリクトの可能性）。自動解決はしません。');
      console.error('   1) git status            — 競合ファイルの確認');
      console.error('   2) 編集して解決 → git add <file> → git rebase --continue');
      console.error('   3) 中断する場合        → git rebase --abort');
      if (pull.stderr) console.error(pull.stderr.trim());
      process.exit(pull.status ?? 1);
    }
    console.log('✅ pull（rebase）しました');
  }

  if (!committed && ahead === 0 && behind === 0) {
    console.log('変更がないため push は行いませんでした。');
    process.exit(0);
  }
}

// --- push ------------------------------------------------------------------
gitOrDie(['push', '-u', 'origin', branch]);
const files = fileCount > 0 ? `（${fileCount}ファイル, ` : '（';
console.log(`✅ push しました${files}ブランチ: ${branch}）`);
