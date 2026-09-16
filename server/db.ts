import pg from "pg";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Ensure environment variables are loaded if db.ts is executed in standalone scripts
if (!process.env.DATABASE_URL && !process.env.POSTGRES_DB) {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

const { Pool } = pg;

export interface DbHealthResult {
  status: "healthy" | "unhealthy" | "disconnected";
  latencyMs?: number;
  database?: string;
  error?: string;
}

let pool: pg.Pool | null = null;
let isInitialized = false;

function isPlaceholderValue(val?: string): boolean {
  if (!val) return true;
  const v = val.toLowerCase().trim();
  return (
    v === "" ||
    v.includes("replace_with_") ||
    v.includes("paste_your_") ||
    v.includes("your-password") ||
    v.includes("example.com") ||
    v.includes("your-project")
  );
}

/**
 * Resolves the PostgreSQL connection configuration from environment variables.
 */
export function getPostgresConfig(): {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
} {
  const rawConn =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.PG_URL ||
    "";

  const connectionString = !isPlaceholderValue(rawConn) ? rawConn.trim() : "";

  if (connectionString && connectionString.startsWith("postgres")) {
    // If connection string points to docker service 'postgres' but we are not inside docker compose
    if (connectionString.includes("@postgres:") && (process.env.K_SERVICE || !fs.existsSync("/.dockerenv"))) {
      // Host 'postgres' is unresolvable outside docker-compose network
      return {};
    }

    const isLocal =
      connectionString.includes("@localhost") ||
      connectionString.includes("@127.0.0.1") ||
      connectionString.includes("@postgres:") ||
      connectionString.includes("sslmode=disable");

    return {
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    };
  }

  const rawHost = process.env.POSTGRES_HOST || process.env.DB_HOST;
  const rawUser = process.env.POSTGRES_USER || process.env.DB_USER;
  const rawPassword = process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD;
  const rawDatabase = process.env.POSTGRES_DB || process.env.DB_NAME;

  if (
    !isPlaceholderValue(rawHost) &&
    !isPlaceholderValue(rawUser) &&
    !isPlaceholderValue(rawDatabase)
  ) {
    const host = rawHost!.trim();
    if (host === "postgres" && (process.env.K_SERVICE || !fs.existsSync("/.dockerenv"))) {
      return {};
    }

    const user = rawUser!.trim();
    const database = rawDatabase!.trim();
    const password = !isPlaceholderValue(rawPassword) ? rawPassword : "";
    const port = parseInt(process.env.POSTGRES_PORT || process.env.DB_PORT || "5432", 10);
    const isInternal = host === "postgres" || host === "localhost" || host === "127.0.0.1";

    return {
      host,
      port,
      database,
      user,
      password,
      ssl: isInternal ? false : { rejectUnauthorized: false },
    };
  }

  return {};
}

/**
 * Checks whether PostgreSQL configuration is provided.
 */
export function isPostgresConfigured(): boolean {
  const config = getPostgresConfig();
  return !!(config.connectionString || (config.host && config.database && config.user));
}

/**
 * Returns the singleton PostgreSQL connection pool with connection pooling & lifecycle hooks.
 */
export function getPostgresPool(): pg.Pool | null {
  if (!isPostgresConfigured()) {
    return null;
  }

  if (!pool) {
    const config = getPostgresConfig();
    const sanitizedTarget = config.connectionString
      ? config.connectionString.replace(/:[^:@]+@/, ":****@")
      : `${config.host}:${config.port}/${config.database}`;
    console.log(`[PostgreSQL] Initializing connection pool -> ${sanitizedTarget}`);

    pool = new Pool({
      ...config,
      max: parseInt(process.env.DB_POOL_MAX || "20", 10),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT || "5000", 10),
    });

    pool.on("error", (err) => {
      console.error("[PostgreSQL Pool Error]: Unexpected idle client error:", err.message);
    });

    console.log("[PostgreSQL] Connection pool initialized successfully.");
  }

  return pool;
}

/**
 * Gracefully shuts down the PostgreSQL connection pool.
 */
