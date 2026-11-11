// @vitest-environment happy-dom
/**
 * 配合申請前の案内ダイアログ（issue #35）。
 * - 指定の吹き出し文言・補足・GitHub側3ステップ（表記違いの注記つき）
 * - 「戻る」/ 背面クリックで閉じ、onOpen は呼ばれない（= 入力を失わない）
 * - 「GitHubで配合を申し込む」だけが onOpen を呼ぶ（Issue作成URL生成は main.ts の既存処理）
 * - 既存スプライトの博士を使う / aria ラベル
 *
 * issue #51（modern-web-guidance「dialog」ガイド準拠）:
 * ネイティブ `<dialog>` + `showModal()` へ移行。Esc・フォーカス包含・ファーカス復帰は
 * ブラウザ実装のためここでは検証しない（自前ハンドラを置かないのがガイドの指示）。
 * happy-dom は showModal を open 属性の付与として実装する。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createApplyGuide,
  GUIDE_LINES,
  GUIDE_NOTE,
  GUIDE_STEPS,
  GUIDE_STEP_NOTE,
} from '../public/apply-guide.ts';

let onOpen: ReturnType<typeof vi.fn>;
let guide: ReturnType<typeof createApplyGuide>;

function dialogEl(): HTMLDialogElement | null {
  return document.querySelector('dialog.guide');
}
/** 背面クリック（closedby 非対応環境のフォールバック経路）をシミュレートする。
 * happy-dom の getBoundingClientRect は全 0 のため、内側=(0,0)・外側=(1,1) で代用。 */
function tapAt(clientX: number, clientY: number): void {
  dialogEl()?.dispatchEvent(
    new PointerEvent('pointerdown', { clientX, clientY, bubbles: true }),
  );
  dialogEl()?.dispatchEvent(
    new PointerEvent('pointerup', { clientX, clientY, bubbles: true }),
  );
}
function click(sel: string): void {
  document.querySelector<HTMLElement>(sel)?.click();
}

beforeEach(() => {
  document.body.innerHTML = '';
  onOpen = vi.fn();
  guide = createApplyGuide(onOpen);
});

afterEach(() => {
  guide.close();
  guide.el.remove();
  document.body.innerHTML = '';
});

it('閉じているときは表示されない（open() で初めて現れる）', () => {
  expect(guide.isOpen()).toBe(false);
  expect(guide.el.open).toBe(false); // ネイティブ <dialog> の open 属性
  expect(guide.el).toBeInstanceOf(HTMLDialogElement);
  expect(document.body.contains(dialogEl())).toBe(true);
  guide.open();
  expect(guide.el.open).toBe(true);
  expect(dialogEl()).toBeTruthy();
});

it('吹き出し文言・補足・3ステップ・ボタンが指定どおり出る', () => {
  guide.open();
  const text = dialogEl()?.textContent ?? '';
  for (const line of GUIDE_LINES) expect(text).toContain(line);
  expect(text).toContain(GUIDE_NOTE);
  expect(GUIDE_STEPS).toHaveLength(3);
  for (const s of GUIDE_STEPS) expect(text).toContain(s);
  expect(text).toContain('緑色の「Create」ボタンを押す');
  expect(text).toContain(GUIDE_STEP_NOTE); // 「Submit new issue」等の表記違い
  expect(text).toContain('Submit new issue');
  // ボタンは2つだけ（戻る / GitHubで配合を申し込む）
  const labels = Array.from(document.querySelectorAll('.guide-actions button')).map(
    (b) => b.textContent ?? '',
  );
  expect(labels).toEqual(['戻る', 'GitHubで配合を申し込む']);
  // メタデータ: 主操作へ初期フォーカス（autofocus）・背面クリックで閉じる指定
  expect(document.querySelector<HTMLElement>('.guide-open')?.hasAttribute('autofocus')).toBe(
    true,
  );
  expect(dialogEl()?.getAttribute('closedby')).toBe('any');
  expect(dialogEl()?.getAttribute('aria-labelledby')).toBe('guide-title');
  expect(document.getElementById('guide-title')?.textContent).toBe('配合申請のご案内');
  // 自前ハンドラは置かない（ガイド: role/aria-modal/Esc/フォーカス復帰はブラウザが担当）
  expect(dialogEl()?.getAttribute('role')).toBeNull();
  expect(dialogEl()?.getAttribute('aria-modal')).toBeNull();
  // 既存スプライトの博士（新しい画像を作らない）
  const img = document.querySelector<HTMLImageElement>('.guide-char .char-img');
  expect(img).toBeTruthy();
  expect(img?.getAttribute('src') ?? '').toMatch(/\.png/);
});

it('「戻る」で閉じ、Issue作成は走らない（onOpen は呼ばれない）', () => {
  guide.open();
  click('.guide-back');
  expect(guide.isOpen()).toBe(false);
  expect(guide.el.open).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();
});

it('背面クリックで閉じるが、ダイアログ本体のクリックでは閉じない', () => {
  guide.open();
  // 本体（吹き出し）を叩いても閉じない = 誤爆で入力を失わない
  tapAt(0, 0); // happy-dom では rect 全 0 のため (0,0) が「内側」になる
  expect(guide.isOpen()).toBe(true);
  // 外側を叩く（押して離す両方）と閉じる
  tapAt(1, 1);
  expect(guide.isOpen()).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();
});

it('「GitHubで配合を申し込む」でだけ onOpen を呼び、ダイアログは閉じる', () => {
  guide.open();
  click('.guide-open');
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(guide.isOpen()).toBe(false);
});

it('開閉は冪等（二重 open / 二重 close でも壊れない）', () => {
  guide.open();
  guide.open();
  expect(guide.isOpen()).toBe(true);
  guide.close();
  guide.close();
  expect(guide.isOpen()).toBe(false);
});
