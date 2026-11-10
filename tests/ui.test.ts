// @vitest-environment happy-dom
/**
 * フロントエンドのスモークテスト（候補カードUI / 追加開発指示 §2・§3・§9）。
 * APIキーなし・Issuesなしでサイトが起動し、
 * 「候補6件表示 → 2作品選択 → Issue URL生成」まで通ることを確認する。
 */
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import rawCandidates from '../data/current-candidates.json';
import rawOff from '../data/offspring.json';
import rawSampleOff from '../data/offspring.sample.json';
import rawPool from '../data/sample-prototypes.json';
import { isCandidatesFile } from '../lib/candidates.ts';
import { BLEND_MODE_DESCRIPTIONS, statusLabel, type ProtopediaWork } from '../lib/types.ts';
import { repoConfigFromEnv } from '../lib/config.ts';
import { parseBreedingIssue } from '../lib/issue.ts';
import { installMemoryStorage } from './helpers/memory-storage.ts';

const candFileValid = isCandidatesFile(rawCandidates);
const candFile = rawCandidates as unknown as import('../lib/candidates.ts').CandidatesFile;
/** 候補JSONが有効ならその件数（ProtoPedia + AI生成 / issue #36）、無効なら開発用サンプル4件がカードになる。 */
const expectedCards = candFileValid
  ? candFile.candidates.length + (candFile.offspringCandidates?.length ?? 0)
  : 4;

async function boot() {
  vi.resetModules(); // main.ts を毎回再実行する
  // 選択の永続化（issue #26）が前のテストの選択を引き継がないようにする
  installMemoryStorage();
  document.documentElement.classList.remove('has-float');
  document.body.innerHTML = '<div id="app"></div>';
  await import('../public/main.ts');
  const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.candidate'));
  const pickBtn = (cardIdx: number, slot: 'a' | 'b') =>
    cards()[cardIdx].querySelectorAll<HTMLButtonElement>('button.pick')[slot === 'a' ? 0 : 1];
  const statusVals = () => Array.from(document.querySelectorAll<HTMLElement>('.status-val'));
  return {
    cards,
    pickBtn,
    statusVals,
    breedButton: () => document.querySelector('button.breed') as HTMLButtonElement,
    actionHint: () => document.querySelector('.actions .hint') as HTMLElement,
    // 検索フィールドが無いことの確認用（select は配合タイプ選択のみ / issue #16 §4）
    legacyInputs: () => document.querySelectorAll('.filter, .picker'),
    modeSelect: () => document.querySelector('#blend-mode') as HTMLSelectElement,
    commentInput: () => document.querySelector('#breed-comment') as HTMLInputElement,
  };
}

it('タイトル・コピー・注意書きが表示される', async () => {
  await boot();
  expect(document.querySelector('h1')?.textContent).toBe('Mashup Ours');
  expect(document.body.textContent).toContain('20年分の発明を、もう一度マッシュアップ。');
  expect(document.body.textContent).toContain('未実装の発明アイデア');
});

it('自由検索は廃止され、候補カードだけが並ぶ', async () => {
  const { cards, legacyInputs } = await boot();
  expect(legacyInputs().length).toBe(0); // 検索フィールド・ピッカーは無い
  // select は「配合タイプ」1つだけ（issue #16 §4）
  const selects = Array.from(document.querySelectorAll('select'));
  expect(selects.length).toBe(1);
  expect(selects[0].id).toBe('blend-mode');
  expect(cards().length).toBe(expectedCards);

  const ids = cards().map((c) => c.dataset.id ?? 'ID欠落');
  // ProtoPedia作品に加え、AI生成アイデアも親として並ぶ（issue #36）
  expect(ids.every((id) => /^(protopedia:\d{1,9}|mashup-\d{1,9})$/.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length); // 重複カードは出ない

  // カードごとのNo.キャプション（完成イメージ準拠）。AI生成カードは末尾に「/ AI生成」。
  cards().forEach((c, i) => {
    const suffix = c.classList.contains('child-card') ? ' / AI生成' : '';
    expect(c.querySelector('.card-index')?.textContent).toBe(
      `作品 No.${String(i + 1).padStart(2, '0')}${suffix}`,
    );
  });
});

it('パネル見出し「本日の発明研究所」と右上バッジが表示される', async () => {
  await boot();
  expect(document.querySelector('.lab-head h2')?.textContent).toBe('本日の発明研究所');
  expect(document.querySelector('.lab-sub')?.textContent).toBe('LAB / INVENTION CANDIDATES');
  const chip = document.querySelector('.lab-head .chip')?.textContent ?? '';
  expect(chip).toBe(candFileValid ? '15分ごとに6件・全ユーザー共通' : '開発用サンプル');
});

it('画像はlazy読込・alt付き。画像が無いカードはプレースホルダで枠が残る', async () => {
  const { cards } = await boot();
  let boxes = 0;
  for (const c of cards()) {
    const img = c.querySelector<HTMLImageElement>('.thumb img');
    const ph = c.querySelector('.thumb-ph');
    if (img) {
      expect(img.getAttribute('loading')).toBe('lazy');
      expect((img.alt ?? '').length).toBeGreaterThan(0);
      boxes += 1;
    } else {
      // ProtoPediaカードは .thumb-ph、AI生成カードは .thumb-miss（issue #36）
      expect(ph ?? c.querySelector('.thumb .thumb-miss')).toBeTruthy(); // 枠は維持される
      boxes += 1;
    }
  }
  expect(boxes).toBe(cards().length);
});

it('配合枠・次の候補更新は日本時間で表示され、UTCの生データは出ない（issue #18）', async () => {
  await boot();
  const text = document.body.textContent ?? '';
  // 枠は日本時間の時間帯（例「15:00〜15:15」）。UTCスロットキーの生データは出さない
  expect(text).toContain('現在の配合枠');
  expect(text).toMatch(/現在の配合枠: \d{2}:\d{2}〜\d{2}:\d{2}（日本時間）/);
  expect(text).toContain('次の候補更新');
  expect(text).toMatch(/次の候補更新: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}（日本時間）/);
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/); // UTCスロットキーを露出しない
  expect(text).not.toContain('UTC'); // 「次回更新（UTC）」等の表記は無効
  expect(text).not.toContain('次回の候補更新予定'); // 旧文言
  // 配合の頻度説明は config/schedule.json から生成（固定文言にしない / issue #15・#41）
  const { breedingShareText, parseScheduleConfig } = await import('../lib/schedule.ts');
  const rawSchedule: unknown = (await import('../config/schedule.json')).default;
  const parsedSchedule = parseScheduleConfig(rawSchedule);
  expect(parsedSchedule.ok).toBe(true);
  if (parsedSchedule.ok) expect(text).toContain(breedingShareText(parsedSchedule.config));
  expect(text).toContain('ページを再読み込みしても候補は変わりません');
});

