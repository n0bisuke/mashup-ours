import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BREEDING_SLOT_KEY_RE,
  DEFAULT_AUTO_REQUEST_IDLE_HOURS,
  FALLBACK_SCHEDULE,
  MAX_CONSECUTIVE_FAILURES,
  breedingFreqLabel,
  breedingNotice,
  breedingShareText,
  breedingSlotsPerDay,
  candidateChipText,
  candidateNotice,
  currentBreedingSlot,
  initialBreedingState,
  intervalLabel,
  isBreedingState,
  nextBreedingSlotStart,
  parseScheduleConfig,
  recordBreedingAttempt,
  resolveSchedule,
  shouldBreed,
  utcDay,
  type BreedingWindow,
  type ScheduleConfig,
} from '../lib/schedule.ts';

const cfg = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  candidateRotationMinutes: 15,
  breedingIntervalMinutes: 60,
  maxCandidates: 6,
  ...over,
});

describe('parseScheduleConfig（正の整数の検証 / issue #15）', () => {
  it('必須3項目があれば受理する', () => {
    const r = parseScheduleConfig({
      candidateRotationMinutes: 15,
      breedingIntervalMinutes: 60,
      maxCandidates: 6,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.candidateRotationMinutes).toBe(15);
      expect(r.config.breedingIntervalMinutes).toBe(60);
      expect(r.config.maxCandidates).toBe(6);
      expect(r.config.dailyAiCallLimit).toBeUndefined();
    }
  });

  it('任意の dailyAiCallLimit は正の整数なら保持する（未設定 = 上限なし）', () => {
    const r = parseScheduleConfig({ ...cfg(), dailyAiCallLimit: 8 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.dailyAiCallLimit).toBe(8);
    const none = parseScheduleConfig({ ...cfg(), dailyAiCallLimit: null });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.config.dailyAiCallLimit).toBeUndefined();
  });

  it('0・負数・小数・文字列・欠損をすべて拒否する', () => {
    expect(parseScheduleConfig({ ...cfg(), candidateRotationMinutes: 0 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingIntervalMinutes: -60 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingIntervalMinutes: 1.5 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), maxCandidates: '6' }).ok).toBe(false);
    expect(parseScheduleConfig({ candidateRotationMinutes: 15, breedingIntervalMinutes: 60 }).ok).toBe(false);
    expect(parseScheduleConfig({}).ok).toBe(false);
    expect(parseScheduleConfig(null).ok).toBe(false);
    expect(parseScheduleConfig([]).ok).toBe(false);
    expect(parseScheduleConfig('60').ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), dailyAiCallLimit: 0 }).ok).toBe(false);
  });

  it('上限を超える値を拒否する（間隔1週間・候補50件まで）', () => {
    expect(parseScheduleConfig({ ...cfg(), breedingIntervalMinutes: 10081 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingIntervalMinutes: 10080 }).ok).toBe(true);
    expect(parseScheduleConfig({ ...cfg(), maxCandidates: 51 }).ok).toBe(false);
  });

  it('autoRequestIdleHours は0以上（0=無効）の整数だけ受理する（issue #27）', () => {
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: 8 }).ok).toBe(true);
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: 0 }).ok).toBe(true);
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: -1 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: 1.5 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: 721 }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), autoRequestIdleHours: '8' }).ok).toBe(false);

    const set = parseScheduleConfig({ ...cfg(), autoRequestIdleHours: 12 });
    expect(set.ok && set.config.autoRequestIdleHours).toBe(12);
    const none = parseScheduleConfig({ ...cfg() });
    expect(none.ok && none.config.autoRequestIdleHours).toBeUndefined();

    // 既定値（8時間）はフォールバックにも載っている（フロント・ワーカーで同じ既定）
    expect(FALLBACK_SCHEDULE.autoRequestIdleHours).toBe(DEFAULT_AUTO_REQUEST_IDLE_HOURS);
    expect(DEFAULT_AUTO_REQUEST_IDLE_HOURS).toBe(8);
  });

  it('未知のキーは無視する（将来の追加で壊さない）', () => {
    const r = parseScheduleConfig({ ...cfg(), futureOption: 'x' });
    expect(r.ok).toBe(true);
  });

  it('出荷済み config/schedule.json は常に有効', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../config/schedule.json', import.meta.url), 'utf8'),
    );
    const r = parseScheduleConfig(raw);
    expect(r.ok).toBe(true);
    // 自動配合申請の待機時間も出荷設定に載っている（issue #27）
    expect(r.ok && r.config.autoRequestIdleHours).toBe(8);
    // 時間帯別配合の設定も載っている（issue #41）
    expect(r.ok && r.config.breedingWindows?.length).toBe(2);
    expect(r.ok && r.config.breedingWindows?.[0]).toEqual({
      startJst: '13:00',
      endJst: '21:00',
      intervalMinutes: 30,
    });
    expect(r.ok && breedingSlotsPerDay(r.config)).toBe(24); // 1日24枠（16 + 8）
  });
});

