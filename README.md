# Mashup Ours

**20年分の発明を、もう一度マッシュアップ。**

ProtoPediaに公開された実在の作品を2つ「親」として選び、生成AIによって新しい発明のアイデア（「子」）を1つ誕生させるWebサービス。子も次の配合の親になれます。生成された発明の系譜は、公開された「発明の系譜図」として育てられます。

> **生成された子作品は「AIが考えた未実装のアイデア」です。** 実際に製作したもの・実在の成果物ではありません。ProtoPediaの元作品には出典リンクを表示します。

## アーキテクチャ

| 部分 | 構成 |
| --- | --- |
| 公開UI | GitHub Pages（Vite + TypeScript の静的サイト） |
| 投稿 | GitHub Issues（サイトにログイン機能・書き込みトークンなし） |
| 配合候補 | `config/schedule.json` の間隔（既定15分）ローテ → `data/current-candidates.json`（**ブラウザはProtoPedia APIを呼ばない**） |
| 作品データ | ProtoPedia API v2 → 少数取得（`data/sample-prototypes.json` ほか）→ 候補プール |
| 配合ワーカー | GitHub Actions（起床は一定間隔、実行可否は設定間隔で判定 + 手動 `workflow_dispatch`） |
| 頻度設定 | `config/schedule.json`（候補更新間隔・配合間隔・候補件数をファイルで変更 / issue #15） |
| 永続データ | リポジトリ内の `data/offspring.json` / `data/breeding-state.json` / `data/element-cache.json` / `data/processed-issues.json` / `data/ai-usage.json` |
| AI | **Cloudflare Workers AI**（Actionsサーバー側から呼ぶ。テキスト `@cf/openai/gpt-oss-20b`・画像 `@cf/black-forest-labs/flux-1-schnell` / issue #16） |
| サムネイル | 生成成功時 `public/static/assets/inventions/<子ID>.png`（ViteのpublicDirから `dist/assets/inventions/` へ配信）（512×512）。**失敗してもテキストは保存**（`imagePath: null`） |

**AI配合は設定間隔（既定60分=1時間）を空けて最大1件です（全ユーザー共有）。** 閲覧・選択・系譜図表示にAIは使いません。

**候補は設定間隔（既定15分）ごとに最大6件が全ユーザー共通**です。「本日の発明研究所」に並ぶ候補はスロット（UTC `YYYY-MM-DDTHHMM`・設定間隔の刻み）ごとに決定的に選ばれ、**ページを再読み込みしても変わりません**。自由検索はなく、候補から2作品（AとB）を選んで申請します。

## セットアップ（ローカル開発）

```bash
cp .env.example .env   # Issue作成リンク用の owner/repo を設定
npm install
npm run dev            # http://localhost:5173
```

- APIトークンなしでもフロントは起動・ビルドできます（`npm test`, `npm run build`）。
- 候補6件は `data/current-candidates.json` の静的importだけ（ブラウザからAPIを呼ばない）。
- 候補データが未同期のときは `[SAMPLE]` 付きの**開発用サンプル**が表示され、右上バッジも「開発用サンプル」になります。本番と混同しないでください。
- 本番の子作品が0件のときだけ、サンプルの子作品（系譜図2世代の確認用）を「最近誕生した発明」と系譜図に表示します（注意書きを分けて案内）。

### 環境変数

| 変数 | 用途 | 必須 |
| --- | --- | --- |
| `VITE_GITHUB_OWNER` | Issue作成リンクのowner | ローカルのみ |
| `VITE_GITHUB_REPO` | Issue作成リンクのrepo | ローカルのみ |
| `GITHUB_REPOSITORY` | Actionsが自動提供。ビルド時にクライアントへ注入 | Actions |
| `CLOUDFLARE_ACCOUNT_ID` | CloudflareのアカウントID（**GitHub Secrets / ローカル`.env`のみ**） | 配合処理時 |
| `CLOUDFLARE_API_TOKEN` | Workers AI実行用のAPIトークン（**最小権限・GitHub Secrets / ローカル`.env`のみ。ログ・JSON・フロントに入れない**） | 配合処理時 |
| `PROTOPEDIA_API_V2_TOKEN` | ProtoPedia API v2のトークン（**GitHub Secrets / ローカルenvのみ。VITE_ プレフィックス禁止**） | 作品同期時 |
| `GH_TOKEN` | ローカルの `gh` CLI用PAT（`.env` 専用・`node scripts/gh.mjs` が読む。**VITE_ プレフィックス禁止**。Actionsは `GITHUB_TOKEN` で自動認証） | 開発issue登録時のみ |

