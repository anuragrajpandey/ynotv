// zustand's persist middleware reads localStorage when a store module is
// imported — stub it here (setupFiles run before any test-file imports) so
// store tests can hydrate in a node environment.
const storageMap = new Map<string, string>();

const storageObj = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => void storageMap.set(key, value),
  removeItem: (key: string) => void storageMap.delete(key),
  clear: () => void storageMap.clear(),
};

Object.defineProperty(globalThis, 'localStorage', {
  value: storageObj,
  configurable: true,
  writable: true,
});

if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: storageObj,
      __TAURI_INTERNALS__: {
        invoke: () => Promise.resolve([]),
      },
    },
    configurable: true,
    writable: true,
  });
} else {
  (globalThis as unknown as { window: { localStorage?: unknown } }).window.localStorage = storageObj;
}

