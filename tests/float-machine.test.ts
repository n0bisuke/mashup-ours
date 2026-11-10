// @vitest-environment happy-dom
/**
 * フローティング配合マシン（issue #26）。
 *
 * - 表示判定 shouldShowFloating: IntersectionObserver のエントリから小型版の表示/非表示を決める
 *   （スクロール高頻度監視をせず、境界 0〜20% は前状態を維持するヒステリシス）
 * - 選択の永続化 serializePicks / parsePicks: 再読み込み後も選択を失わない
 * - DOM 連動: 非表示は inert + aria-hidden、選択と連動、「配合へ進む」は既存申請フローへ移動するだけ
 *
 * ※ 選択状態そのもの（pickA / pickB）の単位テストは ui.test.ts 側。
 *   ここでは「小型版が同じ状態を映すか」「二重管理していないか」を見る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLOAT_HIDE_RATIO,
  PICKS_KEY,
  floatCountLabel,
  parsePicks,
  serializePicks,
  shouldShowFloating,
} from '../public/floating.ts';
import { installMemoryStorage } from './helpers/memory-storage.ts';

// --- 純関数（DOM なし） -----------------------------------------------------

describe('shouldShowFloating（表示判定 + ヒステリシス）', () => {
  const entry = (isIntersecting: boolean, intersectionRatio: number) => ({
    isIntersecting,
    intersectionRatio,
  });

  it('FVの大きなマシンが完全に画面外 → 小型版を表示', () => {
    expect(shouldShowFloating(false, entry(false, 0))).toBe(true);
    expect(shouldShowFloating(true, entry(false, 0))).toBe(true);
  });

  it('20%以上画面内 → 非表示（両方とも同時に表示しない）', () => {
    expect(shouldShowFloating(false, entry(true, FLOAT_HIDE_RATIO))).toBe(false);
    expect(shouldShowFloating(true, entry(true, 0.5))).toBe(false);
    expect(shouldShowFloating(true, entry(true, 1))).toBe(false);
  });

  it('境界帯（0〜20%）は前状態を維持する → 境界でちらつかせない', () => {
    expect(shouldShowFloating(true, entry(true, 0.1))).toBe(true); // 表示中は表示のまま
    expect(shouldShowFloating(false, entry(true, 0.1))).toBe(false); // 非表示中は非表示のまま
    expect(shouldShowFloating(true, entry(true, 0.19))).toBe(true);
  });

  it('境界の 0.2 ちょうどは非表示側に倒す（片側に寄せて振動を防ぐ）', () => {
    expect(shouldShowFloating(true, entry(true, 0.2))).toBe(false);
    expect(shouldShowFloating(false, entry(true, 0.2))).toBe(false);
  });
});

describe('floatCountLabel（色だけに依存しない選択数）', () => {
  it('0/2・1/2/2/2 を返す', () => {
    expect(floatCountLabel(0)).toBe('0/2');
    expect(floatCountLabel(1)).toBe('1/2');
    expect(floatCountLabel(2)).toBe('2/2');
  });

  it('範囲外は 0/2・2/2 に丸める', () => {
    expect(floatCountLabel(-1)).toBe('0/2');
    expect(floatCountLabel(3)).toBe('2/2');
    expect(floatCountLabel(1.4)).toBe('1/2');
    expect(floatCountLabel(1.6)).toBe('2/2');
  });
});

describe('serializePicks / parsePicks（保存書式と復元検証）', () => {
  const pickable = (id: string) => id === 'protopedia:1' || id === 'protopedia:2';

  it('両方 null なら保存値なし（キーごと消すため）', () => {
    expect(serializePicks(null, null)).toBeNull();
  });

  it('保存 → 復元で選択がそのまま戻る', () => {
    const s = serializePicks('protopedia:1', 'protopedia:2');
    expect(s).toContain('"v":1');
    expect(parsePicks(s, pickable)).toEqual({ a: 'protopedia:1', b: 'protopedia:2' });
  });

  it('片方だけの選択も戻る', () => {
    const s = serializePicks('protopedia:1', null);
    expect(parsePicks(s, pickable)).toEqual({ a: 'protopedia:1', b: null });
  });

  it('壊れたJSON・型違いは選択を作らない', () => {
    expect(parsePicks('{broken', pickable)).toEqual({ a: null, b: null });
    expect(parsePicks('null', pickable)).toEqual({ a: null, b: null });
    expect(parsePicks('[]', pickable)).toEqual({ a: null, b: null });
    expect(parsePicks('"protopedia:1"', pickable)).toEqual({ a: null, b: null });
    expect(parsePicks('', pickable)).toEqual({ a: null, b: null });
    expect(parsePicks(undefined, pickable)).toEqual({ a: null, b: null });
    expect(parsePicks(42, pickable)).toEqual({ a: null, b: null });
    expect(parsePicks(JSON.stringify({ v: 1, a: 123, b: null }), pickable)).toEqual({
      a: null,
      b: null,
    });
  });

  it('存在しない候補・子作品のIDは復元しない', () => {
    expect(parsePicks(JSON.stringify({ v: 1, a: 'protopedia:999', b: null }), pickable)).toEqual({
      a: null,
      b: null,
    });
  });

  it('同じ作品をAとBに同時にしない（既存ルール。Bを捨てる）', () => {
    expect(parsePicks(JSON.stringify({ v: 1, a: 'protopedia:1', b: 'protopedia:1' }), pickable)).toEqual(
      { a: 'protopedia:1', b: null },
    );
  });

  it('異常に長いIDは復元しない（保存値の汚れた入力対策）', () => {
    const long = `protopedia:${'1'.repeat(200)}`;
    expect(parsePicks(JSON.stringify({ v: 1, a: long, b: null }), pickable)).toEqual({
      a: null,
      b: null,
    });
  });
});

// --- DOM 連動（main.ts の実行） ---------------------------------------------

/** IntersectionObserver の代わりにコールバックを手で叩くスタブ。 */
class CaptureIO {
  static instances: CaptureIO[] = [];
  observed: unknown[] = [];
  constructor(
    private readonly cb: (entries: unknown[]) => void,
    readonly options: unknown,
  ) {
    CaptureIO.instances.push(this);
  }
  observe(target: unknown): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}

  /** 実際に観測している要素の class 名（fvScene だけを観測しているかの確認用）。 */
  observedClasses(): string[] {
    return this.observed
      .filter((t): t is Element => typeof t === 'object' && t !== null && 'className' in t)
      .map((t) => String((t as Element).className));
  }

  fire(isIntersecting: boolean, intersectionRatio: number): void {
    this.cb([{ isIntersecting, intersectionRatio }]);
  }
}

