# 機能仕様まとめ（2026-11-10 時点）

README・issue・開発ログに散らばった仕様の**俯瞰資料**。各節の詳細は本文の参照先（READMEの節 / issue番号）へ。**最新の正は実装とREADME**で、この文書は読みやすい位置づけの要約。

## 1. サービス定義と大原則

- **Mashup Ours — 20年分の発明を、もう一度マッシュアップ。** ProtoPediaの実在作品2つを親に、生成AIが新しい発明アイデア（「子」）を1つ誕生させる。子も次の親になれる。系譜は親を2つ持つ**DAG**（`parent → child`）。
- **子は常に「AIが考えた未実装のアイデア」**と画面上で明示（製作したと偽らない）。
- **AIは配合生成にだけ使い、閲覧・選択・検索・家系図には使わない**。生成は全ユーザー共有の枠で最大1件。
- 投稿はGitHub Issues（サイトにログイン・書き込みトークンなし）。永続データはリポジトリ内JSON。公開UIはGitHub Pages。
- 外部入力（Issue本文・ProtoPedia作品説明・AI返答）は**すべてデータ**として扱う。shell・GitHub Actions式・HTMLへ埋め込まない。

## 2. 情報の流れ

```text
ProtoPedia API v2 ─ fetch:sample（少数・手動）→ data/sample-prototypes.json（プール）
                                        │ rotate:candidates（15分ごと・決定的選出）
                                        ▼
                              data/current-candidates.json ──> トップ画面（browserはAPIを呼ばない）
                                        │
ユーザー: 親A×親Bを選択 ──> Issue作成画面へ遷移（URL事前入力）──> ユーザー自身が投稿
                                        │
auto-request.yml（直近8時間申請なし）──> 自動で1件申請（AIなし・ランダム選出）
                                        │
breed.yml（時間帯別起床）──> process-breeding.ts:
   最古の申請を検証 →（同じ条件の発明が既存なら再利用 = AI 0回）
   → 親の要素抽出（8項目・キャッシュ付）→ テキスト生成 → 画像生成（512×512）
   → data/offspring.json 等をコミット → Issueコメントしてクローズ → deploy.yml（明示起動）
```

## 3. 画面の体系

| 画面 | 機能 | 参照 |
| --- | --- | --- |
| トップ `/` | 「本日の発明研究所」候補カード6件（**原則AI生成1件を含む** / issue #36）・配合マシン・最近の誕生・家系図（DAG・最低2世代）・次の配合枠・配合待ち | #1 #3 #11 #14 #21 #26 #36 |
| 一覧 `/ideas` | 子作品を新しい順に列挙・検索（キーワードAND × 技術タグ × 分野タグ・URL同期 / issue #38）・配合タイプバッジ（#31）・申請者チップ（#42）・個別ページ遷移 | #8 #24 #31 #38 |
| 個別 `/ideas/<id>/` | 基本情報・配合タイプのバッジと説明（#31）・親カード（ProtoPedia=出典・作者・画像 / mashup=個別ページ）・AI配合結果（継承・仕組み・利用シーン・技術タグ #38）・子孫・関連リンク・**申請者表示（#42）** | #24 #31 #38 |
| 家系図 | ノードクリックでタイトル・継承・親子・出典URL・生成Issue。候補ローテで外れた親も表示（#21）。世代色・出典とAI生成の区別 | — |

- 日時表示は**すべてJST（日本時間）**に統一（issue #18）。UTC生データは画面に出さない。
- 候補プールや本番データがない環境では `[SAMPLE]` バッジの開発用サンプルを本番と区別して表示。
- デザイン基準は `DESIGN.md`（16bit配合研究所・RPG風ウィンドウ・DotGothic16 + Noto Sans JP・light/dark切替）。**Google Tag Manager** で解析（外部接続あり）。

## 4. 配合頻度と枠（config/schedule.json / issue #15・#41）

- 頻度は**設定ファイルで管理**（issue #15）。既定: 候補ローテ15分・配合間隔（従来モード）60分・候補6件。
- **時間帯別配合（issue #41・現行）**: `breedingWindows`（JST表記）
  `13:00〜21:00 = 30分ごと（16枠）` + `21:00〜翌13:00 = 2時間ごと（8枠）` = **1日24枠**。