describe('resolveSchedule（フロント用フォールバック）', () => {
  it('有効ならエラーなしごと返す', () => {
    const r = resolveSchedule({ ...cfg(), candidateRotationMinutes: 30 });
    expect(r.error).toBeNull();
    expect(r.config.candidateRotationMinutes).toBe(30);
  });

  it('不正なら既定値と理由を返す（表示は止めない / Worker側は exit 1）', () => {
    const r = resolveSchedule({ ...cfg(), breedingIntervalMinutes: -1 });
    expect(r.error).toContain('breedingIntervalMinutes');
    expect(r.config).toEqual(FALLBACK_SCHEDULE);
  });
});

describe('intervalLabel と文言生成（設定から生成 / issue #15 §2）', () => {
  it('60で割り切れるときだけ「時間」表記', () => {
    expect(intervalLabel(15)).toBe('15分');
    expect(intervalLabel(60)).toBe('1時間');
    expect(intervalLabel(120)).toBe('2時間');
    expect(intervalLabel(180)).toBe('3時間');
    expect(intervalLabel(90)).toBe('90分');
    expect(intervalLabel(1)).toBe('1分');
  });

  it('候補更新の文言（仕様の例文どおり）', () => {
    expect(candidateNotice(cfg({ candidateRotationMinutes: 60 }))).toBe(
      '1時間ごとに新しい発明候補が届くよ！',
    );
    expect(candidateNotice(cfg({ candidateRotationMinutes: 120 }))).toBe(
      '2時間ごとに新しい発明候補が届くよ！',
    );
  });

  it('配合の文言（仕様の例文どおり）', () => {
    expect(breedingNotice(cfg({ breedingIntervalMinutes: 180 }))).toBe(
      '3時間に最大1つ、新しい発明が誕生します！',
    );
  });

  it('候補バッジ・共有ルール説明も設定から生成', () => {
    expect(candidateChipText(cfg())).toBe('15分ごとに6件・全ユーザー共通');
    expect(candidateChipText(cfg({ candidateRotationMinutes: 30, maxCandidates: 4 }))).toBe(
      '30分ごとに4件・全ユーザー共通',
    );
    // ui.test の契約: 既定設定ならこの部分列が本文に現れる
    expect(breedingShareText(cfg())).toContain('1時間に最大1件、全ユーザー共有');
    expect(breedingShareText(cfg({ breedingIntervalMinutes: 180 }))).toContain('3時間に最大1件');
    // 「毎時」固定文言は使わない
    expect(breedingShareText(cfg())).not.toContain('毎時');
  });
});

// ---------------------------------------------------------------------------
// 配合の実行制御（間隔を空けて最大1件 / 失敗の再試行 / 日次上限）
// ---------------------------------------------------------------------------

const T = (iso: string): Date => new Date(iso);

