/**
 * 削除済みID台帳（lib/deleted-offspring.ts / issue #32）。
 * - 実台帳（data/deleted-offspring.json）から削除済みIDを読める
 * - ファイルが無ければ []（削除していない運用でも動く）
 * - 形が不正なら黙って続行せず例外（ID再利用を防ぐ）
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readDeletedOffspringIds } from '../lib/deleted-offspring.ts';

const dir = mkdtempSync(join(tmpdir(), 'mashup-deleted-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): URL {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return pathToFileURL(p);
}

describe('readDeletedOffspringIds', () => {
  it('実台帳から削除済みIDを読む（mashup-000001）', () => {
    expect(readDeletedOffspringIds()).toEqual(['mashup-000001']);
  });

  it('ファイルが無ければ []', () => {
    expect(readDeletedOffspringIds(pathToFileURL(join(dir, 'nope.json')))).toEqual([]);
  });

  it('正常な台帳を読む', () => {
    const url = write(
      'ok.json',
      JSON.stringify({ schemaVersion: 1, deletedIds: ['mashup-000004', 'mashup-000009'] }),
    );
    expect(readDeletedOffspringIds(url)).toEqual(['mashup-000004', 'mashup-000009']);
  });

  it('壊れたJSON・形が不正なら例外', () => {
    expect(() => readDeletedOffspringIds(write('broken.json', '{'))).toThrow(/JSON/);
    expect(() =>
      readDeletedOffspringIds(write('arr.json', JSON.stringify(['mashup-000001']))),
    ).toThrow(/オブジェクト/);
    expect(() =>
      readDeletedOffspringIds(write('ver.json', JSON.stringify({ schemaVersion: 2, deletedIds: [] }))),
    ).toThrow(/schemaVersion/);
    expect(() =>
      readDeletedOffspringIds(
        write('bad.json', JSON.stringify({ schemaVersion: 1, deletedIds: ['oops'] })),
      ),
    ).toThrow(/形式が不正/);
    expect(() =>
      readDeletedOffspringIds(
        write('dup.json', JSON.stringify({ schemaVersion: 1, deletedIds: ['mashup-000001', 'mashup-000001'] })),
      ),
    ).toThrow(/重複/);
  });
});