export async function closePostgresPool(): Promise<void> {
  if (pool) {
    console.log("[PostgreSQL] Closing connection pool...");
    await pool.end();
    pool = null;
    isInitialized = false;
    console.log("[PostgreSQL] Connection pool closed.");
  }
}

/**
 * Verifies database health with an active query and latency measurement.
 */
export async function checkPostgresHealth(): Promise<DbHealthResult> {
  const p = getPostgresPool();
  if (!p) {
    return { status: "disconnected", error: "DATABASE_URL not configured" };
  }

  const start = Date.now();
  try {
    const res = await p.query("SELECT current_database() as db, NOW() as current_time");
    const latencyMs = Date.now() - start;
    return {
      status: "healthy",
      latencyMs,
      database: res.rows[0]?.db || "vero",
    };
  } catch (err: any) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: err.message || "Failed to query database",
    };
  }
}

/**
 * Helper to safely format SQL column names or values.
 */
function escapeIdentifier(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Known JSON/JSONB columns across database tables for robust serialization.
 */
const KNOWN_JSON_COLUMNS: Record<string, Set<string>> = {
  products: new Set(["variants", "specifications"]),
  users: new Set(["addresses"]),
  orders: new Set(["returns", "timeline", "items"]),
  order_returns: new Set(["items"]),
  order_tracking_history: new Set(["metadata"]),
  audit_logs: new Set(["metadata"]),
  analytics_events: new Set(["event_data"]),
};

const GLOBAL_JSON_COLUMN_NAMES = new Set([
  "variants",
  "specifications",
  "addresses",
  "returns",
  "timeline",
  "items",
  "metadata",
  "event_data",
  "extra_data",
  "payload",
]);

/**
 * Known native PostgreSQL array columns (TEXT[] / _text) across tables.
 * These columns MUST NOT be serialized with JSON.stringify; they must be passed as JS arrays
 * of strings so that node-postgres formats them into PostgreSQL array literals: {"elem1","elem2"}
 */
const KNOWN_TEXT_ARRAY_COLUMNS: Record<string, Set<string>> = {
  users: new Set(["redeemed_rewards"]),
  products: new Set([
    "images",
    "secondary_images",
    "sizes",
    "size_options",
    "materials",
    "material_options",
    "colors",
    "details",
  ]),
};

const GLOBAL_TEXT_ARRAY_COLUMNS = new Set([
  "redeemed_rewards",
  "secondary_images",
  "size_options",
  "material_options",
  "details",
]);

// In-memory cache for dynamically discovered column data types from PostgreSQL information_schema
const columnTypesCache = new Map<string, Map<string, string>>();

async function loadTableColumnTypes(pool: pg.Pool, table: string): Promise<Map<string, string>> {
  const normTable = table.toLowerCase().trim();
  let cached = columnTypesCache.get(normTable);
  if (cached) return cached;

  const colMap = new Map<string, string>();
  columnTypesCache.set(normTable, colMap);

  try {
    const res = await pool.query(
      `SELECT column_name, data_type, udt_name 
       FROM information_schema.columns 
       WHERE table_schema = 'public' AND table_name = $1`,
      [normTable]
    );
    for (const row of res.rows) {
      const type = (row.udt_name || row.data_type || "").toLowerCase();
      colMap.set(row.column_name.toLowerCase(), type);
    }
  } catch (err: any) {
    console.warn(`[server/db.ts] Failed to query column types for ${normTable}:`, err?.message);
  }

  return colMap;
}

/**
 * Formats a JavaScript value safely for PostgreSQL parameterized query ($1, $2, etc.).
 * Handles JSON/JSONB columns properly by converting objects and arrays to JSON strings,
 * and handles PostgreSQL native array columns (TEXT[]) without malforming them.
 */
function formatParamValue(
  table: string,
  colName: string,
  val: any,
  tableColTypes?: Map<string, string>
): any {
  if (val === undefined || val === null) {
    return null;
  }

  const normTable = table.toLowerCase().trim();
  const normCol = colName.toLowerCase().trim();
  const udtType = tableColTypes?.get(normCol) || null;

  const isJsonColumn =
    udtType === "json" ||
    udtType === "jsonb" ||
    KNOWN_JSON_COLUMNS[normTable]?.has(normCol) ||
    GLOBAL_JSON_COLUMN_NAMES.has(normCol);

  if (isJsonColumn) {
    // Column expects JSON/JSONB in PostgreSQL
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) {
        return normCol === "metadata" || normCol === "event_data" ? "{}" : "[]";
      }
      try {
        JSON.parse(trimmed);
        // Already valid JSON string
        return trimmed;
      } catch {
        // Raw plain string (not valid JSON) -> safely serialize as JSON string
        return JSON.stringify(trimmed);
      }
    }

    // If it's an object or array, ALWAYS serialize with JSON.stringify!
    // Never pass a raw JavaScript array to pg for a JSON/JSONB column,
    // because pg will format it with PostgreSQL array syntax {"item"} which causes:
    // "invalid input syntax for type json: Expected ':', but found '}'"
    try {
      return JSON.stringify(val);
    } catch {
      return normCol === "metadata" || normCol === "event_data" ? "{}" : "[]";
    }
  }

  const isTextArrayColumn =
    udtType === "_text" ||
    udtType === "text[]" ||
    KNOWN_TEXT_ARRAY_COLUMNS[normTable]?.has(normCol) ||
    GLOBAL_TEXT_ARRAY_COLUMNS.has(normCol);

  if (isTextArrayColumn) {
    if (val === undefined || val === null) {
      return [];
    }
    if (Array.isArray(val)) {
      return val
        .map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item).trim()))
        .filter((item) => item !== "");
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed || trimmed === "[]" || trimmed === "{}") {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((x) => String(x).trim()).filter(Boolean);
        }
      } catch {
        // Not a JSON string; handle comma-separated strings
        return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    return [String(val).trim()];
  }

  // Not a JSON column:
  if (val instanceof Date) {
    return val;
  }

  if (Array.isArray(val)) {
    // For native PostgreSQL array columns (e.g. TEXT[] like images, secondary_images, sizes, materials, details):
    // node-postgres will serialize JavaScript arrays of strings/numbers to PostgreSQL array syntax {"item1", "item2"}
    // Ensure that all elements are clean strings/numbers, not objects
    const hasObjects = val.some((v) => typeof v === "object" && v !== null);
    if (hasObjects) {
      return val.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)));
    }
    return val;
  }

  if (typeof val === "object") {
    try {
      return JSON.stringify(val);
    } catch {
      return "{}";
    }
  }

  return val;
}