describe('shouldBreed（実行ゲート / issue #15 §4）', () => {
  it('まだ成功していない状態では最初の1回を許可する', () => {
    const d = shouldBreed(initialBreedingState(), cfg(), T('2026-11-09T12:00:00Z'));
    expect(d.run).toBe(true);
  });

  it('前回の成功から間隔が空いていなければ実行しない（AIを呼ばない）', () => {
    const state = { ...initialBreedingState(), lastSuccessAt: '2026-11-09T12:00:00Z' };
    const soon = shouldBreed(state, cfg(), T('2026-11-09T12:59:00Z'));
    expect(soon.run).toBe(false);
    expect(soon.reason).toContain('未経過');
    const later = shouldBreed(state, cfg(), T('2026-11-09T13:01:00Z'));
    expect(later.run).toBe(true);
  });

  it('間隔を設定で変えられる（120分なら2時間空ける）', () => {
    const state = { ...initialBreedingState(), lastSuccessAt: '2026-11-09T12:00:00Z' };
    const c = cfg({ breedingIntervalMinutes: 120 });
    expect(shouldBreed(state, c, T('2026-11-09T13:30:00Z')).run).toBe(false);
    expect(shouldBreed(state, c, T('2026-11-09T14:01:00Z')).run).toBe(true);
  });

  it('失敗は間隔に数えない（連続失敗が上限未満なら次の起床で再試行）', () => {
    const state = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-09T12:00:00Z',
      consecutiveFailures: 2,
    };
    const d = shouldBreed(state, cfg(), T('2026-11-09T12:05:00Z'));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('再試行');
  });

  it('連続失敗が上限（3回）に達したら冷却（間隔ぶんの停止）に入る', () => {
    const state = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-09T12:00:00Z',
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    };
    const cooled = shouldBreed(state, cfg(), T('2026-11-09T12:30:00Z'));
    expect(cooled.run).toBe(false);
    expect(cooled.reason).toContain('冷却');
    const after = shouldBreed(state, cfg(), T('2026-11-09T13:01:00Z'));
    expect(after.run).toBe(true);
  });

  it('dailyAiCallLimit ならそのUTC日の上限で止まる（失敗分も数える）', () => {
    const c = cfg({ dailyAiCallLimit: 2 });
    const state = {
      ...initialBreedingState(),
      aiCalls: { '2026-11-09': 2, '2026-11-08': 5 },
    };
    const blocked = shouldBreed(state, c, T('2026-11-09T23:00:00Z'));
    expect(blocked.run).toBe(false);
    expect(blocked.reason).toContain('上限');
    // 前日ぶんは数えない（UTC日が変われば再開）
    const nextDay = shouldBreed(state, c, T('2026-11-10T00:30:00Z'));
    expect(nextDay.run).toBe(true);
    // 上限未設定なら無視
    expect(shouldBreed(state, cfg(), T('2026-11-09T23:00:00Z')).run).toBe(true);
  });
});

describe('recordBreedingAttempt（状態の永続化）', () => {
  it('成功で lastSuccessAt を更新し連続失敗をリセット、呼び出し回数を数える', () => {
    const now = T('2026-11-09T12:00:00Z');
    const s = recordBreedingAttempt(
      { ...initialBreedingState(), consecutiveFailures: 2 },
      cfg(),
      { now, success: true },
    );
    expect(s.lastSuccessAt).toBe('2026-11-09T12:00:00.000Z');
    expect(s.lastAttemptAt).toBe('2026-11-09T12:00:00.000Z');
    expect(s.consecutiveFailures).toBe(0);
    expect(s.aiCalls['2026-11-09']).toBe(1);
    expect(isBreedingState(s)).toBe(true);
  });

  it('失敗は連続失敗を増やし成功日時は変えない（= 再試行できるまま）', () => {
    const s = recordBreedingAttempt(
      { ...initialBreedingState(), lastSuccessAt: '2026-11-09T06:00:00Z' },
      cfg(),
      { now: T('2026-11-09T12:00:00Z'), success: false },
    );
    expect(s.lastSuccessAt).toBe('2026-11-09T06:00:00Z');
    expect(s.consecutiveFailures).toBe(1);
  });

  it('冷却経過後の最初の試行は失敗カウントを数え直す', () => {
    const state = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-09T12:00:00Z', // 90分前（間隔60分 = 冷却経過）
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    };
    const s = recordBreedingAttempt(state, cfg(), {
      now: T('2026-11-09T13:30:00Z'),
      success: false,
    });
    expect(s.consecutiveFailures).toBe(1); // 3 → 0 にして +1
  });

  it('aiCalls は直近7日だけ保持（無限に肥大化しない）', () => {
    const s = recordBreedingAttempt(
      {
        ...initialBreedingState(),
        aiCalls: { '2026-10-01': 3, '2026-11-05': 1, '2026-11-09': 2 },
      },
      cfg(),
      { now: T('2026-11-09T12:00:00Z'), success: true },
    );
    expect(s.aiCalls['2026-10-01']).toBeUndefined();
    expect(s.aiCalls['2026-11-05']).toBe(1);
    expect(s.aiCalls['2026-11-09']).toBe(3);
    expect(utcDay(T('2026-11-09T23:59:59Z'))).toBe('2026-11-09');
  });
});

