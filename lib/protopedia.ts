/**
 * ProtoPedia API v2 アダプター（docs/protopediaapi.md 準拠）。
 *
 * セキュリティ方針:
 * - APIトークンはサーバー側（GitHub Actions / ローカルCLI）専用。
 *   このモジュールをブラウザから呼び出さない（フロントは data/prototypes.json を読むだけ）。
 * - APIレスポンスはすべて外部入力。パース・型検証・HTML除去・URL検証を通す。
 * - エラーメッセージにトークンやレスポンス本文を含めない。
 * - リトライは1ページにつき最大1回。無限リトライはしない。
 * - ページ数・総件数に上限を設ける（レート制限・暴走防止）。
 *
 * 実接続で確認済み（2026-11）:
 * - レスポンス形状は `{metadata, count, links, results}`。count はページ内件数（総数ではない）。
 * - 件数外の offset は HTTP 200 + count:0 で results キー自体が無い（=空ページ）。
 * - users / tags は "|"-区切り文字列。作者は "名前@ユーザーID" 形式。
 * - licenseType は数値enum（観測値は 1 のみ = 作品ページ表示「CC BY 4+」）。
 * - 作品ページURLは `https://protopedia.net/prototype/<id>`（id=1 のページとAPI一致を確認）。
 * - カタログ総数は 5,100件超（offset=5000 で100件 / offset=9990 で0件）。
 *
 * 未検証事項（docs/protopediaapi.md §11）:
 * - releaseFlg の実値の意味（観測値は常に 2。0/1 の意味は不明）。
 * - レート制限の実値。ページ間隔を既定100msで空けて対応。
 */
import { renameSync, writeFileSync } from 'node:fs';
import type { ProtopediaWork, Workset } from './types.ts';

export const PROTOPEDIA_API_BASE = 'https://protopedia.net/v2/api';
export const PROTOPEDIA_SITE_BASE = 'https://protopedia.net';

/** 取得上限（デフォルト）。必要なら呼び出し側で変える。
 * 実測でカタログ総数は 5,100件超（offset=5000 で100件、offset=9990 で0件）。
 * 10,000 でも超える場合は fetchAllWorks の truncated が立つので同期ログで確認する。 */
export const DEFAULT_MAX_WORKS = 10_000;
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 1;
/** レート制限に配慮したページ間の待機（実測の上限は未確認のため控えめに空ける）。 */
export const DEFAULT_PAGE_DELAY_MS = 100;

// フィールド長の上限（実APIの上限は未確認のためこちらで強制する）
const CAP_TITLE = 200;
const CAP_SUMMARY = 600;
const CAP_LONG_TEXT = 2000; // 詳細説明・技術構成（約2,000文字の利用報告あり）
const CAP_URL = 2000;
const CAP_LICENSE = 80;
const MAX_AUTHORS = 10;
const MAX_TAGS = 20;
const CAP_NAME = 80;

const PRIVATE_FLAGS = new Set(['n', 'no', 'false', '0', 'private', 'draft']);

// ---------------------------------------------------------------------------
// テキストのサニタイズ
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function codePointSafe(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * 文字列をプレーンテキスト化する: HTMLタグ除去 → 文字参照デコード →
 * 空白圧縮 → 長さ制限（末尾に …）。
 * 非文字列は空文字（フィールド欠損はエラーにせず空で扱う）。
 */
export function stripToText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  let s = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => codePointSafe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => codePointSafe(parseInt(d, 10)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    // タグ除去で漢字・かなが空白で隔てられないようにする（日本語は単語間空白を使わない）
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      '$1',
    )
    .trim();
  const chars = [...s];
  if (chars.length > maxLen) s = `${chars.slice(0, maxLen).join('').trimEnd()}…`;
  return s;
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

function toIdNumber(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d{1,9}$/.test(v.trim())) n = Number(v.trim());
  else return null;
  if (!Number.isInteger(n) || n <= 0 || n > 999_999_999) return null;
  return n;
}

/**
 * licenseType のラベル対応表。
 * 実API（2026-11実測）では数値enumで、観測された値は 1 だけ。
 * 1 は作品ページ id=1 の表示「CC BY 4+」と照合済み。未知の数値は捏造せず未保存。
 */
const LICENSE_LABELS: Record<number, string> = { 1: 'CC BY 4+' };

/**
 * 制作状態（供養/開発中/完成）コードの抽出。
 * 実APIは数値で返すが、文字列で返る版にも備えて整数化してから判定する。
 * 1..99 の整数以外（null・欠損・想定外の型）は保存しない＝表示もされない。
 */
function toStatusCode(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 99) return undefined;
  return n;
}

/**
 * releaseFlg の公開判定。
 * 仕様書に値の定義がないため: 欠損は公開として扱う（要実測確認）、
 * 明示的な非公開値のみ除外する。
 */
export function isPublicRelease(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !PRIVATE_FLAGS.has(String(v).trim().toLowerCase());
}

function isAllowedHttpUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > CAP_URL) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 出典URL: レスポンス内の protopedia.net のURLを使う。無ければ組み立てる。 */
function resolveSourceUrl(raw: Record<string, unknown>, idNum: number): string {
  for (const key of ['prototypeUrl', 'sourceUrl', 'url', 'link']) {
    const candidate = isAllowedHttpUrl(raw[key]);
    if (!candidate) continue;
    try {
      const host = new URL(candidate).hostname;
      if (host === 'protopedia.net' || host.endsWith('.protopedia.net')) return candidate;
    } catch {
      /* fall through */
    }
  }
  // 作品ページURLの実パス。実接続で確認済み（id=1 のページとAPIの作品が一致）。
  return `${PROTOPEDIA_SITE_BASE}/prototype/${String(idNum)}`;
}

function toTextList(
  value: unknown,
  keys: string[],
  maxItems: number,
  maxLen: number,
): string[] {
  // 実API（2026-11実測）では users/tags は "|"-区切りの文字列
  // （例 "作者A@12|作者B@34", "タグ1|タグ2"）。配列形式は仕様書の想定なので両対応。
  const list: unknown[] =
    typeof value === 'string'
      ? value
          .split('|')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : Array.isArray(value)
        ? value
        : [];
  const out: string[] = [];
  for (const item of list) {
    if (out.length >= maxItems) break;
    let t = '';
    if (typeof item === 'string') {
      t = stripToText(item, maxLen);
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      for (const k of keys) {
        const v = o[k];
        if (typeof v === 'string' && v.length > 0) {
          t = stripToText(v, maxLen);
          break;
        }
      }
    }
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * APIレスポンスの1件を ProtopediaWork へ正規化する。
 * 検証に通らない入力（IDなし・作品名なし・非公開）は null を返し、
 * 壊れたレコードで既存データを汚さない。
 */
export function normalizeWork(raw: unknown): ProtopediaWork | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (!isPublicRelease(r.releaseFlg)) return null;
  const idNum = toIdNumber(r.id ?? r.prototypeId);
  if (idNum === null) return null;
  const title = stripToText(r.prototypeNm ?? r.title, CAP_TITLE);
  if (!title) return null;

  const summary =
    stripToText(r.summary, CAP_SUMMARY) || stripToText(r.freeComment, CAP_SUMMARY);

  const work: ProtopediaWork = {
    id: `protopedia:${idNum}`,
    title,
    sourceUrl: resolveSourceUrl(r, idNum),
    summary,
    generation: 0,
  };

  const mainUrl = isAllowedHttpUrl(r.mainUrl);
  if (mainUrl) work.mainUrl = mainUrl;

  // 作者は実APIで "|"-区切りの "表示名@ユーザーID" 形式
  // （例 "ひさやん@hisayan"。表示名が空なら "@handle" のみ）。
  // クレジット表示に使うためハンドルは情報なので原文のまま保持する。
  const authors = toTextList(
    r.users,
    ['userNm', 'userName', 'nm', 'name'],
    MAX_AUTHORS,
    CAP_NAME,
  )
    .map((a) => a.trim())
    .filter((a, i, arr) => a.length > 0 && arr.indexOf(a) === i);
  if (authors.length > 0) work.authors = authors;

  const tags = toTextList(r.tags, ['tagNm', 'tagName', 'nm', 'name'], MAX_TAGS, CAP_NAME);
  if (tags.length > 0) work.tags = tags;

  // 制作状態（供養/開発中/完成）。タグではなく status 数値で返る（2026-11-10 実測、
  // tagNm=供養 では0件）。ラベル対応は lib/types.ts の PROTOPEDIA_STATUS_LABELS。
  const status = toStatusCode(r.status);
  if (status !== undefined) work.status = status;

  const license =
    typeof r.licenseType === 'number'
      ? (LICENSE_LABELS[r.licenseType] ?? '')
      : stripToText(r.licenseType, CAP_LICENSE);
  if (license) work.licenseType = license;

  const system = stripToText(r.systemDescription, CAP_LONG_TEXT);
  if (system) work.systemDescription = system;

  // freeComment（詳細説明）は保存しない（仕様書§7「詳細説明を無制限に保存せず」）。
  // summary が空のときだけ冒頭を概要として使う（上の summary で処理済み）。
  // 配合時に入力が必要な場合はワーカーが prototypeId でAPIから直接取得する（§6.2）。

  return work;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(
  url: string,
  token: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    // ステータスのみ報告（本文・ヘッダはログに出さない）
    if (!res.ok) throw new Error(`ProtoPedia API: HTTP ${res.status} (${new URL(url).pathname})`);
    try {
      return await res.json();
    } catch {
      throw new Error('ProtoPedia API: JSONとして読めないレスポンス');
    }
  } finally {
    clearTimeout(timer);
  }
}

/** レスポンス本体から配列を探す（実測形状に確定: `{metadata, count, links, results}`）。 */
function extractResults(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['results', 'items', 'data', 'list']) {
      const v = b[key];
      if (Array.isArray(v)) return v;
    }
    // 実測（2026-11）: カタログ件数を超える offset では HTTP 200 + count:0 で
    // results キー自体が返らない。これは「最終ページの直後」= 正常な空ページなので、
    // 例外にせず空配列として扱いページングを終了させる。
    if (b.count === 0) return [];
  }
  return null;
}

