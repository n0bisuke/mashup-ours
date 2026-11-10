import { describe, expect, it } from 'vitest';
import {
  CANDIDATES_PER_SLOT,
  buildCandidatesFile,
  candidateSlotKey,
  hashSlot,
  isCandidatesFile,
  nextSlotKey,
  selectCandidates,
  selectOffspringCandidate,
} from '../lib/candidates.ts';
import { PROTOPEDIA_SITE_BASE } from '../lib/protopedia.ts';
import type { ProtopediaWork } from '../lib/types.ts';

function work(n: number): ProtopediaWork {
  return {
    id: `protopedia:${n}`,
    title: `作品${n}`,
    sourceUrl: `${PROTOPEDIA_SITE_BASE}/prototype/${n}`,
    summary: 's',
    generation: 0,
  };
}

const pool = Array.from({ length: 12 }, (_, i) => work(i + 1));

describe('selectCandidates', () => {
  it('同じスロットなら常に同じ候補（決定的選出）', () => {
    const a = selectCandidates(pool, '2026-11-09T1400').map((w) => w.id);
    const b = selectCandidates(pool, '2026-11-09T1400').map((w) => w.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(CANDIDATES_PER_SLOT);
  });

  it('入力ファイルの並び順に依存しない（ID昇順で正規化してから選ぶ）', () => {
    const reversed = [...pool].reverse();
    const a = selectCandidates(pool, '2026-11-09T1400').map((w) => w.id);
    const b = selectCandidates(reversed, '2026-11-09T1400').map((w) => w.id);
    expect(a).toEqual(b);
  });

  it('重複したIDを排除し、候補にも重複は出ない', () => {
    const dup = [...pool, ...pool.slice(0, 3)];
    const picked = selectCandidates(dup, '2026-11-09T1400');
    const ids = picked.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(picked.length).toBeLessThanOrEqual(CANDIDATES_PER_SLOT);
  });

  it('異なるスロットは（ほぼ確実に）別の並びになる', () => {
    const a = selectCandidates(pool, '2026-11-09T1400').map((w) => w.id);
    const b = selectCandidates(pool, '2026-11-09T1415').map((w) => w.id);
    expect(a).not.toEqual(b);
    // 1枠6件の全ユーザー共通はスロットに従う（プール内なら常に同じメンバー集合）
    expect(a).toHaveLength(CANDIDATES_PER_SLOT);
  });

  it('プールが6件未満ならその件数まで（15分枠あたり「最大」6件）', () => {
    const small = [work(3), work(1), work(2)];
    expect(selectCandidates(small, '2026-11-09T1400')).toHaveLength(3);
  });

  it('プールが空なら空配列', () => {
    expect(selectCandidates([], '2026-11-09T1400')).toEqual([]);
  });

  it('hashSlot は同じ入力で同じ値', () => {
    expect(hashSlot('2026-11-09T1400')).toBe(hashSlot('2026-11-09T1400'));
    expect(hashSlot('2026-11-09T1400')).not.toBe(hashSlot('2026-11-09T1415'));
  });
});

describe('candidateSlotKey（15分境界への切り下げ）', () => {
  it('UTCの15分枠（00/15/30/45）へ切り下げて HHMM を返す', () => {
    expect(candidateSlotKey(new Date('2026-11-09T14:04:59Z'))).toBe('2026-11-09T1400');
    expect(candidateSlotKey(new Date('2026-11-09T14:19:00Z'))).toBe('2026-11-09T1415');
    expect(candidateSlotKey(new Date('2026-11-09T14:44:00Z'))).toBe('2026-11-09T1430');
    expect(candidateSlotKey(new Date('2026-11-09T14:59:59Z'))).toBe('2026-11-09T1445');
  });

  it('15分枠内の異なる時刻でも同じスロット（再実行でも候補が変わらない）', () => {
    expect(candidateSlotKey(new Date('2026-11-09T14:04:00Z'))).toBe(
      candidateSlotKey(new Date('2026-11-09T14:14:00Z')),
    );
  });

  it('日跨ぎも正しく切り下げる', () => {
    expect(candidateSlotKey(new Date('2026-11-09T23:50:00Z'))).toBe('2026-11-09T2345');
  });
});

describe('nextSlotKey', () => {
  it('次の15分枠へ進める（日跨ぎ・枠跨ぎを含む）', () => {
    expect(nextSlotKey('2026-11-09T1400')).toBe('2026-11-09T1415');
    expect(nextSlotKey('2026-11-09T1445')).toBe('2026-11-09T1500');
    expect(nextSlotKey('2026-11-09T2345')).toBe('2026-11-10T0000');
    expect(nextSlotKey('2026-12-31T2345')).toBe('2027-01-01T0000');
  });

  it('形式不正は例外（従来の時間枠 HH も受付けない）', () => {
    expect(() => nextSlotKey('2026-11-09')).toThrow('slot');
    expect(() => nextSlotKey('2026-11-09T14')).toThrow('slot');
    expect(() => nextSlotKey('bad')).toThrow('slot');
  });
});

// --- スロット間隔の設定化（config/schedule.json / issue #15） -----------------

describe('スロット間隔パラメータ（間隔は設定値 / issue #15）', () => {
  it('指定した間隔の境界へ切り下げる（60分・120分・10分）', () => {
    expect(candidateSlotKey(new Date('2026-11-09T14:07:00Z'), 60)).toBe('2026-11-09T1400');
    expect(candidateSlotKey(new Date('2026-11-09T14:59:00Z'), 60)).toBe('2026-11-09T1400');
    expect(candidateSlotKey(new Date('2026-11-09T15:00:00Z'), 60)).toBe('2026-11-09T1500');
    // 120分は2時間境界（UTCは日跨ぎなくエポック基準で切れる）
    expect(candidateSlotKey(new Date('2026-11-09T14:37:00Z'), 120)).toBe('2026-11-09T1400');
    expect(candidateSlotKey(new Date('2026-11-09T14:07:00Z'), 10)).toBe('2026-11-09T1400');
    expect(candidateSlotKey(new Date('2026-11-09T14:12:00Z'), 10)).toBe('2026-11-09T1410');
    // 60で割り切れない間隔でもエポック基準で正しく切れる（1440%7=5 の日跨ぎシフトも含む）
    expect(candidateSlotKey(new Date('2026-11-09T23:58:00Z'), 7)).toBe('2026-11-09T2356');
  });

  it('間隔が不正なら例外（0・小数は受け付けない）', () => {
    expect(() => candidateSlotKey(new Date(), 0)).toThrow('slotMinutes');
    expect(() => candidateSlotKey(new Date(), -15)).toThrow('slotMinutes');
    expect(() => candidateSlotKey(new Date(), 1.5)).toThrow('slotMinutes');
    expect(() => nextSlotKey('2026-11-09T1400', 0)).toThrow('slotMinutes');
  });

  it('nextSlotKey は指定間隔で進める', () => {
    expect(nextSlotKey('2026-11-09T1400', 60)).toBe('2026-11-09T1500');
    expect(nextSlotKey('2026-11-09T1400', 120)).toBe('2026-11-09T1600');
    expect(nextSlotKey('2026-11-09T2345', 15)).toBe('2026-11-10T0000');
  });

  it('buildCandidatesFile は opts で件数と次枠を変える', () => {
    const few = buildCandidatesFile(pool, '2026-11-09T1400', 'data/sample-prototypes.json', new Date(), {
      maxCandidates: 3,
    });
    expect(few.candidates).toHaveLength(3);
    const hourly = buildCandidatesFile(pool, '2026-11-09T1400', 'data/sample-prototypes.json', new Date(), {
      slotMinutes: 60,
    });
    expect(hourly.nextSlot).toBe('2026-11-09T1500');
  });

  it('isCandidatesFile は maxCandidates 引数で上限判定する', () => {
    const f = buildCandidatesFile(pool, '2026-11-09T1400', 'data/sample-prototypes.json', new Date(), {
      maxCandidates: 8,
    });
    expect(f.candidates).toHaveLength(8);
    expect(isCandidatesFile(f, 8)).toBe(true);
    expect(isCandidatesFile(f, 6)).toBe(false); // 既定上限なら拒否
    expect(isCandidatesFile(f)).toBe(false); // 引数省略 = 既定6
  });
});

describe('buildCandidatesFile', () => {
  it('slot / generatedAt / nextSlot / 候補を記録する', () => {
    const now = new Date('2026-11-09T14:05:00Z');
    const f = buildCandidatesFile(pool, '2026-11-09T1400', 'data/sample-prototypes.json', now);
    expect(f.schemaVersion).toBe(1);
    expect(f.slot).toBe('2026-11-09T1400');
    expect(f.generatedAt).toBe('2026-11-09T14:05:00.000Z');
    expect(f.nextSlot).toBe('2026-11-09T1415');
    expect(f.source).toBe('data/sample-prototypes.json');
    expect(f.candidates).toHaveLength(CANDIDATES_PER_SLOT);
    expect(isCandidatesFile(f)).toBe(true);
  });

  it('プール0件は例外（既存JSONを更新させない）', () => {
    expect(() => buildCandidatesFile([], '2026-11-09T1400', 'x')).toThrow('プール');
  });
});

describe('isCandidatesFile（フロント読み込みガード）', () => {
  const valid = () =>
    buildCandidatesFile(pool, '2026-11-09T1400', 'data/sample-prototypes.json', new Date('2026-11-09T14:01:00Z'));

  it('正常な形を通す', () => {
    expect(isCandidatesFile(valid())).toBe(true);
  });

  it('制作状態 status は 1..99 の整数のみ許可（欠損はOK / issue #29）', () => {
    const ok = valid();
    expect(isCandidatesFile({ ...ok, candidates: [{ ...ok.candidates[0], status: 4 }, ...ok.candidates.slice(1)] })).toBe(
      true,
    );
    const f = valid();
    for (const bad of [0, -1, 1.5, '供養', null, 100]) {
      expect(
        isCandidatesFile({ ...f, candidates: [{ ...f.candidates[0], status: bad }, ...f.candidates.slice(1)] }),
        `status=${JSON.stringify(bad)} は拒否されるべき`,
      ).toBe(false);
    }
  });

  it('オブジェクトでない・欠損・型不正を拒否する', () => {
    expect(isCandidatesFile(null)).toBe(false);
    expect(isCandidatesFile([])).toBe(false);
    expect(isCandidatesFile({ schemaVersion: 2 })).toBe(false);
    const f = valid();
    expect(isCandidatesFile({ ...f, slot: 'bad' })).toBe(false);
    expect(isCandidatesFile({ ...f, candidates: [] })).toBe(false);
    expect(isCandidatesFile({ ...f, generatedAt: 'not-a-date' })).toBe(false);
  });

  it('候補が7件以上（15分枠6件の上限超過）を拒否する', () => {
    const f = valid();
    expect(isCandidatesFile({ ...f, candidates: [...f.candidates, work(99)] })).toBe(false);
  });

  it('候補内のID重複・不正ID・不正URLを拒否する', () => {
    const f = valid();
    expect(isCandidatesFile({ ...f, candidates: [f.candidates[0], f.candidates[0], ...f.candidates.slice(2)] })).toBe(
      false,
    );
    expect(
      isCandidatesFile({
        ...f,
        candidates: [{ ...f.candidates[0], id: 'github:1' }, ...f.candidates.slice(1)],
      }),
    ).toBe(false);
    expect(
      isCandidatesFile({
        ...f,
        candidates: [{ ...f.candidates[0], sourceUrl: 'http://insecure' }, ...f.candidates.slice(1)],
      }),
    ).toBe(false);
  });
});

// --- AI生成アイデアの候補（issue #36） ---------------------------------------

const OFF_IDS = ['mashup-000001', 'mashup-000002', 'mashup-000003'];

describe('selectOffspringCandidate', () => {
  it('1枠に1件だけ選ぶ（ProtoPedia候補と合計が上限を超えない）', () => {
    const picked = selectOffspringCandidate(OFF_IDS, '2026-11-10T0515');
    expect(picked).toMatch(/^mashup-\d{1,9}$/);
    expect(OFF_IDS).toContain(picked);
  });

  it('同じスロットなら常に同じ1件（決定的・全ユーザー共通・再読込でも不変）', () => {
    expect(selectOffspringCandidate(OFF_IDS, '2026-11-10T0515')).toBe(
      selectOffspringCandidate(OFF_IDS, '2026-11-10T0515'),
    );
    // 並び順に依存しない
    expect(selectOffspringCandidate([...OFF_IDS].reverse(), '2026-11-10T0515')).toBe(
      selectOffspringCandidate(OFF_IDS, '2026-11-10T0515'),
    );
  });

  it('スロットが変われば（ほぼ確実に）別の1件になる', () => {
    // 3件から1件なので偶然一致しうる。複数スロットで全部同じなら決定的選出として不正。
    const picks = ['2026-11-10T0515', '2026-11-10T0530', '2026-11-10T0545', '2026-11-10T0600'].map(
      (s) => selectOffspringCandidate(OFF_IDS, s),
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
  });

  it('重複ID・不正IDは除外し、1件だけ返す', () => {
    const picked = selectOffspringCandidate(
      ['mashup-000001', 'mashup-000001', 'protopedia:93', '', 'bad-id', 'mashup-999999999999'],
      '2026-11-10T0515',
    );
    expect(picked).toBe('mashup-000001');
  });

  it('候補が無いときは null（= ProtoPedia 6件で埋める）', () => {
    expect(selectOffspringCandidate([], '2026-11-10T0515')).toBeNull();
    expect(selectOffspringCandidate(['protopedia:93'], '2026-11-10T0515')).toBeNull();
  });
});

describe('buildCandidatesFile（AI生成1件を含む候補 / issue #36）', () => {
  it('合計6件 = ProtoPedia 5件 + AI生成 1件', () => {
    const f = buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date(), {
      offspringIds: OFF_IDS,
    });
    expect(f.candidates).toHaveLength(CANDIDATES_PER_SLOT - 1);
    expect(f.offspringCandidates).toHaveLength(1);
    expect(f.candidates.length + (f.offspringCandidates?.length ?? 0)).toBe(CANDIDATES_PER_SLOT);
    expect(isCandidatesFile(f)).toBe(true);
  });

  it('AI生成候補が0件なら従来どおり ProtoPedia 6件（offspringCandidates は付けない）', () => {
    const f = buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date(), {
      offspringIds: [],
    });
    expect(f.candidates).toHaveLength(CANDIDATES_PER_SLOT);
    expect(f.offspringCandidates).toBeUndefined();
    expect(isCandidatesFile(f)).toBe(true);
  });

  it('ProtoPedia候補は1件以上を確保（AI生成だけで埋めない）', () => {
    const f = buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date(), {
      maxCandidates: 2,
      offspringIds: OFF_IDS,
    });
    expect(f.candidates.length).toBe(1);
    expect(f.offspringCandidates).toHaveLength(1);
    expect(isCandidatesFile(f, 2)).toBe(true);
  });

  it('AI生成の実体はIDだけ（候補JSONに発明本文を複写しない）', () => {
    const f = buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date(), {
      offspringIds: OFF_IDS,
    });
    const json = JSON.stringify(f);
    expect(json).not.toContain('コンセプト'); // 本文は data/offspring.json 側だけにある
    expect(f.offspringCandidates?.[0]).toMatch(/^mashup-\d{1,9}$/);
  });
});

