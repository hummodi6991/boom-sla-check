const store = new Map<string, string>();
export const redis = {
  async get(key: string) {
    return store.get(key) ?? null;
  },
  async set(key: string, value: string, _opts?: any) {
    store.set(key, value);
  },
};