## GitHub上の設定（手動）

1. **Pages**: Settings → Pages → Source を `GitHub Actions` に設定（`deploy.yml` が push のたびにテスト → ビルド → デプロイ）。**base は既定で相対パス（`./`）**: カスタムドメインのルート配信・`<owner>.github.io/<repo>/`・フォーク先のいずれでも、ドメインや公開パスを変更してもビルド設定なしで動く（Issue リンクは `GITHUB_REPOSITORY` から自動導出）。絶対パスに固定したい場合のみ `VITE_BASE=/<repo>/` を指定する。絶対パス base をカスタムドメインで使うとアセットが全部404で真っ黒になる（実例: 2026-11-10 → 相対baseへ修正）。
2. **Issues**: Settings → Issues でラベル `breeding-request` を用意（ワークフロー側で管理。利用者が付ける前提にしない）。
3. **Secrets**: Settings → Secrets and variables → Actions に登録:
   - `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`（配合処理。**未設定時はコスト0で停止**し、`npm run breed:dry` の動作確認のみ）
   - `PROTOPEDIA_API_V2_TOKEN`（作品同期。[トークン取得先](https://protopedia.net/settings/application)。未設定時は同期をスキップし既存データを維持）
4. **Actions権限**: Settings → Actions → General → Workflow permissions を設定。JSONコミットには `contents: write`、Issue対応には `issues: write` を該当ジョブのみに付与。
5. 配合申請はサイトの「配合を申し込む」ボタン → Issue作成画面が開く → **ユーザー自身が送信**。

## 頻度設定（config/schedule.json）

配合頻度・候補更新頻度・候補件数は設定ファイルで変更できる（issue #15）。**ファイルの変更をコミットするだけで反映**され、UIの文言・次回予定時刻もこの値から生成される。

```json
{
  "candidateRotationMinutes": 15,
  "breedingIntervalMinutes": 60,
  "maxCandidates": 6
}
```

| キー | 意味 | 既定 |
| --- | --- | --- |
| `candidateRotationMinutes` | 配合候補の更新間隔（分・正の整数、1〜10080） | 15 |
| `breedingIntervalMinutes` | 配合（生成AI呼び出し）の間隔（分・正の整数）。**前回の成功からの空き時間** | 60 |
| `maxCandidates` | 1枠の候補件数の上限（正の整数、1〜50） | 6 |
| `dailyAiCallLimit`（任意） | UTC日ごとの生成AI呼び出し回数の上限（正の整数）。未設定 = 上限なし | なし |

- **候補更新と配合処理は独立した設定**であり、UIでも混同しない（「◯ごとに新しい発明候補が届くよ！」と「◯に最大1つ、新しい発明が誕生します！」は別々のキーから生成）。「1時間に1回」「毎時」などの固定文言はサイトに存在しない。
- **GitHub ActionsのcronはJSONを読めない**ため、ワークフローは一定間隔（15分）で「起床」し、スクリプト側が実行可否を判定する:
  - 候補: `scripts/rotate-candidates.ts` が現在時刻から設定間隔でスロットを算出し、`data/current-candidates.json` の `slot` と比較。同一枠ならスキップ（= 二重生成しない）。**「間隔ごとに必ず生成」ではなく「間隔を空けて最大1件」**なので、Actionsの遅延があっても正常動作。手動実行（`workflow_dispatch`）も同じ判定を通る。
  - 実効的な候補更新間隔 = **max(設定値, 起床間隔15分)**。15分未満の間隔にする場合は cron（`rotate-candidates.yml`）も合わせて短くすること。
  - 配合: ワーカー（`breed.yml` / issue #6）が `shouldBreed()`（`lib/schedule.ts`）で判定。前回成功日時（`data/breeding-state.json`）と `breedingIntervalMinutes` を比較し、未経過なら生成AIを呼ばない。
- **失敗時の再試行条件（明示）**: 失敗は間隔に数えないので次の起床で再試行できる（最大3回）。連続3回失敗すると間隔ぶんの冷却に入り、冷却経過で再開。成功でカウントはリセット。`dailyAiCallLimit` 設定時はUTC日単位で上限（失敗した試行も呼び出し回数に計上）。
- **設定が不正なとき**: rotate / validate は exit 1 で処理を停止してエラーを通知（= AIを呼ばない）。フロントは既定値で表示を続けつつエラーを告知する。
- 既存の `data/offspring.json`・Issue申請・`current-candidates.json` は変更不要（設定変更との互換性を維持）。
- ローカル開発で枠内に再生成したいときだけ `npm run rotate:candidates -- --force`（ワークフローからは渡さない）。

## 日時表示（JST統一 / issue #18）

**サイトに表示する日時はすべて日本時間（`Asia/Tokyo`）**。内部データと処理はUTCのまま（下記）。

- **表示**: `lib/datetime.ts` の共通関数だけを通す。日付 `2026/11/10` / 日時 `2026/11/10 15:00` / 時刻 `15:00` / 時間帯 `15:00〜15:15`（日跨ぎは `2026/11/09 23:30〜2026/11/10 00:30`）。24時間表記・秒なし・`Intl.DateTimeFormat` に `timeZone: 'Asia/Tokyo'` を明示するため**ブラウザ/OSのタイムゾーン設定に依存しない**。文言は「現在の配合枠」「最終更新」「次の候補更新」「誕生日時」で、値の後ろに「（日本時間）」を添える。
- **不正・欠損の日時**は例外ではなく **`日時不明`** を表示する（そのときだけ「（日本時間）」は付けない）。
- **内部はUTC**: JSONの `createdAt` / `generatedAt` / スロットキー（`YYYY-MM-DDTHHMM`）はISO 8601（UTC）のまま、Actionsのcron・間隔判定・スロット境界もUTCの絶対時刻。**JST文字列を再解析して判定することはしない**（比較・判定は `lib/schedule.ts` / `lib/candidates.ts`、`lib/datetime.ts` は表示専用）。既存JSONの書換も不要。
- **予定時刻は保証しない**: 「次の候補更新」はActionsの実行結果（JSONの値）から導いた**更新予定**で、遅延時は `⚠ 候補更新が遅れています` が出る（端末時計で補完しない）。カウントダウン表示は無い。
- 配合の実行制限は従来どおり**前回成功からの経過時間（elapsed方式）**で、表示時間帯（固定枠の境界）とは独立した設定（`breedingIntervalMinutes`）。

## ProtoPedia作品の取得と候補ローテ（API v2）

仕様は `docs/protopediaapi.md`（調査資料。**実接続で一部確認済み**、下「検証済みと未検証」参照）。実装は `lib/protopedia.ts` + `scripts/fetch-sample-prototypes.mjs` + `scripts/rotate-candidates.ts`。

```text
ProtoPedia API v2 ──(Bearer)──> npm run fetch:sample（少数・手動 / syncはdispatchのみ）
                                   │ 取得 → HTML除去・型検証・URL検証・ライセンス確認
                                   ▼
                          data/sample-prototypes.json（候補プール）
                                   │ npm run rotate:candidates（configの間隔・既定15分ごと / APIトークン不要）
                                   ▼
                          data/current-candidates.json ──> GitHub Pages（静的import）
```

- **試作段階では全件収集を開始しない**: `npm run fetch:sample` は既定12件（`--count=` 上限50 / `--offset=`）。
  全件同期は `npm run sync:protopedia`。`sync-prototypes.yml` は**手動 dispatch のみ**（有効化するときだけ `schedule` を戻す）。
- **候補ローテ**: `npm run rotate:candidates` は保存済みプールからスロット（UTC `YYYY-MM-DDTHHMM`・設定間隔の刻み）に**決定的に** `maxCandidates` 件を選出。
  同じスロットなら常に同じ候補（枠内のActionsの再実行・ローカル実行でも不変）。APIもトークンも使わない。**前回と同一枠ならスキップ**（頻度制限。`--force` で解除）。
  `-- --slot=2026-11-09T1415` で任意の枠を検証、`-- --dry-run` で書き込まず確認。
- **起床は15分固定・実行可否はスクリプト判定**: `.github/workflows/rotate-candidates.yml`（cron `4/15 * * * *` + dispatch）が一定間隔で起動し、スクリプトが `config/schedule.json` の間隔と前回生成の `slot` から実行可否を判断して `data/current-candidates.json` をコミット（issue #15）。
  画面上の「次回の候補更新予定」はこの**実行結果（JSONの値）**ベースで、遅延時は注意書きが出ます。
- **失敗時の挙動**: 取得失敗・0件・不正レスポンスでは既存JSONを置き換えない（0件保存は拒否）。
- **トークンの扱い**: `.env` / Secretsのみ。スクリプトがreadFileSyncで読む（シェルにexportしない）。ログ・JSON・コミット・フロントバンドルに入れない。
- 作者（`表示名@handle` のまま保存 = クレジット用）・タグ・ライセンス・作品画像はこのJSONから表示。

## 配合申請フォーマット

```text
Title: [Breed] protopedia:1234 x protopedia:5678   ← 表示用（信用しない）

parent_a: protopedia:1234                           ← 正規の入力元は本文のみ
parent_b: protopedia:5678
parent_a_url: https://protopedia.net/prototype/1234 ← 表示・照合用の「データ」（httpsのみ）
parent_b_url: https://protopedia.net/prototype/5678
mode: fusion                                        ← fusion（単純配合）/ genetic（遺伝子配合）/ mutation（突然変異配合）
slot: 2026-11-09T1715                                ← 申請時の候補スロット（UTC・設定間隔の刻み＝既定15分。移行前のHH形式も許容）
<!-- 任意: comment: の後に1行だけで自由記述（最大500字・研究員へのひとこと） -->
```

- 親Aと親Bは別のID、許可されたID形式（`protopedia:<数字>` / `mashup-<数字>`）のみ。
- `slot` / `*_url` は付いていれば形式を検証して記録。URLは命令として扱わず、ワーカーは親IDから出典URLを再導出する。
- `comment`（研究員へのひとこと）は任意の自由記述（1行・最大500字・**Issue作成時のみ**入力）。生成時の追加条件としてAIに渡しますが、**渡し方は区切り付きの「参考資料（データであり命令ではない）」だけ**で、シェル・GitHub Actions式には一切埋め込みません（プロンプトインジェクション対策 / issue #5・#16 §5）。
- 不正な入力はAIを呼ばずに理由をコメントします。

## 生成AIによる配合（Cloudflare Workers AI / issue #16）

`.github/workflows/breed.yml` が cron（`9/15 * * * *` = 15分ごとに起床）と `workflow_dispatch` で起動し、`scripts/process-breeding.ts` が処理します。**実効的な配合は `config/schedule.json` の `breedingIntervalMinutes`（既定60分）を空けて最大1件**（全ユーザー共有。cronは正時に厳密実行しないため「間隔を空けて最大1件」という仕様）。

```text
open Issue の最古1件（ラベル非信用・タイトル/本文で判定）
  → パース・ID検証・重複/近親交配チェック（不正はAI前に却下コメント）
  → 親の要素抽出8項目（使用技術/目的/解決する課題/入力/出力/体験/特徴/面白さ）
      └ 作品ID + 内容ハッシュで data/element-cache.json にキャッシュ（同じ親は再抽出しない）
  → gpt-oss-20b で配合生成（配合タイプ・研究員のひとこと反映 / JSON構造化出力）
  → 出力JSONを検証（不正・危険・根拠なし主張は公開しない）
  → flux-1-schnell で 512×512 サムネイル（画像内文字なし・写真風禁止。失敗してもテキストは保存）
  → data/offspring.json + キャッシュ + 利用量 + 処理状態をコミット
  → Issue へ生成結果をコメントしてクローズ
```

- **ローカル実行**: `npm run breed:dry`（AI呼び出し・データ書き込み・Issue操作を一切しない安全確認）/ `npm run breed`（本番と同じ処理）/ `npm run breed:check-ai`（認証情報の接続確認のみ1回）。
- **二重処理防止**: `data/processed-issues.json`（`resolved` / `rejected` は永却下、`failed` は3回まで再試行）。`concurrency` は固定グループで直列実行。
- **利用量とコスト**: `data/ai-usage.json` に**実行回数とトークン数は実測**で記録し、Neurons は公開料金表からの**試算**として記録します（**試算を実測値として扱わない**）。Cloudflareの利用量APIは公式ドキュメントに存在しない（**未検証**）ため、上限判定は実呼び出し回数（`dailyAiCallLimit`）で行います。**「1時間に1回なら無料枠内」とは断定しません**（無料枠・料金は変動するため、使う前に公式情報を確認してください）。
- **失敗時**: 認証失敗・予算超過・一時障害を分類してログに残し、自動の無限リトライはしません（テキスト生成2回・画像再試行1回まで）。エラーにトークンを含めません。
- **権限**: ワークフローは `permissions: {}` から始まり、該当ジョブだけ `contents: write`（JSONコミット）と `issues: write`（コメント・クローズ）を付与。**AI出力はshellへ埋め込まず `tmp/breed-report.md` 経由**でコメントします。
- **`dry_run: true`**（dispatch の既定値）は本番の時間枠を消費せず、データ・Issueを書き換えません。

## デザイン（16bit配合研究所 / DESIGN.md準拠）

デザインの基準は `DESIGN.md`。「ちょっと怪しい発明博士の、16bit配合研究所」。MOTHER2/マサキの家の雰囲気を**抽象化して独自に**構成し、既存IPの画像・キャラクター・UI配置は流用しない。

- **ダーク / ライト切り替え**: ヘッダー右上のボタンで切り替え、`localStorage['mashup-theme']` に保存。既定はOS設定。`index.html` の初期化スクリプトがCSS読込前に `data-theme` を設定し、テーマフラッシュを防ぐ。トークンは `:root` の `--lab-*`（固定パレット）とロールトークン（`--bg` / `--window` / `--line` / `--text` など）に集中管理。
- **フォント**: 見出し・ボタン・ラベルは [DotGothic16](https://fonts.google.com/specimen/DotGothic16)、**本文は [Noto Sans JP](https://fonts.google.com/specimen/Noto+Sans+JP)** で可読性優先（**Google Fonts CDN への外部接続あり**。届かない環境ではゴシック/等幅にフォールバック）。
- **アクセス解析**: **Google Tag Manager（`GTM-NLGLRR3T`）** をトップと `/ideas` の両方の `<head>` に配置し、`<body>` 直後に公式推奨の `noscript` iframe を配置（**外部接続先: `googletagmanager.com`**）。タグ本体はGTMコンテナ側で管理し、サイトにはIDだけを置く。ローカルの `npm run dev` / preview からもヒットが送信される（解析値に開発データが混ざる点に注意。除外はGTMコンテナ側のトリガー条件で行う）。
- **ウィンドウ**: 太い外枠3px + 内側の細い線（inset）+ 右下ハードシャドウのRPG風。ガラス調・ネオンは不使用。
- **候補パネル「本日の発明研究所」**: 画面完成イメージ準拠の角丸パネル + 3列画像カード（900pxで2列 / 560pxで1列）。
  画像タイルは下地 `--tile`（白系・両テーマ共通）で `object-fit: contain`・`loading=lazy`・読込失敗時は「画像なし」プレースホルダ（枠は維持）。
  見出しは DotGothic16 + ラテン小見出し、枠・色は研究所トークンのまま — **一般的なSaaSカードUIにしない**。
  選択状態は「タイル枠の色 + バッジ文字（親A選択中）+ 押下ボタン」の三重化で色だけに依存しない。
- **一覧ページ `/ideas`**: Viteマルチページ（`public/ideas/index.html` + `public/ideas.ts`）。`data/offspring.json` のみを新しい順に列挙し、各項目に 未実装バッジ・世代・親リンク（子作品=その個別ページ / ProtoPedia=出典URL）・誕生日時（日本時間）・元Issue（あれば）を表示。0件なら空状態で申請誘導。トップの「最近誕生した発明」見出しからリンクする。**カードのサムネイル・発明名・概要は1つの `<a class="idea-open">` で個別ページへ遷移**（リンク入れ子を避けるため親作品・Issueのリンクはその外侧。実リンクなのでキーボード操作も可能）。
- **個別詳細ページ `/ideas/<id>/`（issue #24）**: 「一覧は発見の場、個別ページは詳しい情報と誕生の経緯の場」。
  - **静的ホスティング対応**: ビルド時に `vite.config.ts` の `ideaPages` プラグインが `data/offspring.json` の各IDぶんの `dist/ideas/<id>/index.html` を生成（相対base参照は深さに合わせて `../../` へ読み替え。絶対base指定時は無変更）。開発サーバーは `/ideas/<id>/` を同じテンプレートで返す（本番相当のURLで確認）。
  - **表示内容**: サムネイル（大）・発明名・概要・配合タイプ・世代・誕生日時（JST）・発明ID / **親A・Bを左右配置**（ProtoPedia=作品名・作品画像・作者・出典リンク、mashup=発明名・サムネイル・個別ページへのリンク）/ AI配合結果（継承・仕組み・技術構成・利用シーン・詳細）/ 子どもへのリンク / 関連リンク（元Issue・系譜図 `?id=`・一覧・配合申請）。親メタデータ不在・画像なし・任意フィールド欠損でも壊れない。
  - **相互遷移**: 個別 →「系譜図で見る」= `?id=` ディープリンク（選択状態でトップへ）。系譜図の詳細パネル →「この発明の詳細ページを開く」で個別へ。
  - **404**: 存在しないIDは静的ホスティングだとサーバ404になるため、ルートの `dist/404.html`（自己完結型・`public/404.html`）が返され、「そのIDの発明は見つかりませんでした」+ 一覧/トップへの導線を表示。未知の一般パスも同じ404が使われる（リンクの基点はパス中の `/ideas/` 位置から計算。未知パスでは `/` 仮定 = 既知の制約）。
- **系譜図の配色は dataviz 手順で検証済み（両テーマ・ノード面でPASS）**:
  | テーマ | 面 | 元作品（実線） | 子作品（破線） |
  |---|---|---|---|
  | ダーク | `#303C51` | `#12A87D` | `#D96B4F` |
  | ライト | `#FFFCF0` | `#0F9D72` | `#C15733` |

  CVD分離は ΔE 7〜8 のWARN帯のため、**凡例 + 線種（実線/破線）+ ノードラベルで二重化**して合法化している。勝手に色を替えない。
- **コントラスト**: 本文はAA（4.5:1以上）をトークンで確保。アクセント色の強調語は `--accent-ink`（通常サイズでAA）、タグラインは太字19pxの「大きな文字」経路（3:1以上）を使う。装飾は `aria-hidden`、状態は色のみで区別しない（ラベル・線種・マーク併用）。
- **装飾**: 浮遊スプライト・常時点滅・グリッド背景は不使用（DESIGN.md §3.1/§6）。所長のメモは文字だけのセリフウィンドウ。**博士キャラクターは状態表現としてのみ動き、`prefers-reduced-motion` で全停止する。**
- **博士キャラクター（issue #11）**: 案内役の博士（親選択の案内）と 実験担当の博士（配合実験・結果発表）を8bitスプライトで表示（`public/assets/characters/` に個別透過PNG 8枚・共通135×268・足元揃え、切り出しは `scripts/slice-characters.mjs`）。
  - 状態は `idle / success / thinking / celebration` の4種（`public/character.ts` が表示、`public/breeding-state.ts` が実際の状態から決定）。
  - **リアクションは実際の処理状態と連動**: Issue作成画面を開いただけでは `success` にしない（「送信」まで未完了と表示）。申請完了は匿名GitHub APIがIssueを確認したときだけ。**実験待ち（open Issue）と生成中（closed 未公開）を区別**し、誕生（`celebration`）は公開済みの本番子作品でだけ判定する。
  - 状態観測はブラウザから匿名 `api.github.com`（CORS可・60req/h/IP）を **3分間隔（最大40req/h）** でポーリング。3回連続失敗・レート制限・誕生確認で停止し、無限リトライしない（`public/github-watch.ts`）。
  - ランタイムの誕生検知用にビルド時と同様の `data/offspring.json` を `dist/` へ emit（取得失敗時はビルド時データにフォールバック）。
- **ロゴの読み仮名（issue #19）**: FVの英語ロゴ「Mashup Ours」の右隣に小さく **「（マッシュアップアワーズ）」** を添える（Mashup Awardsをもじった名前と伝わる添え書き）。
  - 英語ロゴ（`.hero h1`）は文言・ドット絵スプライトとも変更せず、読み仮名は `.logo-yomi`（h1とは別要素）。
  - カタカナは英語より**目立たない**: h1（`clamp(1.6rem〜2.6rem)` DotGothic16）に対し `clamp(0.72rem〜0.95rem)`・`--text-dim`・本文フォント **Noto Sans JP（日本語の可読性優先でドットフォントにしない）**。
  - **760px以下はロゴの下に配置**（`.hero-logo` を縦積み）。デスクトップ/モバイルとも横スクロール0pxを実測。
  - キャッチコピー「20年分の発明を、もう一度マッシュアップ。」は変更なし。
- **スクリーンショット確認**: `npm run build && npx vite preview --port 4173` を起動してから `npm run screenshot`（**ライト/ダーク両テーマ** × デスクトップ/詳細/モバイルを `tmp/` に出力。初回のみ `npx playwright install chromium` と `install-deps` が必要）。

## ID名前空間の決定事項

- ProtoPedia作品: `protopedia:<数字>`（第0世代）
- 生成された子作品: `mashup-<数字6桁>`（例 `mashup-000001`）。**Issue本文の `parent_a` / `parent_b` にもこのid文字列をそのまま使う。**
  - AGENTS.mdのIssue例は `mashup:<生成ID>`（コロン）だが、データモデル例は `mashup-000001`（ハイフン）。**誤導入を避けるためデータモデル例のハイフン形式に統一**した。
- 先祖と子孫の組み合わせ（近親交配）は拒否する。共通の子を持つだけのダイヤモンド形状は許可。

## ステータス / 検証済みと未検証

**実接続で確認済み（2026-11・実トークンでの取得）**:
- `/prototype/list` のレスポンス形状は `{metadata, count, links, results}`。**`count` はページ内件数**（総数ではない）。
- カタログ件数外の offset は HTTP 200 + `count:0` で `results` キー自体が無い（= 空ページとして正常終了）。

**実接続で確認済み（2026-11・`npm run breed:check-ai` / Cloudflare Workers AI）**:
- 認証・エンドポイントは有効。テキスト生成 `@cf/openai/gpt-oss-20b` の同期応答は **OpenAI互換**（`object: "chat.completion"`）で本文は `choices[0].message.content`。
- **`usage` フィールドは存在する**: `prompt_tokens` / `completion_tokens` / `total_tokens` / `neurons`（Workers AI の消費単位。**neuronsは試算値**という方針は維持）。
- **gpt-oss は推論モデル**: `max_tokens` は**思考も含む予算**。不足すると `content: null` + `finish_reason: "length"`（思考は `message.reasoning_content`）→ 抽出は空文字になり**呼び出し側の検証・失敗処理に落ちる**（データは壊れない）。check-ai は `max_tokens: 300` + `include_reasoning: false` で本文取得を確認。
- `include_reasoning: false` は受理される。**`reasoning_effort` は HTTP 400 で不可**（このエンドポイント）。
- トークン実測例: prompt 76 / completion 40（思考込み）で `content="OK"`。
- `users` / `tags` は `|`-区切りの**文字列**。作者は `表示名@handle` 形式（例 `ひさやん@hisayan`。そのまま保存 = クレジット用）。
- `licenseType: 1` → 作品ページ表示「CC BY 4+」（id=1 のページと照合済み）。取得時はライセンスのある作品だけ保存。
- 作品ページURLは `https://protopedia.net/prototype/<id>`。カタログ総数は 5,100件超（正確な総数は未測定）。
- `data/sample-prototypes.json` 12件取得 → `data/current-candidates.json` 候補6件生成 → 両方とも `npm run validate-data` で検証済み。

**未検証**:
- [ ] `deploy.yml` / `sync-prototypes.yml` / `rotate-candidates.yml` の実動作 — push後のActions実行結果で確認（ローカルではYAML構文・スクリプト単体・決定的選出テストのみ確認）。
- [ ] `releaseFlg` のenum値の意味（観測値は常に 2。欠損=公開扱いの暫定実装）。
- [ ] ProtoPedia APIのレート制限・1レスポンスの件数上限（ページ間隔100msで暫定対応）。
- [ ] **Cloudflare Workers AI の本番生成**（テキスト接続は確認済み＝上記。以下は未検証）。
  - [ ] `flux-1-schnell` の応答（`result.image` の形式・width/height非指定時の挙動）— check-ai はテキストのみ確認。
  - [ ] **本番の抽出（1200）・生成（2500トークン）での推論トークン消費** — 思考込みの予算のため、長文思考で `finish_reason=length` になる可能性。起きれば検証失敗→再試行→失敗処理に落ちる（安全側）。
  - [ ] 無料枠・料金・レート制限の現行条件（**「1時間に1回なら無料枠内」とは断定しない**）。
- [ ] `breed.yml` の cron 実動作（15分起床・間隔判定・Issueコメント/クローズまで）。ローカルは `npm run breed:dry` と単体テストのみ。
- [ ] `data/offspring.json` へのコミットとブランチ保護の兼ね合い — Actions実装時に確認、必要ならPR方式へ。
- [ ] GitHub Pages 本番での `/ideas` 配信 — ローカル preview では `/`・`/ideas/`・`/ideas` すべて200を確認。Pagesの `/ideas` → `/ideas/` リダイレクト挙動は未検証（自前リンクは末尾 `/` つきなので影響なし）。
- [ ] ブラウザからの匿名 GitHub API ポーリング（申請確認・実験待ち/生成中/誕生の観測）の実挙動 — ローカルではフェッチ注入の単体テストのみ。実ネットワークでのレート制限・CORS挙動は未検証。
- [ ] Pages 本番での `dist/data/offspring.json` 配信（誕生のランタイム検知）— ローカル preview/dev では 200 を確認済み。
- [ ] **個別ページ `/ideas/<id>/` とカスタム404の本番配信**（issue #24）— ローカルでは GH Pages 相当サーバ（未知パス→`404.html`・末尾スラッシュ301）で全検証済みだが、本番カスタムドメインでの実配信は push → deploy 後。カスタム404のリンク基点は `/ideas/` 位置から計算（一般未知パスでは `/` 仮定）。

## 開発コマンド

```bash
npm run dev             # 開発サーバー（/ideas/<id>/ も本番相当のURLで開ける）
npm test                # パーサー・世代計算・候補選出・フロントのスモークテスト
npm run build           # 型チェック + 本番ビルド（各IDの個別ページと 404.html も生成）
npm run translate:offspring -- --id=<id>        # 既存データの日本語化: 対象確認（AI呼び出しなし）
npm run translate:offspring -- --id=<id> --write # 翻訳して書き込み（AI呼び出し・issue #23）
npm run validate-data   # config/schedule + offspring / prototypes / sample-prototypes / current-candidates /
                        # breeding-state / element-cache / processed-issues / ai-usage の検証
npm run fetch:sample    # ProtoPediaから少数だけ取得 → data/sample-prototypes.json（トークン要）
npm run rotate:candidates # 候補をスロットから決定的に選出 → data/current-candidates.json（トークン不要・設定間隔の枠内ならスキップ / --force で解除）
npm run breed:dry         # 配合ワーカーの安全確認（AI・データ書き込み・Issue操作をしない）
npm run breed             # 配合ワーカーを本番同様に実行（Cloudflare認証情報が必要）
npm run breed:check-ai    # Cloudflare Workers AI の接続確認のみ（1回）
npm run screenshot      # 両テーマ×デスクトップ/詳細/モバイル + /ideas一覧のスクリーンショット（tmp/）
```

## ディレクトリ

```text
.
├── AGENTS.md            # プロジェクト規約（最初に読む）
├── DESIGN.md            # デザイン規約（16bit配合研究所）
├── README.md
├── public/              # 公開サイト一式（Viteのroot。ページ・UI・静的ファイル）
│   ├── index.html       # / トップ（配合研究所）
│   ├── main.ts          # トップのUI（vanilla TS）
│   ├── character.ts     # 博士キャラクター表示（状態・スプライト・読み上げ制御）
│   ├── breeding-state.ts # 配合状態判定（申請確認/実験待ち/生成中/誕生の純関数）
│   ├── github-watch.ts  # 匿名GitHub APIポーリング（上限・停止条件つき）
│   ├── ideas.ts         # /ideas 一覧ページのUI
│   ├── ideas/           # /ideas アイデア一覧（マルチページエントリ）
│   ├── idea.ts          # /ideas/<id>/ 個別詳細ページのUI（issue #24）
│   ├── idea/            # 個別ページのテンプレート（ビルド時に各IDへコピー）
│   ├── 404.html         # カスタム404（未知パス・存在しない発明ID / issue #24）
│   ├── style.css        # 16bit 配合研究所テーマ
│   ├── assets/          # ビルド取り込み対象（博士スプライト8枚 透過PNG 135×268）
│   └── static/          # そのまま配信する生ファイル（dist直下へコピー）
│       └── sprites/     # ピクセル絵素材の原本（切り出し元）
├── lib/                 # 型・Issueパーサー・世代計算・候補選出・頻度設定(schedule.ts) /
                         # 配合: blend.ts（プロンプトと出力検証）/ elements.ts（要素抽出とキャッシュ） /
                         # queue.ts（キュー選択）/ cloudflare.ts（Workers AI）/ usage.ts（利用量）/
                         # github.ts（Issue対応）/ ProtoPedia/設定（フロント/ワーカー共有）
├── config/              # schedule.json（頻度設定: 候補更新間隔・配合間隔・候補件数 / issue #15）
├── data/                # offspring.json / current-candidates.json / breeding-state.json /
                         # element-cache.json / processed-issues.json / ai-usage.json / *sample*.json
├── logs/                # 開発ログ（public公開のため秘密情報は書かない / 書式は logs/README.md）
├── scripts/             # process-breeding（配合ワーカー）/ fetch-sample / rotate-candidates / sync /
                         # validate-data / screenshot / gh / load-env / slice-characters（博士スプライト切り出し）
├── tests/
└── .github/workflows/   # deploy.yml / sync-prototypes.yml（dispatchのみ） /
                         # rotate-candidates.yml（起床15分固定・間隔はconfig判定） / breed.yml（配合ワーカー）
```
