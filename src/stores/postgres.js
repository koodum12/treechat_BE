import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trees (
  owner      bytea       NOT NULL,
  ns         text        NOT NULL,
  data       jsonb       NOT NULL,
  version    integer     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, ns)
)`;

const toRow = (r) => ({ data: r.data, version: r.version, updatedAt: r.updated_at.toISOString() });

export async function createPostgresStore(connectionString) {
  // Neon closes idle connections and suspends the compute; keep the pool small.
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => console.error('pg pool error:', err.code ?? err.name));
  await pool.query(SCHEMA);

  return {
    async get(owner, ns) {
      const { rows } = await pool.query('SELECT data, version, updated_at FROM trees WHERE owner = $1 AND ns = $2', [owner, ns]);
      return rows[0] ? toRow(rows[0]) : null;
    },

    // Optimistic concurrency: create needs baseVersion null, update needs the current version.
    async put(owner, ns, data, baseVersion, maxTrees) {
      const json = JSON.stringify(data);
      if (baseVersion === null) {
        const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM trees WHERE owner = $1', [owner]);
        if (count >= maxTrees) {
          const existing = await this.get(owner, ns);
          return existing ? { conflict: true, current: existing } : { full: true };
        }
        const { rows } = await pool.query(
          `INSERT INTO trees (owner, ns, data, version) VALUES ($1, $2, $3::jsonb, 1)
           ON CONFLICT (owner, ns) DO NOTHING RETURNING version, updated_at`,
          [owner, ns, json],
        );
        if (rows[0]) return { version: rows[0].version, updatedAt: rows[0].updated_at.toISOString() };
      } else {
        const { rows } = await pool.query(
          `UPDATE trees SET data = $3::jsonb, version = version + 1, updated_at = now()
           WHERE owner = $1 AND ns = $2 AND version = $4 RETURNING version, updated_at`,
          [owner, ns, json, baseVersion],
        );
        if (rows[0]) return { version: rows[0].version, updatedAt: rows[0].updated_at.toISOString() };
      }
      const current = await this.get(owner, ns);
      return { conflict: true, current: current ?? { data: null, version: null, updatedAt: null } };
    },

    async deleteOwner(owner) {
      await pool.query('DELETE FROM trees WHERE owner = $1', [owner]);
    },

    async close() {
      await pool.end();
    },
  };
}