describe('isCandidatesFile（AI生成候補の検証 / issue #36）', () => {
  const withChild = () =>
    buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date(), {
      offspringIds: OFF_IDS,
    });

  it('offspringCandidates が無い旧ファイルは「AI生成なし」として受理する', () => {
    const f = withChild();
    const { offspringCandidates: _omitted, ...legacy } = f;
    expect(isCandidatesFile(legacy)).toBe(true);
  });

  it('不正なID・重複を拒否する', () => {
    const f = withChild();
    expect(isCandidatesFile({ ...f, offspringCandidates: ['protopedia:93'] })).toBe(false);
    expect(isCandidatesFile({ ...f, offspringCandidates: ['github:1'] })).toBe(false);
    expect(isCandidatesFile({ ...f, offspringCandidates: ['mashup-000001', 'mashup-000001'] })).toBe(
      false,
    );
    expect(isCandidatesFile({ ...f, offspringCandidates: 'mashup-000001' })).toBe(false);
  });

  it('合計が上限を超えたら拒否する（ProtoPedia 6件 + AI 1件 = 7件にはならない）', () => {
    const proto6 = buildCandidatesFile(pool, '2026-11-10T0515', 'data/sample-prototypes.json', new Date());
    expect(proto6.candidates).toHaveLength(CANDIDATES_PER_SLOT);
    expect(isCandidatesFile({ ...proto6, offspringCandidates: ['mashup-000001'] })).toBe(false);
  });
});