describe('isBreedingState（読み込みガード）', () => {
  it('出荷済み data/breeding-state.json は有効', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../data/breeding-state.json', import.meta.url), 'utf8'),
    );
    expect(isBreedingState(raw)).toBe(true);
  });

  it('形が壊れていたら拒否する', () => {
    expect(isBreedingState(null)).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), schemaVersion: 2 })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), consecutiveFailures: -1 })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), consecutiveFailures: 1.5 })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), aiCalls: { bad: 1 } })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), aiCalls: { '2026-11-09': -1 } })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), lastSuccessAt: 123 })).toBe(false);
  });

  it('lastSlot は JST枠キーだけ受理し、無い旧ファイルも受け入れる（issue #41）', () => {
    expect(isBreedingState({ ...initialBreedingState(), lastSlot: '2026-11-10T1300JST' })).toBe(true);
    expect(isBreedingState({ ...initialBreedingState(), lastSlot: null })).toBe(true);
    expect(isBreedingState({ ...initialBreedingState(), lastSlot: 20261110 })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), lastSlot: '2026-11-10T13:00' })).toBe(false);
    expect(isBreedingState({ ...initialBreedingState(), lastSlot: '2026-11-10T1300UTC' })).toBe(false);
    // lastSlot の無い既存ファイル（issue #41 より前の保存分）も壊れない
    const legacy: Record<string, unknown> = { ...initialBreedingState() };
    delete legacy.lastSlot;
    expect(isBreedingState(legacy)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 時間帯別配合（issue #41）
// JST 13:00〜21:00 = 30分枠16回 / 21:00〜翌13:00 = 2時間枠8回 = 1日24枠
// ---------------------------------------------------------------------------

const WINDOWS: BreedingWindow[] = [
  { startJst: '13:00', endJst: '21:00', intervalMinutes: 30 },
  { startJst: '21:00', endJst: '13:00', intervalMinutes: 120 },
];
const wcfg = (over: Partial<ScheduleConfig> = {}): ScheduleConfig => ({
  ...cfg(),
  breedingWindows: WINDOWS,
  ...over,
});

describe('breedingWindows の検証（issue #41 §1）', () => {
  it('24時間を隙間・重複なく覆う連続した区間だけ受理する', () => {
    expect(parseScheduleConfig({ ...cfg(), breedingWindows: WINDOWS }).ok).toBe(true);
    // 開始＝終了は24時間ぶんの1区間として許可
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '00:00', endJst: '00:00', intervalMinutes: 60 }] }).ok,
    ).toBe(true);
    // 24時間を覆わない単独区間は不可（= 時間帯の外が発生するため）
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '13:00', endJst: '21:00', intervalMinutes: 30 }] }).ok,
    ).toBe(false);
    // 隙間
    expect(
      parseScheduleConfig({
        ...cfg(),
        breedingWindows: [WINDOWS[0], { startJst: '21:30', endJst: '13:00', intervalMinutes: 120 }],
      }).ok,
    ).toBe(false);
    // 重複
    expect(
      parseScheduleConfig({
        ...cfg(),
        breedingWindows: [WINDOWS[0], { startJst: '20:00', endJst: '13:00', intervalMinutes: 120 }],
      }).ok,
    ).toBe(false);
    // 並びの起点はどこからでもよい（連続して24時間を覆っていれば受理）
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [WINDOWS[1], WINDOWS[0]] }).ok,
    ).toBe(true);
    // 時刻表記・形・間隔の不正
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '9:00', endJst: '21:00', intervalMinutes: 30 }] }).ok,
    ).toBe(false);
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '24:00', endJst: '21:00', intervalMinutes: 30 }] }).ok,
    ).toBe(false);
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '13:00', endJst: '21:00', intervalMinutes: 1.5 }] }).ok,
    ).toBe(false);
    // 区間の長さが間隔で割り切れない（480分 ÷ 45分）
    expect(
      parseScheduleConfig({ ...cfg(), breedingWindows: [{ startJst: '13:00', endJst: '21:00', intervalMinutes: 45 }] }).ok,
    ).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingWindows: [] }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingWindows: '13:00' }).ok).toBe(false);
    expect(parseScheduleConfig({ ...cfg(), breedingWindows: [null] }).ok).toBe(false);
    // 読めない場合は理由が返る（ワーカーはここで exit 1 = AIを呼ばない）
    const bad = parseScheduleConfig({ ...cfg(), breedingWindows: [] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('breedingWindows');
    // フォールバック（表示用の既定値）には従来の間隔モードのまま
    expect(FALLBACK_SCHEDULE.breedingWindows).toBeUndefined();
  });
});