it('頻度の文言が config/schedule.json から生成される（固定文言なし / issue #15・#41）', async () => {
  const { breedingFreqLabel, breedingNotice, candidateNotice, parseScheduleConfig } = await import(
    '../lib/schedule.ts'
  );
  const raw: unknown = (await import('../config/schedule.json')).default;
  const parsed = parseScheduleConfig(raw);
  expect(parsed.ok).toBe(true); // 出荷している設定は常に有効
  if (!parsed.ok) return;

  await boot();
  const text = document.body.textContent ?? '';
  expect(text).toContain(candidateNotice(parsed.config)); // 「◯ごとに新しい発明候補が届くよ！」
  expect(text).toContain(breedingNotice(parsed.config)); // 「◯に最大1つ、新しい発明が誕生します！」
  // 時間帯別配合（issue #41）: 頻度の説明も設定から生成した時間帯になる
  const freq = breedingFreqLabel(parsed.config);
  expect(freq).toContain('13:00〜21:00は30分ごと');
  expect(freq).toContain('21:00〜13:00は2時間ごと');
  expect(freq).toContain('日本時間');
  expect(text).toContain(`新しい発明は${freq}に誕生します。`);
  // 「1時間に1回」「毎時」などの固定文言はサイトから消えている
  expect(text).not.toContain('毎時');
  expect(text).not.toContain('1時間に1回');
});

it('選択前は配合申請ボタンが無効', async () => {
  const { breedButton, statusVals } = await boot();
  expect(breedButton().disabled).toBe(true);
  expect(statusVals()[0].textContent).toContain('未選択');
  expect(statusVals()[1].textContent).toContain('未選択');
});

it('1作品だけ選んでは申請できない（A選択中バッジは出る）', async () => {
  const { cards, pickBtn, breedButton, statusVals } = await boot();
  pickBtn(0, 'a').click();

  const card = cards()[0];
  expect(card.classList.contains('is-a')).toBe(true);
  expect(pickBtn(0, 'a').getAttribute('aria-pressed')).toBe('true');

  const badge = card.querySelector<HTMLElement>('.badge.pick-state');
  expect(badge?.hidden).toBe(false);
  expect(badge?.textContent).toBe('親A選択中');

  expect(statusVals()[0].textContent).toContain(card.dataset.id ?? 'ID欠落');
  expect(statusVals()[1].textContent).toContain('未選択');
  expect(breedButton().disabled).toBe(true);
});

it('異なる2作品を選ぶと申請ボタンの条件が揃う', async () => {
  const { cards, pickBtn, breedButton, statusVals, actionHint } = await boot();
  pickBtn(0, 'a').click();
  pickBtn(1, 'b').click();

  expect(statusVals()[0].textContent).toContain(cards()[0].dataset.id ?? 'ID欠落');
  expect(statusVals()[1].textContent).toContain(cards()[1].dataset.id ?? 'ID欠落');
  expect(statusVals()[0].textContent).not.toContain('未選択');
  expect(statusVals()[1].textContent).not.toContain('未選択');
  expect(cards()[1].classList.contains('is-b')).toBe(true);

  // owner/repo設定時は有効、未設定時は案内付きで無効のまま
  if (repoConfigured()) {
    expect(breedButton().disabled).toBe(false);
    expect(actionHint().textContent).toContain('の組み合わせで配合を申し込みます');
  } else {
    expect(breedButton().disabled).toBe(true);
    expect(actionHint().textContent).toContain('未設定');
  }
});

it('同じ作品をAとBにはできない（選んだ側だけ残って無効のまま）', async () => {
  const { pickBtn, breedButton, statusVals } = await boot();
  pickBtn(0, 'a').click();
  pickBtn(0, 'b').click(); // 同一カード → A選択は解除されてBだけ残る
  expect(statusVals()[0].textContent).toContain('未選択');
  expect(statusVals()[1].textContent).not.toContain('未選択');
  expect(breedButton().disabled).toBe(true);
});

it('もう一度押すと選択が解除される', async () => {
  const { cards, pickBtn, statusVals } = await boot();
  pickBtn(0, 'a').click();
  pickBtn(0, 'a').click(); // トグル解除
  expect(cards()[0].classList.contains('is-a')).toBe(false);
  expect(pickBtn(0, 'a').getAttribute('aria-pressed')).toBe('false');
  expect(cards()[0].querySelector<HTMLElement>('.badge.pick-state')?.hidden).toBe(true);
  expect(statusVals()[0].textContent).toContain('未選択');
});

