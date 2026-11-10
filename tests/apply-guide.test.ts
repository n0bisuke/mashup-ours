// @vitest-environment happy-dom
/**
 * 配合申請前の案内ダイアログ（issue #35）。
 * - 指定の吹き出し文言・補足・GitHub側3ステップ（表記違いの注記つき）
 * - 「戻る」/ Esc / 背面クリックで閉じ、onOpen は呼ばれない（= 入力を失わない）
 * - 「GitHubで配合を申し込む」だけが onOpen を呼ぶ（Issue作成URL生成は main.ts の既存処理）
 * - 既存スプライトの博士を使う / aria ラベル / スクロールロックの解除
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

function dialog(): HTMLElement | null {
  return document.querySelector('.guide[role="dialog"]');
}
function click(sel: string): void {
  document.querySelector<HTMLElement>(sel)?.click();
}

beforeEach(() => {
  document.body.innerHTML = '<button class="before-focus">元のフォーカス</button>';
  document.body.classList.remove('guide-locked');
  onOpen = vi.fn();
  guide = createApplyGuide(onOpen);
});

afterEach(() => {
  guide.close();
  guide.el.remove();
  document.body.classList.remove('guide-locked');
  document.body.innerHTML = '';
});

it('閉じているときは表示されない（open() で初めて現れる）', () => {
  expect(guide.isOpen()).toBe(false);
  expect(guide.el.hidden).toBe(true); // オーバーレイごと hidden（要素は作成済み）
  expect(guide.el.contains(dialog())).toBe(true);
  expect(document.body.classList.contains('guide-locked')).toBe(false);
  guide.open();
  expect(guide.el.hidden).toBe(false);
  expect(dialog()).toBeTruthy();
});

it('吹き出し文言・補足・3ステップ・ボタンが指定どおり出る', () => {
  guide.open();
  const text = dialog()?.textContent ?? '';
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
  // ダイアログとしての属性
  const d = dialog();
  expect(d?.getAttribute('aria-modal')).toBe('true');
  expect(d?.getAttribute('aria-labelledby')).toBe('guide-title');
  expect(document.getElementById('guide-title')?.textContent).toBe('配合申請のご案内');
  // 既存スプライトの博士（新しい画像を作らない）
  const img = document.querySelector<HTMLImageElement>('.guide-char .char-img');
  expect(img).toBeTruthy();
  expect(img?.getAttribute('src') ?? '').toMatch(/\.png/);
});

it('「戻る」で閉じ、Issue作成は走らない（onOpen は呼ばれない）', () => {
  guide.open();
  click('.guide-back');
  expect(guide.isOpen()).toBe(false);
  expect(guide.el.hidden).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
});

it('背面クリックで閉じるが、ダイアログ本体のクリックでは閉じない', () => {
  guide.open();
  // 本体（吹き出し）を叩いても閉じない = 誤爆で入力を失わない
  document.querySelector('.guide-bubble')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  );
  expect(guide.isOpen()).toBe(true);
  // 背面（オーバーレイ自身）を叩くと閉じる
  guide.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(guide.isOpen()).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();
});

it('Esc で閉じる（キーボードでも戻れる）', () => {
  guide.open();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(guide.isOpen()).toBe(false);
  expect(onOpen).not.toHaveBeenCalled();
});

it('「GitHubで配合を申し込む」でだけ onOpen を呼び、ダイアログは閉じる', () => {
  guide.open();
  click('.guide-open');
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(guide.isOpen()).toBe(false);
});

it('開くと背景スクロールを止め、閉じると解除・フォーカスを戻す', () => {
  const before = document.querySelector<HTMLElement>('.before-focus');
  before?.focus();
  guide.open();
  expect(document.body.classList.contains('guide-locked')).toBe(true);
  expect(document.activeElement).toBe(dialog()); // 読み上げ起点がダイアログ
  guide.close();
  expect(document.body.classList.contains('guide-locked')).toBe(false);
  expect(document.activeElement).toBe(before);
  // 二重オープンしても状態は壊れない
  guide.open();
  guide.open();
  expect(guide.isOpen()).toBe(true);
  guide.close();
  expect(guide.isOpen()).toBe(false);
});
