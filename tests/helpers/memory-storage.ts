/**
 * テスト用の localStorage 差し込み（issue #26 / 選択の永続化）。
 *
 * この環境では happy-dom + Node の `--localstorage-file` 未指定のため、
 * グローバルの `localStorage` が `undefined` になる
 * （`ExperimentalWarning: localStorage is not available...`）。
 * ブラウザ本体では問題ないが、テストでは保存が黙って失敗するので、
 * boot() のたびにメモリ実装を差し込んでリセットする。
 *
 * ※ vitest の include は tests 配下の .test.ts のみ。このヘルパーは拾われない。
 */

export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

/** 空のストレージを新しく差し込む（= 再読み込み前の状態を消す）。 */
export function installMemoryStorage(): void {
  const store = new Map<string, string>();
  const api: MemoryStorage = {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: api,
    configurable: true,
    writable: true,
  });
}
