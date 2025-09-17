import { unstable_cache as unstableCache } from "next/cache";
// Lightweight Socrata client helpers for NYC Open Data (NYPD Complaints & Shootings)
// and SF Open Data (SFPD Incident Reports). Avoids heavy deps; builds simple SoQL URLs
// with safe parameterization.

const COMPLAINTS_DATASET_URL = "https://data.cityofnewyork.us/resource/qgea-i56i.json"; // Historic complaints
const SHOOTINGS_DATASET_URL = "https://data.cityofnewyork.us/resource/833y-fsy8.json"; // Historic shootings
// Year-to-date (current year) datasets
const COMPLAINTS_YTD_DATASET_URL = "https://data.cityofnewyork.us/resource/5uac-w243.json";
const SHOOTINGS_YTD_DATASET_URL = "https://data.cityofnewyork.us/resource/5ucz-vwe8.json";

// San Francisco — SFPD Incident Reports (2018 to Present)
// https://data.sfgov.org/resource/wg3w-h783.json
const SF_INCIDENTS_DATASET_URL = "https://data.sfgov.org/resource/wg3w-h783.json";

// San Francisco — SFPD Incident Reports (2003 to 2018)
// https://data.sfgov.org/resource/tmnf-yvry.json
const SF_INCIDENTS_LEGACY_DATASET_URL = "https://data.sfgov.org/resource/tmnf-yvry.json";

export type SocrataRow = {
  cmplnt_num?: string;
  cmplnt_fr_dt?: string;
  cmplnt_fr_tm?: string;
  ofns_desc?: string;
  law_cat_cd?: string;
  pd_desc?: string;
  boro_nm?: string;
  latitude?: string | number;
  longitude?: string | number;
  lat_lon?: { latitude: string; longitude: string } | string;
};

export type ShootingRow = {
  incident_key?: string;
  occur_date?: string;
  occur_time?: string;
  boro?: string;
  loc_of_occur_desc?: string;
  precinct?: string | number;
  jurisdiction_code?: string | number;
  loc_classfctn_desc?: string;
  location_desc?: string;
  statistical_murder_flag?: boolean;
  perp_age_group?: string;
  perp_sex?: string;
  perp_race?: string;
  vic_age_group?: string;
  vic_sex?: string;
  vic_race?: string;
  x_coord_cd?: string;
  y_coord_cd?: string;
  latitude?: string | number;
  longitude?: string | number;
  geocoded_column?: { type: string; coordinates: [number, number] } | string;
};

export type FetchOptions = {
  where?: string[];
  select?: string[];
  order?: string;
  limit?: number;
  offset?: number;
  group?: string[];
};

declare global {
  var __socrataCache: Map<string, { expiresAt: number; data: unknown }>|undefined;
  var __socrataInflight: Map<string, Promise<unknown>>|undefined;
  var __rowsCache: Map<string, { expiresAt: number; data: SocrataRow[] }>|undefined;
  var __rowsInflight: Map<string, Promise<SocrataRow[]>>|undefined;
  var __rowsInflightShoot: Map<string, Promise<ShootingRow[]>>|undefined;
}

// Vercel Data Cache helper is imported via ESM as unstableCache

export function buildSoqlURL(options: FetchOptions, datasetUrl?: string): string {
  const params = new URLSearchParams();
  if (options.select && options.select.length > 0) {
    params.set("$select", options.select.join(", "));
  }
  if (options.where && options.where.length > 0) {
    params.set("$where", options.where.join(" AND "));
  }
  if (options.group && options.group.length > 0) {
    params.set("$group", options.group.join(", "));
  }
  if (options.order) params.set("$order", options.order);
  if (options.limit) params.set("$limit", String(options.limit));
  if (options.offset) params.set("$offset", String(options.offset));
  return `${datasetUrl || COMPLAINTS_DATASET_URL}?${params.toString()}`;
}

export function buildComplaintsURL(options: FetchOptions): string {
  return buildSoqlURL(options, COMPLAINTS_DATASET_URL);
}

export function buildShootingsURL(options: FetchOptions): string {
  return buildSoqlURL(options, SHOOTINGS_DATASET_URL);
}