const floatEl = () => document.querySelector<HTMLElement>('.float-machine');
const floatCount = () => document.querySelector<HTMLElement>('.float-count');
const floatNames = () => Array.from(document.querySelectorAll<HTMLElement>('.float-name'));
const floatGo = () => document.querySelector<HTMLButtonElement>('.float-go');
const floatDevice = () => document.querySelector<HTMLElement>('.float-device');
const io = () => CaptureIO.instances[CaptureIO.instances.length - 1];

/**
 * main.ts を（再）実行する。
 * @param freshStorage true（既定）= 空のストレージから開始 / false = 保存値を残したまま再読み込み
 */
async function boot({ freshStorage = true }: { freshStorage?: boolean } = {}) {
  vi.resetModules();
  // この環境の localStorage は未使用のためメモリ実装を差し込む（tests/helpers/memory-storage.ts）
  if (freshStorage) installMemoryStorage();
  document.documentElement.classList.remove('has-float');
  document.body.innerHTML = '<div id="app"></div>';
  CaptureIO.instances = [];
  await import('../public/main.ts');
}

const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.candidate'));
const pickBtn = (cardIdx: number, slot: 'a' | 'b') =>
  cards()[cardIdx].querySelectorAll<HTMLButtonElement>('button.pick')[slot === 'a' ? 0 : 1];