it('Issue作成URLに親ID・元作品URL・slotが含まれる（設定済み環境 / 案内ダイアログ経由）', async () => {
  const { pickBtn, breedButton } = await boot();
  const spy = vi.spyOn(window, 'open').mockReturnValue(null);
  pickBtn(0, 'a').click();
  pickBtn(1, 'b').click();

  // owner/repo未設定のビルドでは無効のままなので、設定済みの場合のみクリックを検証する
  if (!breedButton().disabled) {
    breedButton().click();
    // 押した直後は GitHub へ移動しない（案内ダイアログが開くだけ / issue #35）
    expect(spy).not.toHaveBeenCalled();
    expect(document.querySelector('.guide[role="dialog"]')).toBeTruthy();
    document.querySelector<HTMLElement>('.guide-open')?.click();
    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(String(spy.mock.calls[0][0]));
    expect(url.pathname).toContain('/issues/new');
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('parent_a: ');
    expect(body).toContain('parent_b: ');
    expect(body).toContain('parent_a_url: https://protopedia.net/');
    expect(body).toContain('slot: ');
  }
  spy.mockRestore();
});

it('系譜図SVGとノードが描画される（子とその親が必ず出る / issue #21）', async () => {
  await boot();
  const svg = document.querySelector('.pedigree-scroll svg');
  expect(svg).toBeTruthy();

  // ノード数はデータ件数に依存させない（実データが増えても壊れないよう）。
  // ノード識別は aria-label「タイトル（id）」の末尾idで行う。
  const nodeIds = () =>
    Array.from(document.querySelectorAll('.pedigree-scroll .node'))
      .map((n) => /（([^（）]+)）$/.exec(n.getAttribute('aria-label') ?? '')?.[1] ?? '')
      .filter((id) => id !== '');

  // 表示中の子作品: 実データ0件の間だけサンプル（main.ts の分岐と同じ）
  const shown: { id: string; parents: string[] }[] = rawOff.length === 0 ? rawSampleOff : rawOff;
  expect(shown.length).toBeGreaterThan(0);

  for (const c of shown) {
    expect(nodeIds()).toContain(c.id); // 子は必ず出る
    for (const p of c.parents) {
      // 親が候補ローテで外れても消えないこと（本バグの再発検出）
      expect(nodeIds(), `親 ${p} が系譜図から消えている`).toContain(p);
    }
  }

  // 辺は子ごとに親2本（両端のノードがともに解決しているときだけ描かれる）
  const edges = document.querySelectorAll('.pedigree-scroll .edge');
  expect(edges.length).toBe(shown.length * 2);

  // 未接続ノードは出さない（サンプルの protopedia:9003 など）
  const connected = new Set(shown.flatMap((c) => [c.id, ...c.parents]));
  for (const id of nodeIds()) expect(connected.has(id)).toBe(true);
});

it('子作品ノードをクリックすると詳細が出る', async () => {
  await boot();
  const nodes = Array.from(document.querySelectorAll('.pedigree-scroll .node'));
  (nodes[nodes.length - 1] as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const detail = document.querySelector('.detail')?.textContent ?? '';
  expect(detail).toContain('継承した特徴');
  expect(detail).toContain('未実装の発明アイデア');
});

it('子作品の行からも親を選びられる（行クリックの詳細表示は奪わない）', async () => {
  const { statusVals } = await boot();
  const li = document.querySelector<HTMLElement>('ul.offspring li:not(.empty)');
  expect(li).toBeTruthy();
  const btns = li!.querySelectorAll<HTMLButtonElement>('button.pick');
  expect(btns.length).toBe(2); // Aにする / Bにする

  btns[0].click();
  expect(li!.classList.contains('is-a')).toBe(true);
  expect(statusVals()[0].textContent).not.toContain('未選択');
  // 行クリックによる詳細表示は発火しない（stopPropagation）
  expect(document.querySelector('.detail')?.textContent ?? '').toContain('発明をクリック');
});

it('HTMLとして未エスケープの外部入力が挿入されない（XSS）', async () => {
  // ここでは onclick 属性などdangerousな属性が生成されないことを確認する。
  await boot();
  const nodes = document.querySelectorAll('.pedigree-scroll [onload], .pedigree-scroll [onclick]');
  expect(nodes.length).toBe(0);
  expect(document.querySelectorAll('[onclick]').length).toBe(0);
});

it('?id= ディープリンクで詳細を開く（/ideasからの復帰 / issue #8）', async () => {
  // 実データのIDを使う（削除でIDが変わる / issue #32）。0件ならこの検証はスキップ。
  const list = rawOff as unknown as { id: string; inheritedTraits?: unknown[] }[];
  const target = list.find((c) => Array.isArray(c.inheritedTraits) && c.inheritedTraits.length > 0);
  if (!target) return;
  window.history.replaceState({}, '', `/?id=${target.id}`);
  await boot();
  const detail = document.querySelector('.detail')?.textContent ?? '';
  expect(detail).toContain('継承した特徴'); // 子ノードの詳細が初期表示される
  expect(detail).not.toContain('発明をクリック');
  window.history.replaceState({}, '', '/'); // 後続テストに影響しないよう戻す
});

it('/ideas へのリンクがトップから張られている（issue #8）', async () => {
  await boot();
  const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('h2 a')).map(
    (a) => a.getAttribute('href') ?? '',
  );
  // base パス部分は環境依存（ローカル '/'・Actions '/<repo>/'）なので末尾一致で判定
  expect(hrefs.some((h) => h.endsWith('ideas/'))).toBe(true);
});