// Builders for YTD datasets
export function buildComplaintsURLCurrent(options: FetchOptions): string {
  return buildSoqlURL(options, COMPLAINTS_YTD_DATASET_URL);
}

export function buildShootingsURLCurrent(options: FetchOptions): string {
  return buildSoqlURL(options, SHOOTINGS_YTD_DATASET_URL);
}

// SF builders
export function buildSFIncidentsURL(options: FetchOptions): string {
  return buildSoqlURL(options, SF_INCIDENTS_DATASET_URL);
}

export function buildSFIncidentsLegacyURL(options: FetchOptions): string {
  return buildSoqlURL(options, SF_INCIDENTS_LEGACY_DATASET_URL);
}

export async function fetchSocrata<T = unknown>(url: string, revalidateSeconds?: number): Promise<T> {
  // In-memory micro-cache + in-flight dedupe to avoid hammering Socrata for identical URLs
  const cache: Map<string, { expiresAt: number; data: unknown }> = globalThis.__socrataCache || new Map();
  const inflight: Map<string, Promise<unknown>> = globalThis.__socrataInflight || new Map();
  globalThis.__socrataCache = cache;
  globalThis.__socrataInflight = inflight;

  const now = Date.now();
  const ttlMs = Math.max(1000, (typeof revalidateSeconds === "number" ? revalidateSeconds : 5) * 1000);

  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) {
    try {
      const u = new URL(url);
      const ds = u.pathname.split("/").pop() || "";
      const limit = u.searchParams.get("$limit");
      const offset = u.searchParams.get("$offset") || "0";
      console.log(`[socrata][cache] hit host=${u.host} dataset=${ds} limit=${limit||''} offset=${offset}`);
    } catch {}
    return cached.data as T;
  }
  const inFlight = inflight.get(url);
  if (inFlight) {
    try {
      const u = new URL(url);
      const ds = u.pathname.split("/").pop() || "";
      const limit = u.searchParams.get("$limit");
      const offset = u.searchParams.get("$offset") || "0";
      console.log(`[socrata][cache] join-inflight host=${u.host} dataset=${ds} limit=${limit||''} offset=${offset}`);
    } catch {}
    return (await inFlight) as T;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  // Select domain-specific app token when available to increase rate limits
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("data.cityofnewyork.us")) {
      const token = process.env.NYC_OPENDATA_APP_TOKEN;
      if (token) headers["X-App-Token"] = token;
    } else if (host.includes("data.sfgov.org")) {
      const token = process.env.SF_OPENDATA_APP_TOKEN || process.env.SFGOV_APP_TOKEN;
      if (token) headers["X-App-Token"] = token;
    }
  } catch {}

  const doFetch = (async () => {
    const t0 = performance.now ? performance.now() : Date.now();
    // Use Vercel Data Cache when revalidateSeconds provided; otherwise opt out
    let nextOptions: { revalidate: number; tags?: string[] } | undefined;
    try {
      if (typeof revalidateSeconds === "number" && revalidateSeconds > 0) {
        const u = new URL(url);
        const ds = u.pathname.split("/").pop() || "dataset";
        const host = u.host.toLowerCase();
        const tag = `socrata:${host}:${ds}`;
        nextOptions = { revalidate: Math.max(1, Math.floor(revalidateSeconds)), tags: [tag] };
      }
    } catch {}
    const res = await fetch(url, nextOptions ? { headers, next: nextOptions } : { headers, cache: "no-store", next: { revalidate: 0 } });
    const t1 = performance.now ? performance.now() : Date.now();
    try {
      const u = new URL(url);
      const ds = u.pathname.split("/").pop() || "";
      const limit = u.searchParams.get("$limit");
      const offset = u.searchParams.get("$offset") || "0";
      const cl = res.headers.get("content-length") || "";
      console.log(`[socrata][http] ${Math.round(t1 - t0)}ms status=${res.status} host=${u.host} dataset=${ds} limit=${limit||''} offset=${offset} size=${cl}`);
    } catch {}
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Ensure we don't keep a failed promise in the in-flight map
      throw new Error(`Socrata error ${res.status}: ${text}`);
    }
    const json = (await res.json()) as T;
    // Store successful responses briefly
    cache.set(url, { expiresAt: now + ttlMs, data: json });
    try {
      const u = new URL(url);
      const ds = u.pathname.split("/").pop() || "";
      const limit = u.searchParams.get("$limit");
      const offset = u.searchParams.get("$offset") || "0";
      const rows = Array.isArray(json) ? (json as unknown[]).length : -1;
      console.log(`[socrata][rows] host=${u.host} dataset=${ds} limit=${limit||''} offset=${offset} rows=${rows}`);
    } catch {}
    return json;
  })();

  inflight.set(url, doFetch);
  try {
    const result = await doFetch;
    return result as T;
  } finally {
    inflight.delete(url);
  }
}