/**
 * Production-ready SQL Query Builder interface that mimics Supabase's chained API
 * but executes native, parameterized PostgreSQL queries through the connection pool.
 */
export class PostgresQueryBuilder {
  private table: string;
  private pool: pg.Pool;
  private action: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private selectCols: string = "*";
  private whereClauses: { col: string; op: string; val: any }[] = [];
  private orderClauses: { col: string; ascending: boolean }[] = [];
  private limitCount?: number;
  private insertRows: any[] = [];
  private updateValues: Record<string, any> = {};
  private onConflictCols: string[] = ["id"];
  private expectSingle: boolean = false;
  private returnMaybeSingle: boolean = false;

  constructor(table: string, pool: pg.Pool) {
    this.table = table;
    this.pool = pool;
  }

  select(cols: string = "*"): this {
    this.action = "select";
    this.selectCols = cols;
    return this;
  }

  insert(rows: any | any[]): this {
    this.action = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  upsert(rows: any | any[], options?: { onConflict?: string }): this {
    this.action = "upsert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    if (options?.onConflict) {
      this.onConflictCols = options.onConflict.split(",").map((c) => c.trim());
    }
    return this;
  }

  update(values: Record<string, any>): this {
    this.action = "update";
    this.updateValues = values;
    return this;
  }

  delete(): this {
    this.action = "delete";
    return this;
  }

  eq(col: string, val: any): this {
    this.whereClauses.push({ col, op: "=", val });
    return this;
  }

  neq(col: string, val: any): this {
    this.whereClauses.push({ col, op: "!=", val });
    return this;
  }

