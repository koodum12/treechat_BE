// In-memory store with the same contract as the Postgres one. Tests and local runs only.
export function createMemoryStore({ now = () => Date.now() } = {}) {
  const rows = new Map(); // `${ownerHex}/${ns}` → { data, version, updatedAt }
  const keyOf = (owner, ns) => `${owner.toString('hex')}/${ns}`;
  const countOwner = (owner) => [...rows.keys()].filter((k) => k.startsWith(`${owner.toString('hex')}/`)).length;

  return {
    async get(owner, ns) {
      const row = rows.get(keyOf(owner, ns));
      return row ? structuredClone(row) : null;
    },

    async put(owner, ns, data, baseVersion, maxTrees) {
      const key = keyOf(owner, ns);
      const current = rows.get(key);
      if (current ? current.version !== baseVersion : baseVersion !== null) {
        return { conflict: true, current: current ? structuredClone(current) : { data: null, version: null, updatedAt: null } };
      }
      if (!current && countOwner(owner) >= maxTrees) return { full: true };
      const row = { data: structuredClone(data), version: (current?.version ?? 0) + 1, updatedAt: new Date(now()).toISOString() };
      rows.set(key, row);
      return { version: row.version, updatedAt: row.updatedAt };
    },

    async deleteOwner(owner) {
      for (const key of [...rows.keys()]) if (key.startsWith(`${owner.toString('hex')}/`)) rows.delete(key);
    },

    async close() {},
  };
}