// Fetch all pages for a Socrata query by iterating over $offset in pageSize chunks.
// Use conservatively to prevent heavy loads. maxRows is a safety cap; stop when a page returns < pageSize.
export async function fetchSocrataAll<T = unknown>(
  url: string,
  pageSize: number = 50000,
  maxRows: number = 250000,
  revalidateSeconds?: number
): Promise<T[]> {
  if (pageSize <= 0) pageSize = 50000;
  if (maxRows <= 0) maxRows = pageSize;
  const out: T[] = [];
  let offset = 0;
  let pages = 0;
  const start = performance.now ? performance.now() : Date.now();
  while (out.length < maxRows) {
    const u = new URL(url);
    u.searchParams.set("$limit", String(pageSize));
    u.searchParams.set("$offset", String(offset));
    const page = await fetchSocrata<T[]>(u.toString(), revalidateSeconds);
    try {
      const ds = u.pathname.split("/").pop() || "";
      console.log(`[socrata-all][page] host=${u.host} dataset=${ds} offset=${offset} limit=${pageSize} len=${Array.isArray(page)?page.length:0}`);
    } catch {}
    out.push(...page);
    pages++;
    if (!Array.isArray(page) || page.length < pageSize) break;
    offset += pageSize;
  }
  try {
    const end = performance.now ? performance.now() : Date.now();
    const u = new URL(url);
    const ds = u.pathname.split("/").pop() || "";
    console.log(`[socrata-all][done] ${Math.round(end - start)}ms host=${u.host} dataset=${ds} pages=${pages} rows=${out.length}`);
  } catch {}
  return out;
}

// Fetch N pages in parallel for faster first-byte when we know a single page may truncate.
// This is ideal for tile endpoints where we need a quick snapshot and can tolerate a small, fixed cap.
export async function fetchSocrataPagesParallel<T = unknown>(
  url: string,
  pageSize: number,
  pages: number,
  revalidateSeconds?: number
): Promise<T[]> {
  if (pageSize <= 0) pageSize = 10000;
  if (pages <= 0) pages = 1;
  const make = (offset: number) => {
    const u = new URL(url);
    u.searchParams.set("$limit", String(pageSize));
    if (offset > 0) u.searchParams.set("$offset", String(offset)); else u.searchParams.delete("$offset");
    return fetchSocrata<T[]>(u.toString(), revalidateSeconds);
  };
  const offsets: number[] = [];
  for (let i = 0; i < pages; i++) offsets.push(i * pageSize);
  const settled = await Promise.allSettled(offsets.map((o) => make(o)));
  const rows: T[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && Array.isArray(s.value)) rows.push(...s.value);
  }
  return rows;
}