  in(col: string, vals: any[]): this {
    this.whereClauses.push({ col, op: "= ANY", val: vals });
    return this;
  }

  order(col: string, options: { ascending?: boolean } = { ascending: true }): this {
    this.orderClauses.push({ col, ascending: options.ascending !== false });
    return this;
  }

  limit(n: number): this {
    this.limitCount = n;
    return this;
  }

  maybeSingle(): Promise<{ data: any; error: any }> {
    this.returnMaybeSingle = true;
    this.limitCount = 1;
    return this.execute();
  }

  single(): Promise<{ data: any; error: any }> {
    this.expectSingle = true;
    this.limitCount = 1;
    return this.execute();
  }

  then(onfulfilled?: (value: { data: any; error: any }) => any, onrejected?: (reason: any) => any): Promise<any> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{ data: any; error: any }> {
    try {
      const sqlParts: string[] = [];
      const params: any[] = [];
      let paramIdx = 1;

      const buildWhere = (): string => {
        if (this.whereClauses.length === 0) return "";
        const parts = this.whereClauses.map((w) => {
          const colId = escapeIdentifier(w.col);
          const p = `$${paramIdx++}`;
          params.push(w.val);
          if (w.op === "= ANY") {
            return `${colId} = ANY(${p})`;
          }
          return `${colId} ${w.op} ${p}`;
        });
        return ` WHERE ${parts.join(" AND ")}`;
      };

      if (this.action === "select") {
        let cols = this.selectCols;
        if (cols === "*") {
          cols = "*";
        } else {
          cols = cols
            .split(",")
            .map((c) => {
              const trimmed = c.trim();
              if (trimmed === "*") return "*";
              return escapeIdentifier(trimmed);
            })
            .join(", ");
        }

        sqlParts.push(`SELECT ${cols} FROM public.${escapeIdentifier(this.table)}`);
        sqlParts.push(buildWhere());

        if (this.orderClauses.length > 0) {
          const orderParts = this.orderClauses.map(
            (o) => `${escapeIdentifier(o.col)} ${o.ascending ? "ASC" : "DESC"}`
          );
          sqlParts.push(` ORDER BY ${orderParts.join(", ")}`);
        }

        if (typeof this.limitCount === "number") {
          sqlParts.push(` LIMIT ${this.limitCount}`);
        }
      } else if (this.action === "insert" || this.action === "upsert") {
        if (this.insertRows.length === 0) {
          return { data: [], error: null };
        }

        const tableColTypes = await loadTableColumnTypes(this.pool, this.table);

        const keys = Array.from(
          new Set(this.insertRows.flatMap((r) => Object.keys(r)))
        ).filter((k) => k !== undefined && k !== "");

        const colNames = keys.map(escapeIdentifier).join(", ");
        const valueTuples: string[] = [];

        for (const row of this.insertRows) {
          const rowParams: string[] = [];
          for (const key of keys) {
            const rawVal = row[key];
            const val = formatParamValue(this.table, key, rawVal, tableColTypes);
            params.push(val);
            rowParams.push(`$${paramIdx++}`);
          }
          valueTuples.push(`(${rowParams.join(", ")})`);
        }

        sqlParts.push(
          `INSERT INTO public.${escapeIdentifier(this.table)} (${colNames}) VALUES ${valueTuples.join(", ")}`
        );

        if (this.action === "upsert") {
          const conflictTarget = this.onConflictCols.map(escapeIdentifier).join(", ");
          const updateAssigns = keys
            .filter((k) => !this.onConflictCols.includes(k))
            .map((k) => `${escapeIdentifier(k)} = EXCLUDED.${escapeIdentifier(k)}`)
            .join(", ");

          if (updateAssigns.length > 0) {
            sqlParts.push(` ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateAssigns}`);
          } else {
            sqlParts.push(` ON CONFLICT (${conflictTarget}) DO NOTHING`);
          }
        }

        sqlParts.push(" RETURNING *");
      } else if (this.action === "update") {
        const updateKeys = Object.keys(this.updateValues).filter((k) => k !== undefined);
        if (updateKeys.length === 0) {
          return { data: [], error: null };
        }

        const tableColTypes = await loadTableColumnTypes(this.pool, this.table);

        const assigns: string[] = [];
        for (const key of updateKeys) {
          const rawVal = this.updateValues[key];
          const val = formatParamValue(this.table, key, rawVal, tableColTypes);
          params.push(val);
          assigns.push(`${escapeIdentifier(key)} = $${paramIdx++}`);
        }

        sqlParts.push(`UPDATE public.${escapeIdentifier(this.table)} SET ${assigns.join(", ")}`);
        sqlParts.push(buildWhere());
        sqlParts.push(" RETURNING *");
      } else if (this.action === "delete") {
        sqlParts.push(`DELETE FROM public.${escapeIdentifier(this.table)}`);
        sqlParts.push(buildWhere());
        sqlParts.push(" RETURNING *");
      }

      const sql = sqlParts.join("");
      const result = await this.pool.query(sql, params);
      const rows = result.rows;

      if (this.expectSingle) {
        if (rows.length === 0) {
          return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
        }
        return { data: rows[0], error: null };
      }

      if (this.returnMaybeSingle) {
        return { data: rows.length > 0 ? rows[0] : null, error: null };
      }

      return { data: rows, error: null };
    } catch (err: any) {
      console.error(`[PostgresQueryBuilder Error] Table: ${this.table} | Error:`, err.message);
      return {
        data: null,
        error: {
          message: err.message,
          code: err.code || "DB_ERROR",
          detail: err.detail,
          hint: err.hint,
        },
      };
    }
  }
}