/** owner/repoが設定されているか（main.tsの初期化時点と同じ情報を再利用） */
function repoConfigured(): boolean {
  return document.querySelectorAll('.notice.error').length === 0;
}

// --- 博士キャラクター（issue #11 追加指示 §5・§7・§10 最重要事項） ----------

it('トップに2人の博士がFVの左右に表示され、挨拶ウィンドウがある', async () => {
  await boot();
  const chars = document.querySelectorAll('.lab-scene .char');
  expect(chars.length).toBe(2);
  expect((chars[0] as HTMLElement).dataset.char).toBe('banno');
  expect((chars[1] as HTMLElement).dataset.char).toBe('higedaruma');
  const lead = document.querySelector('.greet-lead')?.textContent ?? '';
  expect(lead).toContain('配合する研究所');
});

// --- ファーストビュー改修（issue #14） ---------------------------------------

it('FVの構成: タイトル・コピー・大見出し・2ボタン・16bit表記なし', async () => {
  await boot();
  const text = document.body.textContent ?? '';
  // ①タイトル（最も大きく）+ ②コピー
  expect(document.querySelector('.hero h1')?.textContent).toBe('Mashup Ours');
  expect(document.querySelector('.hero .copy')?.textContent).toBe(
    '20年分の発明を、もう一度マッシュアップ。',
  );
  // ④大見出し + 補足
  expect(document.querySelector('.fv-lead')?.textContent).toBe(
    'プロトタイプとプロトタイプを配合して、新しいアイデアを生み出そう！',
  );
  expect(document.querySelector('.fv-sub')?.textContent).toContain('ProtoPediaに投稿された作品から2つ');
  // ⑤ボタンはアンカー先のセクションへ移動
  const btnA = document.querySelector<HTMLAnchorElement>('a.fv-btn.primary');
  const btnB = document.querySelector<HTMLAnchorElement>('a.fv-btn:not(.primary)');
  expect(btnA?.getAttribute('href')).toBe('#candidates');
  expect(btnA?.textContent).toContain('発明を配合する');
  expect(btnB?.getAttribute('href')).toBe('#pedigree');
  expect(btnB?.textContent).toContain('発明の系譜図を見る');
  expect(document.querySelector('#candidates')).toBeTruthy();
  expect(document.querySelector('#pedigree')).toBeTruthy();
  // ③メインビジュアル: 左右カプセル + 中央装置 + パイプ + 研究員2人
  expect(document.querySelector('.lab-scene .capsule-a')).toBeTruthy();
  expect(document.querySelector('.lab-scene .capsule-b')).toBeTruthy();
  expect(document.querySelector('.lab-scene .fv-machine-body')).toBeTruthy();
  expect(document.querySelectorAll('.lab-scene .pipe').length).toBe(2);
  // §1: デザイン手法文言「16bit」はFV・サイトから削除
  expect(text).not.toContain('16bit');
});

it('カプセルは選択に連動（未選択=「？」→ 2選択で配合準備完了。選択だけで申請しない）', async () => {
  const { pickBtn } = await boot();
  const nameA = () => document.querySelector('.capsule-a .capsule-name')?.textContent ?? '';
  const nameB = () => document.querySelector('.capsule-b .capsule-name')?.textContent ?? '';
  const viewA = () => document.querySelector('.capsule-a .capsule-view')?.textContent ?? '';
  const status = () => document.querySelector('.fv-status')?.textContent ?? '';
  const machine = () => document.querySelector('.fv-machine') as HTMLElement;

  // 初期: 未選択 =「？」・スタンバイ中・準備完了点滅なし
  expect(viewA()).toContain('？');
  expect(nameA()).toBe('発明Aをえらんでね');
  expect(nameB()).toBe('発明Bをえらんでね');
  expect(status()).toContain('スタンバイ中');
  expect(machine().classList.contains('is-ready')).toBe(false);

  const spy = vi.spyOn(window, 'open').mockReturnValue(null);

  // 1作品: 片方だけ入る
  pickBtn(0, 'a').click();
  const titleA = document.querySelectorAll('.candidate')[0].querySelector('h3')?.firstChild?.textContent ?? '';
  expect(nameA()).toBe(titleA);
  expect(status()).toContain('あと1つ');
  expect(machine().classList.contains('is-ready')).toBe(false);
  expect(spy).not.toHaveBeenCalled(); // 選択だけでIssue/申請は始まらない

  // 2作品: 配合準備完了（装置が点滅）
  pickBtn(1, 'b').click();
  expect(nameB()).not.toBe('発明Bをえらんでね');
  expect(status()).toContain('配合準備完了');
  expect(machine().classList.contains('is-ready')).toBe(true);
  expect(spy).not.toHaveBeenCalled(); // 選択だけでAI配合処理は開始しない

  spy.mockRestore();
});

it('同じ作品をAとBに両方選べない（反対側のカプセルは空に戻る）', async () => {
  const { pickBtn } = await boot();
  const nameA = () => document.querySelector('.capsule-a .capsule-name')?.textContent ?? '';
  const nameB = () => document.querySelector('.capsule-b .capsule-name')?.textContent ?? '';
  pickBtn(0, 'a').click();
  expect(nameA()).not.toBe('発明Aをえらんでね');
  pickBtn(0, 'b').click(); // 同一カード → Aが解除されBだけ残る
  expect(nameA()).toBe('発明Aをえらんでね');
  expect(nameB()).not.toBe('発明Bをえらんでね');
});