export function escapeSoqlString(value: string): string {
  return value.replace(/'/g, "''");
}

export function fourYearsAgoISOString(): string {
  const now = new Date();
  const cutoff = new Date(now.getFullYear() - 4, now.getMonth(), now.getDate());
  return cutoff.toISOString();
}

// Socrata "floating timestamp" is timezone-less. Provide an ISO-like string without the trailing Z
// and with millisecond precision, using UTC components to keep determinism.
export function toFloatingTimestamp(date: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const yyyy = date.getUTCFullYear();
  const MM = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  const mmm = pad(date.getUTCMilliseconds(), 3);
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}.${mmm}`;
}

// Merge rows that contain a numeric "count" column, grouped by the provided key fields.
// If keyFields.length === 0, sum all counts into a single row: [{ count }]
export function mergeAggregateRows<T extends Record<string, unknown>>(rows: T[], keyFields: string[]): T[] {
  if (!rows || rows.length === 0) return [];
  if (!Array.isArray(keyFields)) keyFields = [];
  if (keyFields.length === 0) {
    const total = rows.reduce((acc, r) => acc + Number((r as { count?: unknown }).count || 0), 0);
    return [{ count: total }] as unknown as T[];
  }
  const keyOf = (r: Record<string, unknown>) => keyFields.map((k) => String(r[k] ?? "")).join("__");
  const merged = new Map<string, Record<string, unknown>>();
  for (const r of rows as Record<string, unknown>[]) {
    const k = keyOf(r);
    const prev = merged.get(k);
    if (prev) {
      (prev as { count?: number }).count = Number((prev as { count?: unknown }).count || 0) + Number((r as { count?: unknown }).count || 0);
    } else {
      // Shallow clone to avoid mutating caller data
      merged.set(k, { ...r, count: Number((r as { count?: unknown }).count || 0) });
    }
  }
  return Array.from(merged.values()) as T[];
}


//
// 
// Canonical row loaders to eliminate duplicate upstream pulls between endpoints.
// They fetch a superset of columns used by both stats and aggregate routes and cache
// merged historic+YTD results for a short period.

function getRowsCache(): Map<string, { expiresAt: number; data: SocrataRow[] }> {
  const rowsCache = globalThis.__rowsCache as Map<string, { expiresAt: number; data: SocrataRow[] }> | undefined;
  if (rowsCache) return rowsCache;
  const m = new Map<string, { expiresAt: number; data: SocrataRow[] }>();
  globalThis.__rowsCache = m;
  return m;
}

function gcRowsCache(limit: number = 24) {
  const cache = getRowsCache();
  const now = Date.now();
  for (const [k, v] of Array.from(cache.entries())) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  if (cache.size > limit) {
    const entries = Array.from(cache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length - limit; i++) cache.delete(entries[i][0]);
  }
}

function whereKey(where: string[]): string {
  // where clauses are built deterministically in our routes; join as-is
  return where.join(" AND ");
}

export async function loadComplaintsRowsCombined(where: string[], ttlMs: number = 20000, cacheKeyOverride?: string): Promise<SocrataRow[]> {
  const select = [
    "cmplnt_num",
    "ofns_desc",
    "law_cat_cd",
    "boro_nm",
    "prem_typ_desc",
    "susp_race",
    "susp_age_group",
    "susp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "cmplnt_fr_dt",
    "lat_lon",
    "latitude",
    "longitude",
  ];
  const key = cacheKeyOverride || `complaints|${whereKey(where)}`;
  const cache = getRowsCache();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    try { console.log(`[rows][complaints] cache hit key=${key} rows=${cached.data?.length||0}`); } catch {}
    return cached.data;
  }
  const urlH = buildComplaintsURL({ where, select, order: "cmplnt_fr_dt DESC" });
  const urlC = buildComplaintsURLCurrent({ where, select, order: "cmplnt_fr_dt DESC" });
  // In-flight dedupe for this combined key so concurrent callers don't trigger duplicate upstream pulls
  const inflightCombined: Map<string, Promise<SocrataRow[]>> = globalThis.__rowsInflight || new Map();
  globalThis.__rowsInflight = inflightCombined;
  const inflightKey = `complaints|${key}`;
  const existing = inflightCombined.get(inflightKey);
  if (existing) {
    try { console.log(`[rows][complaints] join-inflight key=${key}`); } catch {}
    return existing;
  }
  const t0 = Date.now();
  let hMs = 0, cMs = 0;
  const revalidateSeconds = 86400; // 24h Data Cache TTL for upstream pages and combined rows
  const compute = async () => {
    const pH = (async () => { const s = Date.now(); const r = await fetchSocrataAll<SocrataRow>(urlH, 50000, 150000, revalidateSeconds); hMs = Date.now()-s; try { console.log(`[rows][complaints][historic] rows=${r.length} ms=${hMs}`); } catch {} return r; })();
    const pC = (async () => { const s = Date.now(); const r = await fetchSocrataAll<SocrataRow>(urlC, 50000, 150000, revalidateSeconds); cMs = Date.now()-s; try { console.log(`[rows][complaints][ytd] rows=${r.length} ms=${cMs}`); } catch {} return r; })();
    const [h, c] = await Promise.all([pH, pC]);
    const rows = [...h, ...c];
    const t1 = Date.now();
    try { console.log(`[rows][complaints][done] total=${rows.length} ms=${t1 - t0} key=${key}`); } catch {}
    return rows;
  };
  let run = compute;
  try {
    const tag = `rows:complaints`;
    run = unstableCache(compute, [key], { revalidate: revalidateSeconds, tags: [tag] });
  } catch {}
  const combinedPromise = (async () => {
    try {
      const rows = await run();
      cache.set(key, { expiresAt: now + ttlMs, data: rows });
      gcRowsCache();
      return rows;
    } finally {
      inflightCombined.delete(inflightKey);
    }
  })();
  inflightCombined.set(inflightKey, combinedPromise);
  return combinedPromise;
}

export async function loadShootingsRowsCombined(where: string[], ttlMs: number = 20000, cacheKeyOverride?: string): Promise<ShootingRow[]> {
  const select = [
    "incident_key",
    "statistical_murder_flag",
    "occur_date",
    "boro",
    "location_desc",
    "perp_race",
    "perp_age_group",
    "perp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "latitude",
    "longitude",
    "geocoded_column",
  ];
  const key = cacheKeyOverride || `shootings|${whereKey(where)}`;
  const cache = getRowsCache();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    try { console.log(`[rows][shootings] cache hit key=${key} rows=${cached.data?.length||0}`); } catch {}
    return cached.data as ShootingRow[];
  }
  const urlH = buildShootingsURL({ where, select, order: "occur_date DESC" });
  const urlC = buildShootingsURLCurrent({ where, select, order: "occur_date DESC" });
  // In-flight dedupe for this combined key so concurrent callers don't trigger duplicate upstream pulls
  const inflightCombined: Map<string, Promise<ShootingRow[]>> = globalThis.__rowsInflightShoot || new Map();
  globalThis.__rowsInflightShoot = inflightCombined;
  const inflightKey = `shootings|${key}`;
  const existing = inflightCombined.get(inflightKey);
  if (existing) {
    try { console.log(`[rows][shootings] join-inflight key=${key}`); } catch {}
    return existing;
  }
  const t0 = Date.now();
  let hMs = 0, cMs = 0;
  const revalidateSeconds = 86400;
  const compute = async () => {
    const pH = (async () => { const s = Date.now(); const r = await fetchSocrataAll<ShootingRow>(urlH, 20000, 80000, revalidateSeconds); hMs = Date.now()-s; try { console.log(`[rows][shootings][historic] rows=${r.length} ms=${hMs}`); } catch {} return r; })();
    const pC = (async () => { const s = Date.now(); const r = await fetchSocrataAll<ShootingRow>(urlC, 20000, 80000, revalidateSeconds); cMs = Date.now()-s; try { console.log(`[rows][shootings][ytd] rows=${r.length} ms=${cMs}`); } catch {} return r; })();
    const [h, c] = await Promise.all([pH, pC]);
    const rows = [...h, ...c];
    const t1 = Date.now();
    try { console.log(`[rows][shootings][done] total=${rows.length} ms=${t1 - t0} key=${key}`); } catch {}
    return rows as ShootingRow[];
  };
  let run = compute;
  try {
    const tag = `rows:shootings`;
    run = unstableCache(compute, [key], { revalidate: revalidateSeconds, tags: [tag] });
  } catch {}
  const combinedPromise = (async () => {
   try {
      const rows = await run();
      cache.set(key, { expiresAt: now + ttlMs, data: rows });
      gcRowsCache();
      return rows as ShootingRow[];
    } finally {
      inflightCombined.delete(inflightKey);
    }
  })();
  inflightCombined.set(inflightKey, combinedPromise);
  return combinedPromise;
}