/**
 * Creates a client that conforms to the database access interface
 * (e.g. client.from("table").select()...)
 */
export function createPostgresClient(poolInstance: pg.Pool) {
  return {
    from(table: string) {
      return new PostgresQueryBuilder(table, poolInstance);
    },
    async query(text: string, params?: any[]) {
      return poolInstance.query(text, params);
    },
  };
}

/**
 * Automatically initializes database schema and seeds default data
 * on application startup if PostgreSQL is connected.
 */
export async function initializePostgresDatabase(): Promise<boolean> {
  const p = getPostgresPool();
  if (!p) return false;
  if (isInitialized) return true;

  try {
    console.log("[PostgreSQL Boot] Verifying database schema & tables...");

    // Check if core table 'users' exists
    const checkRes = await p.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users' LIMIT 1;`
    );

    // Execute idempotent schema migrations from postgres_schema.sql
    const schemaFile = path.join(process.cwd(), "postgres_schema.sql");
    if (fs.existsSync(schemaFile)) {
      console.log(`[PostgreSQL Boot] Executing idempotent schema verification: postgres_schema.sql...`);
      const sql = fs.readFileSync(schemaFile, "utf-8");
      await p.query(sql);
      console.log(`[PostgreSQL Boot] Schema verification and migrations applied successfully.`);
    }

    if (checkRes.rows.length === 0) {
      console.log("[PostgreSQL Boot] Users table was empty. Checking initial seed-data.sql...");
      const seedFile = path.join(process.cwd(), "scripts", "seed-data.sql");
      if (fs.existsSync(seedFile)) {
        const seedSql = fs.readFileSync(seedFile, "utf-8");
        await p.query(seedSql);
      }
    }

    // Ensure salt column exists on users table for secure password hashing
    await p.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='salt') THEN
          ALTER TABLE public.users ADD COLUMN salt TEXT;
        END IF;
      END $$;
    `);

    // Ensure contact_messages table exists
    await p.query(`
      CREATE TABLE IF NOT EXISTS public.contact_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        order_number TEXT,
        inquiry_type TEXT DEFAULT 'general',
        contact_method TEXT DEFAULT 'email',
        subject TEXT,
        message TEXT NOT NULL,
        user_tier TEXT DEFAULT 'Guest',
        status TEXT DEFAULT 'new',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    isInitialized = true;
    console.log("[PostgreSQL Boot] Database verification completed successfully.");
    return true;
  } catch (err: any) {
    console.error("[PostgreSQL Boot Error] Failed to initialize database:", err.message);
    return false;
  }
}