describe('配合枠の計算（JST基準 / issue #41 §2・境界条件）', () => {
  const slotAt = (iso: string) => currentBreedingSlot(wcfg(), T(iso));

  it('JST 12:59 は2時間帯の枠', () => {
    // 2026-11-10T03:59Z = JST 12:59 → 枠は JST 11:00 はじまり
    expect(slotAt('2026-11-10T03:59:00Z')).toMatchObject({
      key: '2026-11-10T1100JST',
      startLabel: '2026-11-10 11:00',
      intervalMinutes: 120,
    });
  });

  it('JST 13:00 で30分帯に切り替わる', () => {
    expect(slotAt('2026-11-10T04:00:00Z')).toMatchObject({
      key: '2026-11-10T1300JST',
      startLabel: '2026-11-10 13:00',
      intervalMinutes: 30,
    });
    // 枠の途中（13:29）でも同じ枠
    expect(slotAt('2026-11-10T04:29:00Z')?.key).toBe('2026-11-10T1300JST');
  });

  it('JST 20:30 は30分帯の最後の枠', () => {
    expect(slotAt('2026-11-10T11:30:00Z')).toMatchObject({
      key: '2026-11-10T2030JST',
      intervalMinutes: 30,
    });
    expect(slotAt('2026-11-10T11:59:00Z')?.key).toBe('2026-11-10T2030JST');
  });

  it('JST 21:00 で2時間帯に切り替わる', () => {
    expect(slotAt('2026-11-10T12:00:00Z')).toMatchObject({
      key: '2026-11-10T2100JST',
      intervalMinutes: 120,
    });
  });

  it('日付をまたいでもJST基準で枠を求める', () => {
    // 2026-11-09T15:30Z = JST 11-10 00:30 → 枠は JST 11-09 23:00 はじまり
    expect(slotAt('2026-11-09T15:30:00Z')).toMatchObject({
      key: '2026-11-09T2300JST',
      startLabel: '2026-11-09 23:00',
      intervalMinutes: 120,
    });
    expect(slotAt('2026-11-09T14:59:00Z')?.key).toBe('2026-11-09T2300JST'); // JST 11-09 23:59
  });

  it('枠キーは lastSlot に保存できる形式（UTCスロットと区別できる）', () => {
    const slot = slotAt('2026-11-10T04:00:00Z');
    expect(slot?.key).toMatch(BREEDING_SLOT_KEY_RE);
    expect(slot?.key).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/); // offspring の slot 形式とは別
  });

  it('時間帯設定が無ければ枠は計算しない（従来モード）', () => {
    expect(currentBreedingSlot(cfg(), T('2026-11-10T04:00:00Z'))).toBeNull();
    expect(nextBreedingSlotStart(cfg(), T('2026-11-10T04:00:00Z'))).toBeNull();
    // 覆っていない時間帯は null（parse では弾かれるが、直接組んだ設定でも安全側に倒す）
    const partial = cfg({ breedingWindows: [{ startJst: '13:00', endJst: '21:00', intervalMinutes: 30 }] });
    expect(currentBreedingSlot(partial, T('2026-11-10T03:59:00Z'))).toBeNull();
  });

  it('次の枠の開始時刻を返す（UIの目安 / issue #41 §9）', () => {
    // JST 13:05 → 次は JST 13:30（UTC 04:30Z）
    expect(nextBreedingSlotStart(wcfg(), T('2026-11-10T04:05:00Z'))?.toISOString()).toBe('2026-11-10T04:30:00.000Z');
    // JST 20:59 → 次は JST 21:00（時間帯が変わっても枠は連続する）
    expect(nextBreedingSlotStart(wcfg(), T('2026-11-10T11:59:00Z'))?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
    // JST 21:05 → 次は JST 23:00（2時間枠）
    expect(nextBreedingSlotStart(wcfg(), T('2026-11-10T12:05:00Z'))?.toISOString()).toBe('2026-11-10T14:00:00.000Z');
  });
});