it('Issue作成画面を開いた直後はFV装置も「申請手続き中」（生成完了と表示しない）', async () => {
  const { pickBtn, breedButton } = await boot();
  const spy = vi.spyOn(window, 'open').mockReturnValue(null);
  pickBtn(0, 'a').click();
  pickBtn(1, 'b').click();
  if (!breedButton().disabled) {
    const status = () => document.querySelector('.fv-status')?.textContent ?? '';
    expect(status()).toContain('配合準備完了');
    breedButton().click();
    // 案内ダイアログが開いただけでは申請手続き中にならない（まだGitHubへ行っていない / issue #35）
    expect(document.querySelector('.guide[role="dialog"]')).toBeTruthy();
    expect(status()).toContain('配合準備完了');
    document.querySelector<HTMLElement>('.guide-open')?.click();
    expect(status()).toContain('申請手続き中');
    expect(status()).not.toContain('誕生');
    // 申請手続き中は「準備完了」点滅を止める
    expect(document.querySelector('.fv-machine')?.classList.contains('is-ready')).toBe(false);
  }
  spy.mockRestore();
});

it('親の選択数に案内役の博士の案内が連動する（0→1→2）', async () => {
  const { pickBtn } = await boot();
  const guideMsg = () =>
    document.querySelector('.cand-guide .char-msg')?.textContent ?? '';
  expect(guideMsg()).toContain('2つ選ぶのじゃ');
  pickBtn(0, 'a').click();
  expect(guideMsg()).toContain('あと1つ');
  pickBtn(1, 'b').click();
  expect(guideMsg()).toContain('2つえらべた');
});

it('Issue作成画面を開いただけでは実験担当の博士は success にしない（最重要事項）', async () => {
  const { pickBtn, breedButton } = await boot();
  const spy = vi.spyOn(window, 'open').mockReturnValue(null);
  pickBtn(0, 'a').click();
  pickBtn(1, 'b').click();
  if (!breedButton().disabled) {
    breedButton().click();
    // 案内ダイアログの段階ではまだ何も開いていない（success にもしない / issue #35）
    expect(spy).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('.guide-open')?.click();
    const machineChar = document.querySelector('.machine-char .char') as HTMLElement;
    expect(machineChar.dataset.state).not.toBe('success');
    expect(machineChar.dataset.state).toBe('idle'); // 開いただけ = 未完了のまま
    const msg = document.querySelector('.machine-char .char-msg')?.textContent ?? '';
    expect(msg).toContain('申し込み画面を開きました');
    expect(msg).toContain('送信');
    // テスト環境では実通信ポーリングを一切始めない
    expect(spy).toHaveBeenCalledTimes(1);
  }
  spy.mockRestore();
});

it('系譜図の博士は完全な装飾（aria-hidden・二重読み上げしない）', async () => {
  await boot();
  const pedChar = document.querySelector('.ped-char') as HTMLElement;
  expect(pedChar).toBeTruthy();
  expect(pedChar.getAttribute('aria-hidden')).toBe('true');
  expect(pedChar.hasAttribute('role')).toBe(false);
});

// --- ロゴの読み仮名（issue #19） -----------------------------------------------

it('英語ロゴの右隣に小さく「（マッシュアップアワーズ）」の読み仮名がある', async () => {
  await boot();
  // 英語ロゴ（h1）は文言そのままで、読み仮名は別要素の添え書き
  expect(document.querySelector('.hero h1')?.textContent).toBe('Mashup Ours');
  const yomi = document.querySelector('.hero .logo-yomi');
  expect(yomi?.textContent).toBe('（マッシュアップアワーズ）');
  // h1 に読み仮名が混ざらない（見出しは英語のまま）
  expect(document.querySelector('.hero h1')?.textContent).not.toContain('マッシュアップ');
  // ロゴのスプライト（ドット絵）は維持
  expect(document.querySelector('.hero-title-row .logo')).toBeTruthy();
  // キャッチコピーは変更しない
  expect(document.querySelector('.hero .copy')?.textContent).toBe(
    '20年分の発明を、もう一度マッシュアップ。',
  );
});

// --- 配合タイプ・研究員へのひとこと・サムネイル（issue #16） -------------------

it('配合タイプは3種から選び、初期値は単純配合。選択で説明が切り替わる', async () => {
  const { modeSelect } = await boot();
  const sel = modeSelect();
  expect(Array.from(sel.options).map((o) => o.value)).toEqual([
    'fusion',
    'genetic',
    'mutation',
  ]);
  expect(sel.value).toBe('fusion');
  expect(document.querySelector('label[for="blend-mode"]')?.textContent).toBe('配合タイプ');

  const desc = (): string => document.querySelector('.mode-desc')?.textContent ?? '';
  expect(desc()).toBe(BLEND_MODE_DESCRIPTIONS.fusion);

  sel.value = 'mutation';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  expect(desc()).toBe(BLEND_MODE_DESCRIPTIONS.mutation);
  expect(desc()).not.toBe(BLEND_MODE_DESCRIPTIONS.fusion);
});

it('研究員へのひとことは任意・最大500文字（placeholder付き / issue #16 §5）', async () => {
  const { commentInput } = await boot();
  expect(commentInput().getAttribute('placeholder')).toBe('例：子どもが遊べる発明にしてほしい！');
  expect(commentInput().maxLength).toBe(500);
  expect(document.querySelector('label[for="breed-comment"]')?.textContent).toContain(
    '最大500文字',
  );
  expect(commentInput().value).toBe(''); // 任意（初期は空）
});

