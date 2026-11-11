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
 *
 * issue #51（modern-web-guidance の dialog ガイド準拠）:
 * - 手作りオーバーレイ（role=dialog + aria-modal + 自前フォーカス管理）から
 *   ネイティブ `<dialog>` + `showModal()` へ移行。最上層・フォーカス包含・
 *   Esc・フォーカス復帰はブラウザが提供する（自前で再実装しない）
 * - 背面クリックで閉じるのは `closedby="any"`。未対応（Safari）だけガイド記載の
 *   ヒットテストのフォールバックを入れる
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
  readonly el: HTMLDialogElement;
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
    { class: 'guide-open', type: 'button', autofocus: '' },
    'GitHubで配合を申し込む',
  );

  // ネイティブ <dialog>（issue #51）。role/aria-modal/自前フォーカストラップは不要:
  // showModal() が最上層・フォーカス包含・Esc・フォーカス復帰をブラウザ側で提供する。
  const dialog = el(
    'dialog',
    {
      class: 'guide window',
      // 背面クリックでも閉じる（Safari は未対応 → 後段のフォールバックで補う）
      closedby: 'any',
      'aria-labelledby': 'guide-title',
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

  let pressedOutside = false;

  /** closedby 非対応環境向け: 背面クリックで閉じる（ガイド記載のヒットテスト）。
   * target ではなく座標で判定する — dialog 自体も padding や隙間の click の
   * target になるため、target 比較では中のクリックまで閉じてしまう。 */
  function outside(e: PointerEvent): boolean {
    const r = dialog.getBoundingClientRect();
    return (
      e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    );
  }
  dialog.addEventListener('pointerdown', (e) => {
    pressedOutside = outside(e);
  });
  dialog.addEventListener('pointerup', (e) => {
    // 押した瞬間と離した瞬間の両方が外側のときだけ閉じる（選択ドラッグ誤爆の防止）
    if (pressedOutside && outside(e)) handle.close();
    pressedOutside = false;
  });

  const handle: ApplyGuideHandle = {
    el: dialog,
    open() {
      if (dialog.open) return;
      // showModal(): 最上層・フォーカス包含・Esc・フォーカス復帰はブラウザ側。
      // 初期フォーカスは autofocus 属性の「GitHubで配合を申し込む」へ移る。
      dialog.showModal();
    },
    close() {
      if (!dialog.open) return;
      dialog.close(); // フォーカス復帰もブラウザが行う（ガイド: 自前で戻さない）
    },
    isOpen: () => dialog.open,
  };

  backBtn.addEventListener('click', () => handle.close());
  dialog.querySelector('.guide-x')?.addEventListener('click', () => handle.close());
  // Esc / 背面クリックはネイティブ（closedby）に任せる → 自前ハンドラは置かない
  openBtn.addEventListener('click', () => {
    // ここでのみ GitHub へ進む。閉じてから main.ts の既存処理（URL生成・phase）を実行する。
    handle.close();
    onOpenGithub();
  });

  document.body.append(dialog);
  return handle;
}