/** カード見出しの作品名（選択中バッジ「親A選択中」を含まない）。 */
const cardTitle = (cardIdx: number): string =>
  cards()[cardIdx].querySelector('h3')?.firstChild?.textContent ?? '';

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', CaptureIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('表示の出し入れ（IntersectionObserver / §6）', () => {
  it('初期は非表示・inert・aria-hidden（フォーカスも読み上げも対象外）', async () => {
    await boot();
    const f = floatEl();
    expect(f).not.toBeNull();
    expect(f?.classList.contains('is-visible')).toBe(false);
    expect(f?.hasAttribute('inert')).toBe(true);
    expect(f?.getAttribute('aria-hidden')).toBe('true');
    expect(document.documentElement.classList.contains('has-float')).toBe(false);
  });

  it('FVの lab-scene だけを threshold 付きで観測する（スクロール監視はしない）', async () => {
    await boot();
    expect(CaptureIO.instances.length).toBe(1);
    const obs = io();
    expect(obs.observedClasses()).toEqual(['lab-scene']);
    expect(obs.options).toMatchObject({
      threshold: [0, 0.1, 0.2, 0.3, 0.5, 0.9, 1],
    });
  });

  it('大きなマシンが画面外になると表示され、inert/aria-hiddenが外れる', async () => {
    await boot();
    io().fire(false, 0);
    const f = floatEl();
    expect(f?.classList.contains('is-visible')).toBe(true);
    expect(f?.hasAttribute('inert')).toBe(false);
    expect(f?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.documentElement.classList.contains('has-float')).toBe(true);
  });

  it('大きなマシンが画面内に戻ったら非表示（同時に表示しない）', async () => {
    await boot();
    io().fire(false, 0);
    io().fire(true, 0.4);
    const f = floatEl();
    expect(f?.classList.contains('is-visible')).toBe(false);
    expect(f?.hasAttribute('inert')).toBe(true);
    expect(f?.getAttribute('aria-hidden')).toBe('true');
    expect(document.documentElement.classList.contains('has-float')).toBe(false);
  });

  it('境界帯（0.1）では前状態のまま（ちらつかせない）', async () => {
    await boot();
    io().fire(true, 0.1); // 初期は非表示 → 非表示のまま
    expect(floatEl()?.classList.contains('is-visible')).toBe(false);
    io().fire(false, 0); // 表示
    expect(floatEl()?.classList.contains('is-visible')).toBe(true);
    io().fire(true, 0.1); // 帯に突入しても表示のまま
    expect(floatEl()?.classList.contains('is-visible')).toBe(true);
    io().fire(true, 0.3); // 20%を超えたら非表示
    expect(floatEl()?.classList.contains('is-visible')).toBe(false);
  });
});

describe('選択との連動（単一データソースを映すだけ）', () => {
  it('未選択は 0/2・「？」・ボタン無効', async () => {
    await boot();
    expect(floatCount()?.textContent).toBe('0/2');
    expect(floatNames().map((n) => n.textContent)).toEqual(['親A 未選択', '親B 未選択']);
    expect(floatGo()?.disabled).toBe(true);
    expect(floatDevice()?.textContent).toBe('×');
    expect(floatDevice()?.classList.contains('is-ready')).toBe(false);
  });

  it('1選択で 1/2 と作品名、まだボタンは無効', async () => {
    await boot();
    pickBtn(0, 'a').click();
    expect(floatCount()?.textContent).toBe('1/2');
    expect(floatNames()[0].textContent).toBe(cardTitle(0));
    expect(floatNames()[1].textContent).toBe('親B 未選択');
    expect(floatGo()?.disabled).toBe(true);
    expect(document.querySelector('.status-val')?.textContent).toContain('protopedia:');
  });

  it('2選択で 2/2・ボタン有効・装置が準備完了（▶）', async () => {
    await boot();
    pickBtn(0, 'a').click();
    pickBtn(1, 'b').click();
    expect(floatCount()?.textContent).toBe('2/2');
    expect(floatCount()?.classList.contains('is-full')).toBe(true);
    expect(floatGo()?.disabled).toBe(false);
    expect(floatDevice()?.textContent).toBe('▶');
    expect(floatDevice()?.classList.contains('is-ready')).toBe(true);
  });

  it('同じ作品をAとBにしない（既存ルールのまま小型版にも反映）', async () => {
    await boot();
    pickBtn(0, 'a').click();
    pickBtn(0, 'b').click(); // 同じ作品 → B は外れる
    expect(floatCount()?.textContent).toBe('1/2');
    expect(floatGo()?.disabled).toBe(true);
  });

  it('選択を解除すると 0/2 に戻り、保存値も消える', async () => {
    await boot();
    pickBtn(0, 'a').click();
    pickBtn(0, 'a').click();
    expect(floatCount()?.textContent).toBe('0/2');
    expect(localStorage.getItem(PICKS_KEY)).toBeNull();
  });
});