it('Issue本文に mode: と comment: が行として入る（設定済み環境）', async () => {
  const { pickBtn, breedButton, modeSelect, commentInput } = await boot();
  const spy = vi.spyOn(window, 'open').mockReturnValue(null);
  pickBtn(0, 'a').click();
  pickBtn(1, 'b').click();

  if (!breedButton().disabled) {
    modeSelect().value = 'genetic';
    modeSelect().dispatchEvent(new Event('change', { bubbles: true }));
    commentInput().value = '子どもが遊べる発明にしてほしい！';
    breedButton().click();
    // 案内ダイアログを経てから Issue作成URLが生成される（issue #35）。入力内容は維持される。
    expect(document.querySelector('.guide[role="dialog"]')).toBeTruthy();
    document.querySelector<HTMLElement>('.guide-open')?.click();
    expect(spy).toHaveBeenCalledTimes(1);

    const body = new URL(String(spy.mock.calls[0][0])).searchParams.get('body') ?? '';
    expect(body).toContain('mode: genetic');
    expect(body).toContain('comment: 子どもが遊べる発明にしてほしい！');
    const r = parseBreedingIssue(body); // UIとワーカーの間の契約
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.mode).toBe('genetic');
  }
  spy.mockRestore();
});

it('子作品の行にサムネイル枠と配合タイプバッジがある（issue #16 §12）', async () => {
  await boot();
  const li = document.querySelector('ul.offspring li:not(.empty)');
  expect(li).toBeTruthy();
  const thumb = li?.querySelector('.li-thumb');
  expect(thumb).toBeTruthy(); // 画像 or 「画像なし」プレースホルダーのどちらか
  expect(thumb?.querySelector('img, .thumb-miss')).toBeTruthy();
  const img = thumb?.querySelector('img');
  if (img) {
    expect(img.getAttribute('loading')).toBe('lazy');
    expect((img.alt ?? '').length).toBeGreaterThan(0);
  }
  expect(li?.querySelector('.badge.mode')?.textContent).toBe('単純配合'); // サンプルは fusion
  expect(li?.querySelector('.badge.idea')?.textContent).toBe('未実装のアイデア');
});

