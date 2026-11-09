import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// base パスの決定（優先順位）:
//   1. VITE_BASE（明示的な絶対パス上書き。例: VITE_BASE=/<repo>/）
//   2. 既定 './'（**相対base**）— ドメイン・公開パスの変更に追従不要:
//      - カスタムドメインのルート配信（https://example.com/）
//      - <owner>.github.io/<repo>/（パス付き）
//      - フォーク先での公開
//      どれでもアセット・内部リンクがそのまま動く。
//      （2026-11-10 に絶対パス /<repo>/ のままカスタムドメイン公開して真っ黒になったため、
//      ドメイン変更の可能性を踏まえて相対baseへ変更。）
const basePath = process.env.VITE_BASE ?? './';

// 公開サイト一式は public/ をルートにする（ページ: public/index.html, public/ideas/index.html）。
// public/static はそのまま dist 直下へコピーされる「生ファイル」置き場（例: sprites/）。
// vitest 実行時のみルート直下の tests/ を走査するため、従来どおりカレントディレクトリをルートにする
// （VITEST は設定読み込み前に立つ。define のダミー注入と同じ既存パターン）。
const isVitest = !!process.env.VITEST;

const dataDirUrl = new URL('./data/', import.meta.url);

// ランタイム観測用: トップの main.ts が data/offspring.json をフェッチして
// 「ビルド後に生まれた誕生」を検知できるようにする（public/ 外のため emit が必要。
// dev サーバーでは同一パスへミドルウェアで返す。読み込み失敗時はフロントが
// ビルド時データへフォールバックする）。
const runtimeDataPlugin: Plugin = {
  name: 'emit-runtime-data',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'data/offspring.json',
      source: readFileSync(new URL('offspring.json', dataDirUrl), 'utf8'),
    });
  },
  configureServer(server) {
    server.middlewares.use('/data/offspring.json', (_req, res, next) => {
      try {
        const body = readFileSync(new URL('offspring.json', dataDirUrl), 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(body);
      } catch {
        next();
      }
    });
  },
};

// 個別詳細ページ（issue #24）: GitHub Pages は静的ホスティングのため、
// ビルド時に data/offspring.json の各IDぶんの dist/ideas/<id>/index.html を生成する。
// テンプレートは dist/idea/index.html（深さ1）なので、深さ2へコピーするとき
// 相対baseの参照（../assets/…）を 1つ上（../../assets/…）へ読み替える
// （絶対base（VITE_BASE指定）のときは参照が / で始まるため読み替え不要）。
// 開発サーバーでは /ideas/<id>/ を同じテンプレートで開ける（本番相当のURLで確認できる）。
const ideaIdPattern = /^mashup-[A-Za-z0-9_-]+$/;

const ideaPagesPlugin: Plugin = {
  name: 'emit-idea-pages',
  // generateBundle では Vite コアの HTML 生成より先に走って bundle に無いことがあるため、
  // ディスク書き込み完了後の closeBundle で dist/idea/index.html を読み、各IDぶんを生成する。
  closeBundle() {
    if (isVitest) return;
    const distDir = fileURLToPath(new URL('./dist/', import.meta.url));
    const templatePath = join(distDir, 'idea', 'index.html');
    if (!existsSync(templatePath)) return; // ビルド未実行（dev中）などは対象外
    const html = readFileSync(templatePath, 'utf8');
    let list: unknown;
    try {
      list = JSON.parse(readFileSync(new URL('offspring.json', dataDirUrl), 'utf8'));
    } catch {
      return; // データが読めなければ個別ページは生成しない（トップは動く）
    }
    if (!Array.isArray(list)) return;
    // 相対baseのときのみ深さに合わせて読み替える（絶対baseは / 始まりで無変更）
    const deeper = html.replace(/(href|src)="\.\.\//g, '$1="../../');
    for (const row of list) {
      const id = (row as { id?: unknown })?.id;
      if (typeof id !== 'string' || !ideaIdPattern.test(id)) continue; // パス生成は許可フォーマットのみ
      const dir = join(distDir, 'ideas', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), deeper, 'utf8');
    }
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const m = /^\/ideas\/(mashup-[A-Za-z0-9_-]+)\/?(?:\?|$)/.exec(req.url ?? '');
      if (!m) return next();
      void (async () => {
        const raw = readFileSync(fileURLToPath(new URL('./public/idea/index.html', import.meta.url)), 'utf8');
        const html = await server.transformIndexHtml(req.url ?? '/', raw);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      })().catch(() => next());
    });
  },
};

export default defineConfig({
  root: isVitest ? undefined : fileURLToPath(new URL('./public', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public/static', import.meta.url)),
  base: basePath,
  plugins: [runtimeDataPlugin, ideaPagesPlugin],
  // Actions の GITHUB_REPOSITORY をクライアントコードへ注入する（リポジトリ名のハードコード禁止）。
  // テスト時のみダミー値を注入し、Issueリンク生成のUI挙動を検証できるようにする。
  define: {
    __GITHUB_REPOSITORY__: JSON.stringify(
      process.env.GITHUB_REPOSITORY ??
        (process.env.VITEST ? 'test-owner/test-repo' : ''),
    ),
  },
  build: {
    // root が public/ のため outDir・input は絶対パスで指定（相対だと public/dist になる）
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    // outDir が project root 外のため Vite は自動で中身を消さないので明示的に空にする
    // （消さないと旧ハッシュのバンドルが dist に残り続ける）
    emptyOutDir: true,
    sourcemap: true,
    // マルチページ（トップ + /ideas + 個別ページの元板 /idea）。
    // GitHub Pagesは静的配信のため public/ideas/index.html を出力し /ideas/ に解決させる（issue #8）。
    // /ideas/<id>/ は ideaPages プラグインがビルド時に生成（issue #24）。
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./public/index.html', import.meta.url)),
        ideas: fileURLToPath(new URL('./public/ideas/index.html', import.meta.url)),
        idea: fileURLToPath(new URL('./public/idea/index.html', import.meta.url)),
        // カスタム404（issue #24 §7）: GitHub Pages が未知パスに返すルートの 404.html。
        // 外部参照なしの自己完結型（深さによらず動く）。
        notfound: fileURLToPath(new URL('./public/404.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 複数テストファイルがUIモジュールを import して実行結果を共有しないよう隔離
    isolate: true,
  },
});
