import './style.css';
import { createCharacter } from './character.ts';

/**
 * 配合申請前の案内ダイアログ（issue #35）。
 *
 * 「配合を申し込む」を押した瞬間には GitHub へ移動せず、研究所の博士が
 * 吹き出しで「GitHubにログインして緑色のボタンを押すだけ」を案内する。
 *
 * - Issue作成URLの生成は行わない（生成は main.ts の既存処理のまま。
 *   このダイアログは「GitHubで配合を申し込む」を押されたときの通知だけを行う）
 * - 「戻る」/ Esc / 背面クリックで閉じる。閉じても選択状態・入力は触らない
 * - GitHubへ移動しただけを申請完了にしない（phase の切り替えは main.ts の既存ロジック）
 */

/** 吹き出しの本文（指定文言）。 */
export const GUIDE_LINES: readonly string[] = [
  'いよいよ配合申請じゃ！',
  'この先はGitHubの画面に移動するぞ。',
  'GitHubアカウントでログインして、最後に緑色の『Create』ボタンを押してくれ！',
  'そこまで進めば配合の申し込み完了じゃ！',
];

/** 補足（アカウントと自動入力の案内）。 */
export const GUIDE_NOTE =
  'GitHubアカウントが必要です（無料で作成できます）。配合する作品の情報は自動入力されます。';

/** GitHub側の操作ステップ。 */
export const GUIDE_STEPS: readonly string[] = [
  'GitHubにログインする',
  '自動入力された配合内容を確認する',
  '緑色の「Create」ボタンを押す',
];

/** ボタン表記の違い（GitHubの画面・言語設定で変わる）。 */
export const GUIDE_STEP_NOTE =
  'ボタンの文字が「Submit new issue」などになっている画面もありますが、やることは同じです。';

export interface ApplyGuideHandle {
  readonly el: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

/**
 * 案内ダイアログを作る（open() で初めて画面に出る）。
 * onOpenGithub: 「GitHubで配合を申し込む」が押されたときだけ呼ばれる。
 */
export function createApplyGuide(onOpenGithub: () => void): ApplyGuideHandle {
  // 既存スプライト（案内役の博士 banno）を再利用。新しい画像は作らない。
  const guideChar = createCharacter('banno', { state: 'success', message: null });

  const lines = el('div', { class: 'guide-lines' });
  for (const line of GUIDE_LINES) lines.append(el('p', { class: 'guide-line' }, line));

  const steps = el('ol', { class: 'guide-steps' });
  for (const s of GUIDE_STEPS) steps.append(el('li', {}, s));

  const bubble = el(
    'div',
    { class: 'guide-bubble' },
    lines,
    el('p', { class: 'guide-note' }, GUIDE_NOTE),
    steps,
    el('p', { class: 'guide-stepnote hint' }, GUIDE_STEP_NOTE),
  );

  const backBtn = el('button', { class: 'guide-back', type: 'button' }, '戻る');
  const openBtn = el(
    'button',
    { class: 'guide-open', type: 'button' },
    'GitHubで配合を申し込む',
  );

  const dialog = el(
    'div',
    {
      class: 'guide window',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'guide-title',
      tabindex: '-1',
    },
    el(
      'div',
      { class: 'titlebar' },
      el('span', { id: 'guide-title' }, '配合申請のご案内'),
      el('button', { class: 'guide-x', type: 'button', 'aria-label': '案内を閉じる' }, '×'),
    ),
    el('div', { class: 'guide-body' }, el('div', { class: 'guide-char' }, guideChar.el), bubble),
    el('div', { class: 'guide-actions' }, backBtn, openBtn),
  );

  const overlay = el('div', { class: 'guide-overlay', hidden: '' }, dialog);
  overlay.hidden = true;

  let returnFocus: HTMLElement | null = null;

  const handle: ApplyGuideHandle = {
    el: overlay,
    open() {
      if (!overlay.hidden) return;
      returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      overlay.hidden = false;
      document.body.classList.add('guide-locked');
      // 読み上げ・フォーカスをダイアログへ（選択中の値は変更しない）
      dialog.focus({ preventScroll: true });
    },
    close() {
      if (overlay.hidden) return;
      overlay.hidden = true;
      document.body.classList.remove('guide-locked');
      returnFocus?.focus({ preventScroll: true });
      returnFocus = null;
    },
    isOpen: () => !overlay.hidden,
  };

  backBtn.addEventListener('click', () => handle.close());
  overlay.querySelector('.guide-x')?.addEventListener('click', () => handle.close());
  // 背面クリックでも閉じる（ダイアログ本体のクリックでは閉じない）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) handle.close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && handle.isOpen()) handle.close();
  });
  openBtn.addEventListener('click', () => {
    // ここでのみ GitHub へ進む。閉じてから main.ts の既存処理（URL生成・phase）を実行する。
    handle.close();
    onOpenGithub();
  });

  document.body.append(overlay);
  return handle;
}