it('詳細パネルにも配合タイプと利用場面が出る（原作品とAI生成の区別を保つ）', async () => {
  await boot();
  const nodes = Array.from(document.querySelectorAll('.pedigree-scroll .node'));
  (nodes[nodes.length - 1] as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const detail = document.querySelector('.detail');
  expect(detail?.textContent ?? '').toContain('配合タイプ');
  expect(detail?.querySelector('.badge.idea')?.textContent).toBe(
    'AIが考えた未実装の発明アイデア',
  ); // 詳細側の表記は一覧より長い（実在の作品と誤認させない）
});

// --- 制作状態バッジ・タグの一覧表示（issue #29） ---------------------------

it('候補カードに制作状態バッジとタグチップが出る', async () => {
  const { cards } = await boot();
  const list = candFileValid ? (rawCandidates.candidates as unknown as ProtopediaWork[]) : [];
  // 制作状態バッジはProtoPediaカードだけの話（AI生成カードには出さない / issue #36）
  const protoCards = cards().filter((c) => !c.classList.contains('child-card'));
  expect(protoCards.length).toBe(list.length);
  list.forEach((w, i) => {
    const card = protoCards[i];
    const label = statusLabel(w.status);
    const badge = card.querySelector('.card-meta .badge.work-status');
    if (label) {
      expect(badge?.textContent).toBe(label); // 色だけでなく文字で状態を示す
      expect(card.textContent).toContain(label);
    } else {
      expect(badge).toBeNull(); // 状態なし(1)・未知コードは表示しない
    }
    const chips = Array.from(card.querySelectorAll('.tag-chip')).map((n) => n.textContent);
    expect(chips).toEqual((w.tags ?? []).slice(0, 6)); // 上限6件（詳細パネルは全件）
  });
});

it('候補プールに供養・開発中の実作品とタグがある（一覧表示の対象 / issue #29）', () => {
  const pool = (rawPool as unknown as { works: ProtopediaWork[] }).works;
  expect(pool.length).toBeGreaterThan(0);
  expect(pool.some((w) => statusLabel(w.status) === '供養')).toBe(true);
  expect(pool.some((w) => statusLabel(w.status) === '開発中')).toBe(true);
  expect(pool.some((w) => (w.tags ?? []).length > 0)).toBe(true);
});

// --- フッターのGitHubリンク（issue #30） ------------------------------------

it('フッターにGitHubリポジトリへのリンク（owner/repo 未設定なら出さない）', async () => {
  await boot();
  // 期待値は main.ts と同じ repoConfigFromEnv から導出する（issue #40:
  // Actions では GITHUB_REPOSITORY が注入されるため、VITE_GITHUB_OWNER だけを見ると
  // CI で必ず失敗していた。ローカル .env と CI の差を吸収し、ハードコードもしない）。
  const cfg = repoConfigFromEnv({
    VITE_GITHUB_OWNER: import.meta.env.VITE_GITHUB_OWNER,
    VITE_GITHUB_REPO: import.meta.env.VITE_GITHUB_REPO,
    GITHUB_REPOSITORY: typeof __GITHUB_REPOSITORY__ !== 'undefined' ? __GITHUB_REPOSITORY__ : '',
  });
  const link = document.querySelector<HTMLAnchorElement>('.site-foot .foot-links a');
  if (cfg) {
    expect(link?.getAttribute('href')).toBe(`https://github.com/${cfg.owner}/${cfg.repo}`);
    expect(link?.getAttribute('target')).toBe('_blank');
  } else {
    expect(link).toBeNull(); // リポジトリ名はハードコードしない
  }
  // 非公式プロジェクトの注記は設定に関わらず残る
  expect(document.querySelector('.site-foot')?.textContent).toContain('非公式プロジェクト');
});

// --- 生成アイデアの再配合（issue #36） ---------------------------------------

/** 現在の候補JSONに含まれるAI生成アイデアのID（0件の枠では検証をスキップ）。 */
const childCandIds = candFileValid ? (candFile.offspringCandidates ?? []) : [];
const rawOffList = rawOff as unknown as { id: string; generation: number; parents: string[] }[];
const childCards = () => Array.from(document.querySelectorAll<HTMLElement>('.candidate.child-card'));

it('候補にAI生成アイデアが並び、ラベル・世代・個別ページリンクがある（issue #36）', async () => {
  await boot();
  const cards = childCards();
  expect(cards.length).toBe(childCandIds.length);
  cards.forEach((card, i) => {
    const id = childCandIds[i];
    const data = rawOffList.find((o) => o.id === id);
    expect(card.dataset.id).toBe(id);
    // AI生成＝未実装のアイデアであることがカード上で分かる（実在作品と誤認させない）
    expect(card.querySelector('.badge.idea')?.textContent).toBe('AI生成アイデア・未実装');
    expect(card.querySelector('.badge.gen')?.textContent).toBe(`第${data?.generation}世代`);
    expect(card.querySelector('.badge.mode')?.textContent).toBeTruthy();
    expect(card.textContent).toContain('AI生成');
    // ProtoPediaへの導線ではなくサイト内の個別ページへ
    expect(card.textContent).not.toContain('ProtoPediaで見る');
    const link = card.querySelector<HTMLAnchorElement>('a[href*="ideas/"]');
    expect(link?.getAttribute('href')).toContain(`ideas/${id}`);
    // 操作は ProtoPediaカードと同一（Aにする / Bにする）
    const picks = card.querySelectorAll('button.pick');
    expect(picks.length).toBe(2);
    expect(picks[0].textContent).toBe('Aにする');
    expect(picks[1].textContent).toBe('Bにする');
    // サムネイル枠は維持（破線で ProtoPedia と見分ける / CSSは検証対象外）
    expect(card.querySelector('.thumb')).toBeTruthy();
  });
});

it('AI生成カードと「最近誕生した発明」の行が選択状態を共有する（issue #36）', async () => {
  const { statusVals } = await boot();
  const card = childCards()[0];
  if (!card) return; // 候補にAI生成が無い枠
  const id = card.dataset.id ?? '';
  const li = Array.from(document.querySelectorAll<HTMLElement>('ul.offspring li')).find((n) =>
    (n.textContent ?? '').includes(id),
  );
  expect(li, '最近一覧に行が無い').toBeTruthy();

  card.querySelectorAll<HTMLButtonElement>('button.pick')[0].click();
  expect(card.classList.contains('is-a')).toBe(true);
  expect(li?.classList.contains('is-a')).toBe(true); // 同じIDの複数表示が同期する
  expect(statusVals()[0].textContent).toContain(id);

  // 一覧の行側で解除しても、カード側も解除される
  li!.querySelectorAll<HTMLButtonElement>('button.pick')[0].click();
  expect(card.classList.contains('is-a')).toBe(false);
  expect(li?.classList.contains('is-a')).toBe(false);
});

it('AI生成アイデアを親Aにした申請URLが生成され、ワーカーのパーサーを通る（issue #36）', async () => {
  const { breedButton } = await boot();
  const cardsEl = Array.from(document.querySelectorAll<HTMLElement>('.candidate'));
  const childIdx = cardsEl.findIndex((c) => c.classList.contains('child-card'));
  if (childIdx < 0) return; // 候補にAI生成が無い枠
  const childId = cardsEl[childIdx].dataset.id ?? '';

  cardsEl[childIdx].querySelectorAll<HTMLButtonElement>('button.pick')[0].click(); // 親A = AI生成
  const protoIdx = cardsEl.findIndex((c, i) => i !== childIdx && !c.classList.contains('child-card'));
  cardsEl[protoIdx].querySelectorAll<HTMLButtonElement>('button.pick')[1].click(); // 親B = ProtoPedia

  const spy = vi.spyOn(window, 'open').mockReturnValue(null);
  if (!breedButton().disabled) {
    breedButton().click();
    expect(document.querySelector('.guide[role="dialog"]')).toBeTruthy(); // 案内ダイアログを経る（issue #35）
    document.querySelector<HTMLElement>('.guide-open')?.click();
    expect(spy).toHaveBeenCalledTimes(1);

    const body = new URL(String(spy.mock.calls[0][0])).searchParams.get('body') ?? '';
    expect(body).toContain(`parent_a: ${childId}`); // 文字列形式は従来どおり（互換維持）
    expect(body).toContain('parent_b: protopedia:');
    expect(body).not.toContain('parent_a_url'); // AI生成にProtoPediaの出典URLは付けない
    const r = parseBreedingIssue(body);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.parentA).toBe(childId);
      expect(r.request.parentB.startsWith('protopedia:')).toBe(true);
    }
  }
  spy.mockRestore();
});

// --- 選択した親の画像をカプセルと小型配合マシンに表示（issue #39） -------------

/** ProtoPedia候補のうち作品画像を持つ1件（無ければ null = テストを省略）。 */
function protoWithImage(): ProtopediaWork | undefined {
  return candFileValid ? candFile.candidates.find((w) => Boolean(w.mainUrl)) : undefined;
}