describe('shouldBreed（時間帯別モード / issue #41 §5・§6・§8）', () => {
  it('同じ配合枠で二重生成しない（実行済み枠の永続化）', () => {
    const now = T('2026-11-10T04:06:00Z'); // JST 13:06 = 13:00枠
    const done = { ...initialBreedingState(), lastSlot: '2026-11-10T1300JST' };
    const blocked = shouldBreed(done, wcfg(), now);
    expect(blocked.run).toBe(false);
    expect(blocked.reason).toContain('二重生成');
    expect(blocked.reason).toContain('2026-11-10 13:00');
    // 次の枠（JST 13:30）になれば実行できる
    expect(shouldBreed(done, wcfg(), T('2026-11-10T04:36:00Z')).run).toBe(true);
    // 失敗だけなら枠は消費されないので、同じ枠内でも再試行できる（issue #41 §8）
    const failed = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-10T04:06:00Z',
      consecutiveFailures: 1,
    };
    const retry = shouldBreed(failed, wcfg(), now);
    expect(retry.run).toBe(true);
    expect(retry.reason).toContain('再試行');
    // 従来モードは lastSlot を見ない（後方互換）
    expect(shouldBreed(done, cfg(), T('2026-11-10T12:30:00Z')).run).toBe(true);
  });

  it('遅延した実行は「現在の1枠だけ」を見る（過去の枠をまとめて処理しない）', () => {
    // JST 13:00枠で何も生成できなかったまま JST 13:45 に起床したケース
    const fresh = shouldBreed(initialBreedingState(), wcfg(), T('2026-11-10T04:45:00Z'));
    expect(fresh.run).toBe(true);
    expect(fresh.reason).toContain('2026-11-10 13:30'); // 判定対象はいまの枠のみ
    // 13:30枠が処理済みなら、遅延しても同じ枠では生成しない
    const done = { ...initialBreedingState(), lastSlot: '2026-11-10T1330JST' };
    expect(shouldBreed(done, wcfg(), T('2026-11-10T04:50:00Z')).run).toBe(false);
    // 13:00枠の実績があっても、13:30枠なら実行できる（枠ごとに最大1件）
    const earlier = { ...initialBreedingState(), lastSlot: '2026-11-10T1300JST' };
    expect(shouldBreed(earlier, wcfg(), T('2026-11-10T04:36:00Z')).run).toBe(true);
  });

  it('連続失敗の冷却はその時間帯の間隔で計算する（30分帯=30分 / 2時間帯=2時間）', () => {
    const day: ReturnType<typeof initialBreedingState> = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-10T04:05:00Z', // JST 13:05
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    };
    expect(shouldBreed(day, wcfg(), T('2026-11-10T04:15:00Z')).run).toBe(false); // 10分 < 30分
    expect(shouldBreed(day, wcfg(), T('2026-11-10T04:36:00Z')).run).toBe(true); // 31分 ≥ 30分

    const night = {
      ...initialBreedingState(),
      lastAttemptAt: '2026-11-10T12:10:00Z', // JST 21:10
      consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    };
    expect(shouldBreed(night, wcfg(), T('2026-11-10T12:30:00Z')).run).toBe(false); // 20分 < 2時間
    expect(shouldBreed(night, wcfg(), T('2026-11-10T14:15:00Z')).run).toBe(true); // 125分 ≥ 2時間
  });

  it('日次AI上限は時間帯別モードでも効く（issue #41 §8）', () => {
    const c = wcfg({ dailyAiCallLimit: 1 });
    const state = { ...initialBreedingState(), aiCalls: { '2026-11-10': 1 } };
    const blocked = shouldBreed(state, c, T('2026-11-10T04:06:00Z'));
    expect(blocked.run).toBe(false);
    expect(blocked.reason).toContain('上限');
    expect(shouldBreed(state, c, T('2026-11-11T04:06:00Z')).run).toBe(true); // UTC日が変われば再開
  });

  it('1日あたりの枠数は設定から計算する（16 + 8 = 24 / issue #41 完了条件）', () => {
    expect(breedingSlotsPerDay(wcfg())).toBe(24);
    expect(breedingSlotsPerDay(cfg())).toBe(24); // 従来: 1440 ÷ 60
    expect(breedingSlotsPerDay(cfg({ breedingIntervalMinutes: 30 }))).toBe(48);
  });
});