export interface FetchAllOptions {
  token: string;
  pageSize?: number;
  maxWorks?: number;
  /** ページ単位の再試行回数（既定1回。0で無効） */
  retries?: number;
  timeoutMs?: number;
  /** ページ間の待機ms（既定100。テストでは0にできる） */
  pageDelayMs?: number;
  /** 取得ページ数の上限（未指定/0 = 上限なし。試作取得での暴走防止に使う） */
  maxPages?: number;
  /** 最初のオフセット（既定0。試作取得で対象範囲をずらすとき用） */
  offsetStart?: number;
  /**
   * 制作状態コードで絞り込む（2=開発中 / 3=完成 / 4=供養）。
   * API の `status` クエリ（数値のみ。文字列は HTTP 500 / 2026-11-10実測）。
   * 未指定なら全状態を対象にする。
   */
  status?: number;
  fetchImpl?: FetchImpl;
}

export interface FetchAllResult {
  works: ProtopediaWork[];
  pages: number;
  /** 正規化で落ちた件数（非公開・不正レコード） */
  dropped: number;
  /** 同一IDの重複レコード（offset無視等のサーバ側事故を想定） */
  duplicates: number;
  /** 上限に達して打ち切ったか */
  truncated: boolean;
}

/**
 * /prototype/list を limit/offset で順次取得し、正規化してまとめる。
 * 1ページ失敗時は最大1回だけ再試行し、それでも失敗したら例外を投げる
 * （呼び出し側は既存データを保持する）。
 */
export async function fetchAllWorks(opts: FetchAllOptions): Promise<FetchAllResult> {
  const {
    token,
    pageSize = DEFAULT_PAGE_SIZE,
    maxWorks = DEFAULT_MAX_WORKS,
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pageDelayMs = DEFAULT_PAGE_DELAY_MS,
    maxPages = 0,
    offsetStart = 0,
    status,
    fetchImpl = fetch,
  } = opts;

  if (!token) throw new Error('APIトークンが設定されていません（PROTOPEDIA_API_V2_TOKEN）');
  if (status !== undefined && (!Number.isInteger(status) || status < 1 || status > 99)) {
    throw new Error('status は 1..99 の整数で指定してください（欠損時は指定しない）');
  }
  const statusQuery = status === undefined ? '' : `&status=${status}`;

  const works: ProtopediaWork[] = [];
  const seenIds = new Set<string>();
  let pages = 0;
  let dropped = 0;
  let duplicates = 0;
  let offset = offsetStart;

  while (works.length < maxWorks && (maxPages <= 0 || pages < maxPages)) {
    if (pages > 0 && pageDelayMs > 0) await sleep(pageDelayMs);
    const limit = Math.min(pageSize, maxWorks - works.length);
    const url = `${PROTOPEDIA_API_BASE}/prototype/list?limit=${limit}&offset=${offset}${statusQuery}`;

    let body: unknown = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        body = await requestJson(url, token, fetchImpl, timeoutMs);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < retries) await sleep(500 * (attempt + 1));
      }
    }
    if (body === null) {
      throw lastError instanceof Error ? lastError : new Error('ProtoPedia API: 取得失敗');
    }

    const rows = extractResults(body);
    if (rows === null) {
      throw new Error('ProtoPedia API: 想定外のレスポンス構造（結果配列が見つかりません）');
    }
    pages += 1;

    let added = 0;
    for (const row of rows) {
      const w = normalizeWork(row);
      if (!w) {
        dropped += 1;
      } else if (seenIds.has(w.id)) {
        duplicates += 1; // 同一IDは1件目だけ採用（offset無視対策）
      } else {
        seenIds.add(w.id);
        works.push(w);
        added += 1;
      }
    }

    if (rows.length < limit) break; // 最終ページ
    if (added === 0 && duplicates > 0) {
      // 進捗ゼロ（同一ページが返り続けている）＝打ち切り。
      // offset無視やAPI事故で無限ループ・レート制限を起こさない。
      break;
    }
    offset += limit;
  }

  const truncated = works.length >= maxWorks;
  return { works, pages, dropped, duplicates, truncated };
}

// ---------------------------------------------------------------------------
// 保存（失敗時に既存データを壊さない）
// ---------------------------------------------------------------------------

export function buildWorkset(works: ProtopediaWork[], source: Workset['source']): Workset {
  return {
    schemaVersion: 1,
    source,
    syncedAt: new Date().toISOString(),
    works,
  };
}

/**
 * data/prototypes.json へ原子的に書き込む。
 * - 0件は拒否（空データで正常データを上書きしないための保険）。
 * - 一時ファイルに書いてからリネーム（書き込み途中の断片で壊れないように）。
 * フェッチ失敗時はこの関数自体を呼ばない = 既存ファイルは無変更のまま残る。
 */
export function writeWorksetAtomic(outPath: string, workset: Workset): void {
  if (!Array.isArray(workset.works) || workset.works.length === 0) {
    throw new Error('作品が0件のため保存しません（既存データを保持します）');
  }
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(workset, null, 2)}\n`, 'utf8');
  renameSync(tmp, outPath);
}