/** 生成画像を持つ子作品のID（無ければ null）。 */
function childWithImage(): string | undefined {
  const kids: string[] = candFileValid ? (candFile.offspringCandidates ?? []) : [];
  const list = rawOff as unknown as { id: string; imagePath?: string | null }[];
  for (const id of kids) {
    const full = list.find((x) => x.id === id);
    if (full?.imagePath) return full.id;
  }
  return undefined;
}

/** FVカプセル / 小型配合マシンの画像URL（無いときは null）。属性値のまま比較する。 */
function capsuleImg(slot: 'a' | 'b'): string | null {
  const fv = document.querySelector<HTMLImageElement>(`.capsule-${slot} .capsule-view img`);
  const slots = document.querySelectorAll<HTMLImageElement>('.float-slot .float-thumb img');
  const fl = slots[slot === 'a' ? 0 : 1] ?? null;
  // FVと小型版は常に同じURLでなければならない（片方だけ変わらないこと）
  const a = fv?.getAttribute('src') ?? null;
  const b = fl?.getAttribute('src') ?? null;
  if (a && b) expect(b).toBe(a);
  return a;
}

it('ProtoPediaとAI生成をA/Bに選ぶとカプセルと小型配合マシンにそれぞれの画像が出る（issue #39）', async () => {
  const { cards, pickBtn } = await boot();
  const proto = protoWithImage();
  const childId = childWithImage();
  if (!proto || !childId) return; // 画像付き候補が揃わない枠は検証省略（データ依存）

  const protoIdx = cards().findIndex((c) => c.dataset.id === proto.id);
  const childIdx = cards().findIndex((c) => c.dataset.id === childId);
  expect(protoIdx).toBeGreaterThanOrEqual(0);
  expect(childIdx).toBeGreaterThanOrEqual(0);

  pickBtn(protoIdx, 'a').click();
  pickBtn(childIdx, 'b').click();

  // ProtoPedia = 作品画像 / AI生成 = 生成画像（サイトルート相対 + BASE_URL）
  expect(capsuleImg('a')).toBe(proto.mainUrl);
  const imagePath = (rawOff as unknown as { id: string; imagePath?: string | null }[]).find(
    (x) => x.id === childId,
  )?.imagePath;
  expect(capsuleImg('b')).toBe(`${import.meta.env.BASE_URL}${imagePath}`);
  // 発明名と選択状態は画像に関係なく出ている
  expect(document.querySelector('.capsule-b .capsule-name')?.textContent).not.toBe(
    '発明Bをえらんでね',
  );
});

it('画像の読み込みに失敗したら「？」に戻り、発明名と選択は保つ（issue #39）', async () => {
  const { cards, pickBtn } = await boot();
  const childId = childWithImage();
  if (!childId) return;
  const childIdx = cards().findIndex((c) => c.dataset.id === childId);
  pickBtn(childIdx, 'a').click();

  const img = document.querySelector('.capsule-a .capsule-view img');
  expect(img).not.toBeNull();
  img?.dispatchEvent(new Event('error')); // 読み込み失敗
  expect(document.querySelector('.capsule-a .capsule-view')?.textContent).toContain('？');
  expect(document.querySelector('.capsule-a .capsule-name')?.textContent).not.toBe(
    '発明Aをえらんでね',
  );
});

it('nodeImageUrl は ProtoPedia=mainUrl / AI生成=imagePath / 画像なしなら null（issue #39）', async () => {
  await boot();
  const { nodeImageUrl } = await import('../public/main.ts'); // boot直後 = 同一モジュール
  const proto = protoWithImage();
  if (proto) expect(nodeImageUrl(proto, '/base/')).toBe(proto.mainUrl);
  // imagePath === null（画像生成に失敗してテキストのみ保存）→ 「？」側が選ばれる
  const noImage = {
    id: 'mashup-000001',
    sourceIssue: 1,
    imagePath: null,
  } as unknown as Parameters<typeof nodeImageUrl>[0];
  expect(nodeImageUrl(noImage, '/base/')).toBeNull();
  expect(nodeImageUrl(undefined, '/base/')).toBeNull();
  // サイトルート相対パスは base を前につける（カスタムドメイン・サブパス配信でも一致）
  const withImage = {
    id: 'mashup-000002',
    sourceIssue: 2,
    imagePath: 'assets/inventions/x.png',
  } as unknown as Parameters<typeof nodeImageUrl>[0];
  expect(nodeImageUrl(withImage, '/repo/')).toBe('/repo/assets/inventions/x.png');
});

// --- トップの肩書き（issue #38 §2） ------------------------------------------

it('トップのヒーローは「肩書き → ロゴ(h1) → コピー」の順で読ませる（issue #38）', async () => {
  await boot();
  const heroTop = document.querySelector('.hero-top');
  expect(heroTop).toBeTruthy();
  const katagi = heroTop?.querySelector('.hero-katagi');
  expect(katagi?.textContent).toBe('みんなのプロトタイプ配合研究所');
  const h1 = heroTop?.querySelector('h1');
  expect(h1).toBeTruthy();
  // 順序: 肩書き → h1（ロゴ）→ コピー
  const order = Array.from(heroTop?.querySelectorAll('.hero-katagi, h1, .copy') ?? []).map(
    (n) => n.className || n.tagName,
  );
  expect(order[0]).toBe('hero-katagi');
  expect(order[1]).toBe('H1');
  expect(order[2]).toBe('copy');
  // 肩書きは h1 より目立たない（CSSで字面を控えめにする / スタイルシートの存在確認）
  const css = readFileSync('public/style.css', 'utf8');
  expect(css).toContain('.hero-katagi');
  expect(css).toMatch(/\.hero-katagi\s*\{[^}]*--text-dim/);
});