describe('recordBreedingAttempt（実行済み枠の保存 / issue #41 §5）', () => {
  it('成功した枠を lastSlot に保存する', () => {
    const s = recordBreedingAttempt(initialBreedingState(), wcfg(), {
      now: T('2026-11-10T04:06:00Z'), // JST 13:06 = 13:00枠
      success: true,
    });
    expect(s.lastSlot).toBe('2026-11-10T1300JST');
    expect(isBreedingState(s)).toBe(true);
    // 時刻をずらしても同じ枠なら同じキー（13:29でも 13:00枠）
    const late = recordBreedingAttempt(initialBreedingState(), wcfg(), {
      now: T('2026-11-10T04:29:00Z'),
      success: true,
    });
    expect(late.lastSlot).toBe('2026-11-10T1300JST');
  });

  it('失敗では枠を消費しない（同枠で再試行できる）', () => {
    const s = recordBreedingAttempt(
      { ...initialBreedingState(), lastSlot: '2026-11-10T1300JST' },
      wcfg(),
      { now: T('2026-11-10T04:21:00Z'), success: false }, // JST 13:21 = 同じ13:00枠
    );
    expect(s.lastSlot).toBe('2026-11-10T1300JST');
    expect(s.consecutiveFailures).toBe(1);
    // 初回の失敗（まだ枠の記録が無い）でも lastSlot は作られない
    const firstFail = recordBreedingAttempt(initialBreedingState(), wcfg(), {
      now: T('2026-11-10T04:21:00Z'),
      success: false,
    });
    expect(firstFail.lastSlot).toBeNull();
  });

  it('時間帯設定が無い（従来モード）ときは lastSlot を作らない', () => {
    const s = recordBreedingAttempt(initialBreedingState(), cfg(), {
      now: T('2026-11-10T04:06:00Z'),
      success: true,
    });
    expect(s.lastSlot).toBeNull();
    expect(s.lastSuccessAt).toBe('2026-11-10T04:06:00.000Z');
  });
});

describe('時間帯別設定の文言（issue #41 §9）', () => {
  it('頻度の説明は設定から生成される（固定文言なし）', () => {
    expect(breedingFreqLabel(wcfg())).toBe('13:00〜21:00は30分ごと・21:00〜13:00は2時間ごと（日本時間）');
    expect(breedingFreqLabel(cfg())).toBe('1時間'); // 従来モードは間隔ラベルのまま
  });

  it('配合の案内文に時間帯と1日の枠数が入る', () => {
    const notice = breedingNotice(wcfg());
    expect(notice).toContain('13:00〜21:00は30分ごと');
    expect(notice).toContain('21:00〜13:00は2時間ごと');
    expect(notice).toContain('日本時間');
    expect(notice).toContain('新しい発明が誕生します！');

    const share = breedingShareText(wcfg());
    expect(share).toContain('1日最大24枠');
    expect(share).toContain('全ユーザー共有');
    expect(share).not.toContain('毎時');
    // 従来モードの文言は従来のまま（既存UIテストとの互換）
    expect(breedingNotice(cfg({ breedingIntervalMinutes: 180 }))).toBe('3時間に最大1つ、新しい発明が誕生します！');
    expect(breedingShareText(cfg())).toContain('1時間に最大1件、全ユーザー共有');
  });
});
