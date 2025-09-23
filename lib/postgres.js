import { Pool } from 'pg';

const NOT_CONFIGURED_CODE = 'PG_NOT_CONFIGURED';

class DbNotConfiguredError extends Error {
  constructor(message = 'Postgres connection is not configured') {
    super(message);
    this.name = 'DbNotConfiguredError';
    this.code = NOT_CONFIGURED_CODE;
  }
}

let pool;

function parseSsl() {
  const raw =
    process.env.PGSSL ??
    process.env.PG_SSL ??
    process.env.PGSSLMODE ??
    process.env.DATABASE_SSL ??
    '';
  if (!raw) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (!value || ['disable', 'off', 'false', '0', 'no', 'none'].includes(value)) {
    return undefined;
  }
  if (value === 'require') {
    return { rejectUnauthorized: false };
  }
  if (['verify-ca', 'verify-full'].includes(value)) {
    return { rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

function buildConfigFromEnv() {
  const connectionString =
    process.env.DATABASE_URL ??
    process.env.PG_URL ??
    process.env.POSTGRES_URL ??
    '';
  const trimmed = connectionString.trim();
  if (trimmed) {
    const cfg = { connectionString: trimmed };
    const ssl = parseSsl();
    if (ssl) cfg.ssl = ssl;
    return cfg;
  }

  const host = process.env.PGHOST ?? process.env.PG_HOST ?? '';
  const database = process.env.PGDATABASE ?? process.env.PG_DATABASE ?? '';
  const user = process.env.PGUSER ?? process.env.PG_USER ?? '';
  const password = process.env.PGPASSWORD ?? process.env.PG_PASSWORD ?? '';
  const port = process.env.PGPORT ?? process.env.PG_PORT ?? '';

  if (![host, database, user, password, port].some((v) => String(v || '').trim())) {
    return null;
  }

  const config = {};
  if (host.trim()) config.host = host.trim();
  if (database.trim()) config.database = database.trim();
  if (user.trim()) config.user = user.trim();
  if (password.trim()) config.password = password.trim();
  if (port.trim()) {
    const num = Number(port);
    if (Number.isFinite(num)) config.port = num;
  }
  const ssl = parseSsl();
  if (ssl) config.ssl = ssl;
  return config;
}

function getPool() {
  if (pool) return pool;
  const config = buildConfigFromEnv();
  if (!config) {
    return null;
  }
  pool = new Pool(config);
  pool.on('error', (err) => {
    console.warn('Postgres pool error', err?.message || err);
  });
  return pool;
}

async function runQuery(text, params = []) {
  const activePool = getPool();
  if (!activePool) {
    throw new DbNotConfiguredError();
  }
  return activePool.query(text, params);
}

export const db = {
  async oneOrNone(text, params = []) {
    const result = await runQuery(text, params);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return rows.length ? rows[0] : null;
  },
  async query(text, params = []) {
    return runQuery(text, params);
  },
};

export { DbNotConfiguredError, NOT_CONFIGURED_CODE };