describe('「配合へ進む」は既存の申請フローへ（§5）', () => {
  it('Issue作成画面を開かず、本体の申込ボタンへスクロールしてフォーカスを渡す', async () => {
    await boot();
    pickBtn(0, 'a').click();
    pickBtn(1, 'b').click();

    const open = vi.spyOn(window, 'open');
    floatGo()?.click();

    expect(open).not.toHaveBeenCalled(); // 小型版単独ではIssueを作らない
    expect(document.activeElement).toBe(document.querySelector('button.breed'));
    // 本体のボタンは有効なまま（= 既存フローが生きている）
    expect((document.querySelector('button.breed') as HTMLButtonElement).disabled).toBe(false);
  });

  it('未選択のときはボタンが無効で何も起きない', async () => {
    await boot();
    const open = vi.spyOn(window, 'open');
    floatGo()?.click();
    expect(open).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(document.querySelector('button.breed'));
  });
});

describe('選択の永続化（§2: 再読み込みで失わない）', () => {
  it('2選択して読み込み直すと選択と小型版がそのまま復元する', async () => {
    await boot();
    pickBtn(0, 'a').click();
    pickBtn(1, 'b').click();
    expect(localStorage.getItem(PICKS_KEY)).toContain('"v":1');

    await boot({ freshStorage: false }); // 再読み込み（保存値は残す）
    expect(floatCount()?.textContent).toBe('2/2');
    expect(floatNames()[0].textContent).toBe(cardTitle(0));
    expect(document.querySelectorAll('.candidate.is-a').length).toBe(1);
    expect(document.querySelectorAll('.candidate.is-b').length).toBe(1);
    expect((document.querySelector('button.breed') as HTMLButtonElement).disabled).toBe(false);
  });

  it('再読み込み後も選択とカプセルの画像が復元する（issue #39）', async () => {
    await boot();
    const childIdx = cards().findIndex((c) => c.dataset.id?.startsWith('mashup-'));
    const protoIdx = cards().findIndex((c) => c.dataset.id?.startsWith('protopedia:'));
    if (childIdx < 0 || protoIdx < 0) return; // 画像付き候補が揃わない枠は検証省略
    pickBtn(protoIdx, 'a').click();
    pickBtn(childIdx, 'b').click();
    const fvA = document.querySelector('.capsule-a .capsule-view img')?.getAttribute('src');
    const fvB = document.querySelector('.capsule-b .capsule-view img')?.getAttribute('src');
    expect(fvA).toBeTruthy(); // ProtoPediaの作品画像
    expect(fvB).toBeTruthy(); // AI生成の生成画像（修正前は「？」で img が無い）

    await boot({ freshStorage: false }); // 再読み込み（保存値は残す）
    expect(document.querySelector('.capsule-a .capsule-view img')?.getAttribute('src')).toBe(fvA);
    expect(document.querySelector('.capsule-b .capsule-view img')?.getAttribute('src')).toBe(fvB);
    // 小型配合マシンも同じ画像
    const floats = document.querySelectorAll('.float-slot .float-thumb img');
    expect(floats[0]?.getAttribute('src')).toBe(fvA);
    expect(floats[1]?.getAttribute('src')).toBe(fvB);
  });

  it('候補が入れ替わって存在しないIDは復元しない', async () => {
    await boot();
    localStorage.setItem(
      PICKS_KEY,
      JSON.stringify({ v: 1, a: 'protopedia:999999', b: null }),
    );
    await boot({ freshStorage: false });
    expect(floatCount()?.textContent).toBe('0/2');
    expect(localStorage.getItem(PICKS_KEY)).toBeNull(); // 選択肢なし＝保存も残さない
  });

  it('壊れた保存値でも画面は壊れず 0/2 で始まる', async () => {
    await boot();
    localStorage.setItem(PICKS_KEY, '{{{not json');
    await boot({ freshStorage: false });
    expect(floatCount()?.textContent).toBe('0/2');
    expect(document.querySelectorAll('.candidate').length).toBeGreaterThan(0);
  });
});