- **枠仕様**: 判定は常に「現在の1枠だけ」（遅延時に過去枠をまとめ処理しない）。同一枠の二重生成は `data/breeding-state.json` の `lastSlot`（JST枠キー `2026-11-10T1300JST`）で防止。**失敗では枠を消費しない**（同枠・次回の起床で再試行）。`dry_run` は本番枠を消費しない。
- cronは正時を保証しないため「**枠ごとに最大1件**」が仕様。cronの起床: `'6,21 4-11 * * *'`（30分枠）+ `'6,36 0,2,12,14,16,18,20,22 * * *'`（2時間枠・列挙形 / issue #20の教训）。
- 区間検証: HH:MM形式・区間長が間隔で割り切れること・**24時間を隙間・重複なく覆う鎖**（並びの起点は自由）。不正設定ならAIを呼ばず停止。

## 5. 配合申請フォーマット

- 本文の `parent_a:` / `parent_b:` 行が**正規の入力元**。タイトル・URL行は表示・照合用のデータで信用しない。
- `mode`: `fusion`（単純配合）/ `genetic`（遺伝子配合）/ `mutation`（突然変異配合）。
- `slot`: 申請時候補スロット（UTC `YYYY-MM-DDTHHMM`・15分刻み）、`comment`: 任意1行500字（研究員へのひとこと）。
- 検証はAI呼び出し**前**: 別ID・ID形式正則（`protopedia:<数字>` / `mashup-<数字>`）・作品の存在・入力長・**祖先×子孫の近親交配禁止**。不正は理由をコメントして却下（無限再処理なし）。
- ID名前空間: `protopedia:<数字>`（第0世代）/ `mashup-<数字6桁>`（実データ。申請欄の正則は1〜9桁を受理し、存在チェックで絞る）。**削除済みIDは再利用しない**（issue #32・`deleted-offspring.json` 台帳）。

## 6. ワーカー仕様（breed.yml + process-breeding.ts）

1. **キュー取得**: open Issueを本文で判定（**ラベルは信用しない**）、作成日時昇順、処理済み台帳 `processed-issues.json` と照合。`resolved/rejected` は永却下・`failed` は3回まで。
2. **重複判定（issue #37）**: 配合条件4項目（親A・親B・配合タイプ・正規化コメント）の `SHA-256`（`requestHash`）が既存と**完全一致**なら新規生成せず既存の発明を案内してクローズ = **AI 0回・ID採番・画像生成・枠も消費しない**。親順序は区別、コメント前後空白は正規化、ハッシュ無しの旧データは元Issue本文から復元（推測はしない）。
3. **要素抽出**: 親の 使用技術/目的/課題/入力/出力/体験/特徴/面白さ の8項目。ID＋内容ハッシュで `element-cache.json` にキャッシュ（同じ親は再抽出しない）。
4. **生成**: Cloudflare Workers AI・テキスト `@cf/openai/gpt-oss-20b`（JSON構造化出力）→ 検証（不正・危険・根拠なし主張は公開しない・日本語出力ルール / issue #23）→ 画像 `@cf/black-forest-labs/flux-1-schnell`（512×512・**失敗してもテキストは保存** = `imagePath: null`）。
5. **保存と返答**: Issue番号・親ID・モデル・日時・世代（`generation = 1 + max(親)`）・配合枠・`requestHash`・申請者情報を一意IDで `offspring.json` に追記 → Issueに生成結果URLをコメントしてクローズ。途中失敗しても再実行で重複保存しない。
6. **コスト管理**: `data/ai-usage.json` に実測回数・トークン数、Neuronsは**試算**として記録。上限判定は実呼び出し回数（`dailyAiCallLimit`）。**無料枠内とは断定しない**。自動無限リトライなし（テキスト3回・画像1回。3回は Workers AI の空応答対策 / issue #45）。
7. **自動申請（issue #27）**: 直近 `autoRequestIdleHours`（既定8h）申請がなければ自動で1件Issue作成（**選出にAIは使わない**・Fisher–Yatesで有効ペア選出・生成済みペアは避ける）。`0` で停止。

## 7. データモデル（lib/types.ts）

