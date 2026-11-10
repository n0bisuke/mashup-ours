import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_AUTO_REQUEST_IDLE_HOURS,
  FALLBACK_SCHEDULE,
  MAX_CONSECUTIVE_FAILURES,
  breedingNotice,
  breedingShareText,
  candidateChipText,
  candidateNotice,
  initialBreedingState,
  intervalLabel,
  isBreedingState,
  parseScheduleConfig,
  recordBreedingAttempt,
  resolveSchedule,
  shouldBreed,
  utcDay,
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
});