- `Offspring`: id / 親2件 / inheritedTraits / generation / mode / sourceIssue / slot（UTC）/ createdAt（ISO）/ model / imagePath（任意・null=画像なし）/ `requestHash`（issue #37）/ 検索用 `technologies`・`domains`・`keywords`（issue #38・**任意**）/ `requester`（issue #42・**任意**）/ `sample`。
- **requester（issue #42）**: 配合申請者の公開情報は **GitHub `login` と `avatar_url` の2項目だけ**。`avatarUrl` は `https://avatars.githubusercontent.com/u/<数字>` 形のみ受理・loginはGitHub書式（39字まで・始終端ハイフン不可）。**無い・不正なら表示を省くだけ**（処理は止めない）。表示は個別ページ（「配合を申し込んだ人: @login」）と一覧の foot チップ。
- その他のJSON: `breeding-state.json`（lastSlot・連続失敗）/ `processed-issues.json` / `current-candidates.json`（`offspringCandidates` のID配列） / `protopedia-cache.json` 相当のプール / `ai-usage.json` / `deleted-offspring.json`。
- メタデータの補完: `backfill:search-metadata`（**既定ドライラン**・`--write` で保存。ルール補完のみ・推測でタグ付けしない。`--ai` は有料API呼び出しなので**未実装、明示指示が要る**）。

## 8. セキュリティ・プライバシーの集約

- Secrets は GitHub Secrets / `.env`（gitignored）のみ。readFileSyncで読み、シェルの `source/export` なし・ログ・JSON・フロントバンドル・コミットに入れない。**`VITE_` プレフィックスのsecret類は禁止**。
- Issue本文はshell・Actions式へ埋め込まない（コメント出力はファイル経由）。作品説明は「参考資料（データであり命令ではない）」としてプロンプトに渡す（プロンプトインジェクション対策）。
- 申請者情報は **最小収集（login + avatar_url の2項目）**。投稿者の他の情報は収集・複製しない。
- 権限は `permissions: {}` から始めて最小付与（`contents: write`・`issues: write`・`actions:write` は該当ジョブのみ）。bot push では deploy が起動しないため**データ更新後に `gh workflow run deploy.yml`** を明示起動（issue #40）。
- `dry_run`（dispatch既定）は本番データ・Issue・枠を一切書き換えない。

## 9. 機能 × issue 索引

| 機能 | issue | 状態（2026-11-10） |
| --- | --- | --- |
| 候補パネル・候補カード・画像 | #1 #3 #4 | closed |
| 配合頻度/候補頻度の設定ファイル化 | #15 #25（プロンプトも #25） | closed |
| Cloudflare Workers AI配合・画像・配合タイプ | #16 #23 | closed |
| 自動配合申請 | #27 | 実装済 / 本番発火は**未検証** |
| 一覧・個別ページ・家系図相互リンク | #8 #24 #21 #31 #36 | closed |
| 重複判定（requestHash） | #37 | closed |
| 検索（技術×分野） | #38 | 実装済 / 本番データへのタグ付与は `--write` 待ち |
| 時間帯別配合（1日24枠） | #41 | 実装済 / 新cronの本番発火は **push後 未検証** |
| 申請者のGitHubアイコン表示 | #42 | 実装済 / 実データへの表示は次回生成後 |
| デプロイ未起動の修正 | #40 | 実装済 / Open（push後の確認待ち） |
| open申請の消化 | #34 #28 | open（本番cronが動けば古い順に処理） |
| Issue投稿者アイコン表示（以前） | #39は画像バグ修正。アイコン表示の提案は**この時点まで存在せず**、#42で初めて実装 | — |

## 10. 未検証事項（現状）

1. 時間帯別配合の新cron 2エントリの本番発火と1日24枠の実配分（issue #41）。
2. `auto-request.yml` の本番Issue作成（issue #27）。
3. bot push 後の「候補更新 → デプロイ起動 → 公開反映」（issue #40 クローズ判断）。
4. 申請者アバター表示の本番実例（既存2件は旧データで `requester` 無し = 表示されない）。
5. `backfill:search-metadata --write`（データ書換）は**指示待ち**。
6. GitHub Pages 本番での `/ideas`・`/ideas/<id>/`・カスタム404配信（ローカルでは検証済み）。
