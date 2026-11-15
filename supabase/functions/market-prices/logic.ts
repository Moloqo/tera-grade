// =============================================================================
// market-prices — PURE LOGIC (no Deno, no Supabase SDK import).
//
// This file holds every rule of the `market-prices` Edge Function in a form
// that can be unit-tested without network, Deno, or Supabase:
//   - `index.ts` (the thin Deno wrapper) injects the real `fetch` and a
//     service-role Supabase client and calls `handleMarketPrices`.
//   - `test-market-prices.mjs` injects stub `fetch` + a stub Supabase client
//     and exercises the same code paths.
//
// Design spec: ../design-market-data.md  (§5.2 contract, §5.4 platform
// limits, §5.6 security, §6 honest mapping, §10 acceptance criteria).
//
// HARD RULES (from the spec — do not weaken them):
//   - Never invent a price. A missing price is a missing/null field, NEVER 0.
//   - `sales` is ALWAYS { status: "not_available", note: ... } in Fase 1.
//   - Never parse eBay listing titles to infer a per-grade price.
//   - Never leak keys/tokens/internal upstream error detail in a response.
//   - All upstream failures -> HTTP 200 { status: "unavailable", ... },
//     never a 500 (the client shows an honest sentence, not an error page).
// =============================================================================

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h — §5.2 step 2
export const FORCE_REFRESH_MIN_AGE_MS = 60 * 60 * 1000; // forceRefresh ignored if cache < 1 h — §5.2
export const DEFAULT_SOURCE_TIMEOUT_MS = 8000; // per-source timeout — §5.2 step 3
export const TOTAL_BUDGET_MS = 25000; // total function budget — §5.2 step 3
export const FALLBACK_USD_IDR = 16500; // exchangerate-api.com fallback — §1 / §5.3
export const SALES_NOT_AVAILABLE_NOTE =
  "No recent completed sales from current sources."; // §5.2 / §6.3 — verbatim

export const CATEGORIES = ["pokemon", "magic", "yugioh", "onepiece", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type SourceStatus = "ok" | "not_found" | "not_applicable" | "error" | "not_available";

// ---------------------------------------------------------------------------
// Minimal structural types for the injected dependencies.
// The real Supabase client is cast to SupabaseLike in index.ts; the test
// stub implements the same chain: from(t).select(c).eq(k, v).maybeSingle()
// and from(t).upsert(row).
// ---------------------------------------------------------------------------
export type DbQuery = {
  eq: (col: string, val: unknown) => DbQuery;
  maybeSingle: () => Promise<{ data: any; error: any }>;
  single: () => Promise<{ data: any; error: any }>;
};
export type DbTable = {
  select: (cols: string) => DbQuery;
  upsert: (row: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};
export type SupabaseLike = {
  from: (table: string) => DbTable;
};

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
};
export type FetchLike = (
  url: string,
  opts?: Record<string, unknown>,
) => Promise<FetchResponseLike>;

export type EbayTokenProvider = {
  getToken: () => Promise<string | null>;
};

export type MarketInput = {
  name?: unknown;
  set?: unknown;
  number?: unknown;
  category?: unknown;
  rarity?: unknown;
  language?: unknown;
  forceRefresh?: unknown;
};

export type Deps = {
  fetchImpl?: FetchLike;
  supabase?: SupabaseLike | null;
  ebayAppId?: string;
  ebayCertId?: string;
  ebayTokenProvider?: EbayTokenProvider;
  /** Per-source timeout in ms (default 8000). Tests pass a small value. */
  sourceTimeoutMs?: number;
  /** Injected clock (default Date.now). Tests pass a fixed value. */
  nowMs?: number;
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Drop null/undefined fields from an object (missing price stays missing). */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as T;
}

/** A usable number, or null. Zero / negative / NaN / non-numeric -> null. */
export function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Median of the given values (ignores non-positive / non-numeric). */
export function median(values: unknown[]): number | null {
  const nums = values
    .map((v) => toNum(v))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** "Zeraora" -> "zeraora"; "Pikachu Berkemeja Batik" -> "pikachuberkemejabatik". */
export function normalizeName(name: string): string {
  return stripDiacritics(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Set normalisation. Parenthetical qualifiers are dropped, so the spec
 * example holds: "MA6 (Indonesian)" -> "ma6".
 */
export function normalizeSet(set: string): string {
  const noParen = set.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return stripDiacritics(noParen).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** "137/130" -> "137" (TCGdex card ids use the part before the slash). */
export function normalizeNumber(num: string): string {
  const head = num.split("/")[0].trim();
  return stripDiacritics(head).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Cache key — §5.2 step 1:
 *   category | nama-lower-tanpa-tanda-baca | set-normalized | nomor
 * Example: "pokemon|zeraora|ma6|137".
 */
export function buildCardKey(
  category: string,
  name: string,
  set: string,
  number: string,
): string {
  return [
    category,
    normalizeName(name),
    normalizeSet(set || ""),
    normalizeNumber(number || ""),
  ].join("|");
}

/** "Indonesian"/"id" -> "id", "English"/"en" -> "en", anything else -> "en". */
export function normalizeLanguage(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (l === "id" || l === "indonesian" || l === "bahasa indonesia") return "id";
  if (l === "ja" || l === "japanese") return "ja";
  if (l === "ko" || l === "korean") return "ko";
  if (l === "zh" || l === "chinese") return "zh";
  return "en";
}

function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "unknown error");
  return m.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Timeout helpers — AbortController AND a race, so a fetch that ignores the
// abort signal (e.g. a hanging stub) still times out.
// ---------------------------------------------------------------------------
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label} (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  opts: Record<string, unknown>,
  ms: number,
  label: string,
): Promise<FetchResponseLike> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }, ms);
  try {
    const p = fetchImpl(url, { ...opts, signal: controller.signal });
    return await withTimeout(p, ms, label);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// eBay — Browse API (active listings only) + OAuth client-credentials token.
// Spec §2.1: token ~2 h, cached in memory (module/global variable in the
// wrapper), refresh when expired. No scraping, no sold data here.
// ---------------------------------------------------------------------------

// VERIFY_AT_BUILD: the Trading Cards category ID must be checked against the
// LIVE eBay category tree before use — DO NOT hardcode it from memory
// (spec §2.1: "Category ID untuk Trading Cards harus dicek di category tree
// eBay saat build (jangan hardcode dari ingatan — TIDAK terverifikasi di
// riset ini)"). Until verified, search runs on `q` only, with NO
// `categoryIds` filter. The constant stays null on purpose.
export const EBAY_TRADING_CARDS_CATEGORY_ID: string | null = null;

const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

export function createEbayTokenProvider(
  fetchImpl: FetchLike,
  appId: string,
  certId: string,
  timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
): EbayTokenProvider {
  let cachedToken: string | null = null;
  let cachedUntil = 0;
  let inflight: Promise<string | null> | null = null;

  async function getToken(): Promise<string | null> {
    if (!appId || !certId) return null; // credentials not configured — §8.1
    if (cachedToken && Date.now() < cachedUntil) return cachedToken;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const basic = btoa(`${appId}:${certId}`);
        const res = await fetchWithTimeout(
          fetchImpl,
          EBAY_TOKEN_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: `Basic ${basic}`,
            },
            body:
              "grant_type=client_credentials&scope=" +
              encodeURIComponent(EBAY_OAUTH_SCOPE),
          },
          timeoutMs,
          "ebay token",
        );
        if (!res.ok) {
          cachedToken = null;
          cachedUntil = 0;
          return null;
        }
        const j = await res.json();
        const token = typeof j?.access_token === "string" ? j.access_token : null;
        if (!token) return null;
        const ttl = typeof j?.expires_in === "number" ? j.expires_in : 7200;
        cachedToken = token;
        cachedUntil = Date.now() + Math.max(0, (ttl - 60) * 1000); // 60 s safety margin
        return cachedToken;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return { getToken };
}

export type SourceResult = Record<string, unknown> & { status: SourceStatus };

/**
 * eBay Browse: cheapest active listing, median of the (up to) 10 cheapest
 * active listings, active count, up to 5 sample listings.
 * Titles are NEVER parsed for a per-grade price (§6.2).
 */
export async function fetchEbay(
  fetchImpl: FetchLike,
  tokenProvider: EbayTokenProvider,
  query: string,
  timeoutMs: number,
): Promise<SourceResult> {
  const token = await tokenProvider.getToken();
  if (!token) {
    return { status: "not_available", note: "eBay credentials not configured" };
  }
  const params = new URLSearchParams({
    q: query,
    limit: "10",
    filter: "buyingOptions:{FIXED_PRICE}",
    sort: "price",
  });
  // NOTE: no categoryIds — EBAY_TRADING_CARDS_CATEGORY_ID is unverified (see above).
  const url = `${EBAY_SEARCH_URL}?${params.toString()}`;
  let res: FetchResponseLike;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } },
      timeoutMs,
      "ebay search",
    );
  } catch (e) {
    return { status: "error", note: `eBay request failed (${shortErr(e)})` };
  }
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error", note: `eBay HTTP ${res.status}` };
  let j: any;
  try {
    j = await res.json();
  } catch {
    return { status: "error", note: "eBay returned invalid JSON" };
  }
  const items: any[] = Array.isArray(j?.itemSummaries) ? j.itemSummaries : [];
  if (items.length === 0) return { status: "not_found" };
  const priced = items
    .map((it) => ({
      title: typeof it?.title === "string" ? it.title : "",
      price: toNum(it?.price?.value),
      currency:
        typeof it?.price?.currency === "string" ? it.price.currency : "USD",
      url: typeof it?.itemWebUrl === "string" ? it.itemWebUrl : "",
      condition:
        typeof it?.condition === "string"
          ? it.condition
          : typeof it?.condition?.conditionDisplayName === "string"
            ? it.condition.conditionDisplayName
            : undefined,
    }))
    .filter((x) => x.price !== null);
  if (priced.length === 0) {
    return { status: "error", note: "eBay returned listings without usable prices" };
  }
  // Browse returns sort=price (cheapest first); still sort defensively.
  priced.sort((a, b) => (a.price as number) - (b.price as number));
  const top10 = priced.slice(0, 10);
  const cheapestActive = top10[0].price as number;
  const medianActive = median(top10.map((x) => x.price));
  const activeCount =
    typeof j?.total === "number" && j.total > 0 ? j.total : items.length;
  const currency = top10[0].currency || "USD";
  const sample = priced.slice(0, 5).map((x) =>
    compact({
      title: x.title,
      price: x.price,
      currency: x.currency,
      url: x.url,
      condition: x.condition,
    }),
  );
  return compact({
    status: "ok",
    cheapestActive,
    medianActive,
    activeCount,
    currency,
    sample,
    note: "Asking prices, not completed sales.",
  }) as SourceResult;
}

// ---------------------------------------------------------------------------
// TCGdex — Pokémon (Cardmarket EUR + TCGplayer USD in one response), §2.6.
// Card id = <set-id>-<number>. Language: card language first, fallback en.
// ---------------------------------------------------------------------------
export async function fetchTcgdex(
  fetchImpl: FetchLike,
  setId: string | null | undefined,
  number: string,
  language: string,
  timeoutMs: number,
): Promise<SourceResult> {
  if (!setId) {
    return { status: "not_applicable", note: "set not mapped yet" };
  }
  const langs = language && language !== "en" ? [language, "en"] : ["en"];
  for (const lang of langs) {
    const cardId = `${setId}-${normalizeNumber(number)}`;
    const url = `https://api.tcgdex.net/v2/${lang}/cards/${cardId}`;
    let res: FetchResponseLike;
    try {
      res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs, "tcgdex");
    } catch (e) {
      return { status: "error", note: `TCGdex request failed (${shortErr(e)})` };
    }
    if (res.status === 404) continue; // not in this language pool — try next
    if (!res.ok) return { status: "error", note: `TCGdex HTTP ${res.status}` };
    let j: any;
    try {
      j = await res.json();
    } catch {
      return { status: "error", note: "TCGdex returned invalid JSON" };
    }
    const cm = j?.pricing?.cardmarket;
    const tp = j?.pricing?.tcgplayer;
    if (!cm && !tp) {
      return { status: "not_available", note: "Card found but no pricing published" };
    }
    const cardmarket =
      cm && (toNum(cm.trend) !== null || toNum(cm.avg) !== null || toNum(cm.low) !== null)
        ? compact({
            trend: toNum(cm.trend),
            avg: toNum(cm.avg),
            low: toNum(cm.low),
            currency: "EUR",
          })
        : null;
    // TCGplayer prices are keyed per variant name (normal / holofoil / ...).
    // Pick the first variant that publishes a market price and SAY which one.
    let tcgplayer: Record<string, unknown> | null = null;
    if (tp && typeof tp === "object") {
      for (const [variant, v] of Object.entries(tp)) {
        if (variant === "unit" || variant === "updated") continue;
        const vv: any = v;
        if (vv && typeof vv === "object" && toNum(vv.marketPrice) !== null) {
          tcgplayer = compact({
            variant,
            market: toNum(vv.marketPrice),
            low: toNum(vv.lowPrice),
            mid: toNum(vv.midPrice),
            high: toNum(vv.highPrice),
            currency: "USD",
          });
          break;
        }
      }
    }
    if (!cardmarket && !tcgplayer) {
      return { status: "not_available", note: "Card found but no pricing published" };
    }
    return compact({
      status: "ok",
      cardmarket,
      tcgplayer,
      url,
    }) as SourceResult;
  }
  return { status: "not_found" };
}

// ---------------------------------------------------------------------------
// Scryfall — Magic, §2.4. Descriptive User-Agent is REQUIRED (else 403).
// ---------------------------------------------------------------------------
const SCRYFALL_UA = "TEG/1.0 (market-prices; https://moloqo.github.io/tera-grade/)";

export async function fetchScryfall(
  fetchImpl: FetchLike,
  name: string,
  setCode: string | null | undefined,
  timeoutMs: number,
): Promise<SourceResult> {
  const params = new URLSearchParams({ exact: name });
  if (setCode) params.set("set", setCode);
  const url = `https://api.scryfall.com/cards/named?${params.toString()}`;
  let res: FetchResponseLike;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { "User-Agent": SCRYFALL_UA, Accept: "application/json" } },
      timeoutMs,
      "scryfall",
    );
  } catch (e) {
    return { status: "error", note: `Scryfall request failed (${shortErr(e)})` };
  }
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error", note: `Scryfall HTTP ${res.status}` };
  let j: any;
  try {
    j = await res.json();
  } catch {
    return { status: "error", note: "Scryfall returned invalid JSON" };
  }
  const prices = j?.prices;
  const usd = toNum(prices?.usd);
  const usdFoil = toNum(prices?.usd_foil);
  const eur = toNum(prices?.eur);
  const tix = toNum(prices?.tix);
  if (usd === null && usdFoil === null && eur === null && tix === null) {
    return { status: "not_available", note: "Scryfall lists the card but publishes no prices" };
  }
  return compact({
    status: "ok",
    usd,
    usdFoil,
    eur,
    tix,
    currency: "USD",
    url: typeof j?.scryfall_uri === "string" ? j.scryfall_uri : undefined,
  }) as SourceResult;
}

// ---------------------------------------------------------------------------
// YGOPRODeck — Yu-Gi-Oh!, §2.5. Exact name first, fuzzy name as fallback.
// ---------------------------------------------------------------------------
export async function fetchYgoprodeck(
  fetchImpl: FetchLike,
  name: string,
  timeoutMs: number,
): Promise<SourceResult> {
  const attempts = [
    `name=${encodeURIComponent(name)}`,
    `fname=${encodeURIComponent(name)}`,
  ];
  for (const q of attempts) {
    const url = `https://api.ygoprodeck.com/api/v7/cardinfo.php?${q}`;
    let res: FetchResponseLike;
    try {
      res = await fetchWithTimeout(fetchImpl, url, {}, timeoutMs, "ygoprodeck");
    } catch (e) {
      return { status: "error", note: `YGOPRODeck request failed (${shortErr(e)})` };
    }
    if (res.status === 400) continue; // "No card matching your query" — try fuzzy
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error", note: `YGOPRODeck HTTP ${res.status}` };
    let j: any;
    try {
      j = await res.json();
    } catch {
      return { status: "error", note: "YGOPRODeck returned invalid JSON" };
    }
    const card = Array.isArray(j?.data) ? j.data[0] : null;
    const p = card?.card_prices?.[0];
    if (!p) {
      return { status: "not_available", note: "Card found but no vendor prices published" };
    }
    const out = compact({
      cardmarketPrice: toNum(p.cardmarket_price),
      tcgplayerPrice: toNum(p.tcgplayer_price),
      ebayPrice: toNum(p.ebay_price),
      amazonPrice: toNum(p.amazon_price),
      coolstuffincPrice: toNum(p.coolstuffinc_price),
    });
    if (Object.keys(out).length === 0) {
      return { status: "not_available", note: "Card found but no vendor prices published" };
    }
    return {
      status: "ok",
      ...out,
      currencies: { cardmarketPrice: "EUR", tcgplayerPrice: "USD", ebayPrice: "USD", amazonPrice: "USD", coolstuffincPrice: "USD" },
    } as SourceResult;
  }
  return { status: "not_found" };
}

// ---------------------------------------------------------------------------
// Fase 1b tables — cardmarket_prices / tcgplayer_prices (§5.3).
//
// SCHEMA (resolved 2026-11-16, worker F): both tables now carry a `card_key`
// TEXT column + UNIQUE INDEX (see 001_market_tables.sql), populated by the
// daily job in refresh-market-files.mjs (buildCardKey mirrors the §5.2
// normalization used here). This function looks rows up by `card_key`. If a
// row has no card_key yet (unmapped card, or job not run), the lookup
// degrades honestly to `not_available` ("No mapped row for this card") —
// never to an invented price. If the column itself does not exist yet
// (PostgREST PGRST204, i.e. 001 not run), that is also `not_available`,
// not an error, because the mapping simply is not populated yet.
// ---------------------------------------------------------------------------
export async function fetchMappedTablePrice(
  sb: SupabaseLike | null,
  table: "cardmarket_prices" | "tcgplayer_prices",
  cardKey: string,
): Promise<SourceResult> {
  if (!sb) {
    return { status: "not_available", note: "Database lookup unavailable" };
  }
  let data: any = null;
  try {
    const cols =
      table === "cardmarket_prices"
        ? "trend, avg, low, updated"
        : "market, low, mid, high, updated";
    const { data: row, error } = await sb
      .from(table)
      .select(cols)
      .eq("card_key", cardKey)
      .maybeSingle();
    if (error) {
      const msg = String((error as any)?.message ?? error ?? "");
      const code = String((error as any)?.code ?? "");
      if (code === "PGRST204" || /card_key/i.test(msg)) {
        return {
          status: "not_available",
          note: "No mapped row for this card (card_key mapping not yet populated — Fase 1b)",
        };
      }
      return { status: "error", note: "Table lookup failed" };
    }
    data = row;
  } catch {
    return { status: "error", note: "Table lookup failed" };
  }
  if (!data) {
    return { status: "not_available", note: "No mapped row for this card" };
  }
  if (table === "cardmarket_prices") {
    const out = compact({
      trend: toNum(data.trend),
      avg: toNum(data.avg),
      low: toNum(data.low),
      currency: "EUR",
      updated: typeof data.updated === "string" ? data.updated : undefined,
    });
    if (out.trend === undefined && out.avg === undefined && out.low === undefined) {
      return { status: "not_available", note: "Row exists but has no prices" };
    }
    return { status: "ok", ...out } as SourceResult;
  }
  const out = compact({
    market: toNum(data.market),
    low: toNum(data.low),
    mid: toNum(data.mid),
    high: toNum(data.high),
    currency: "USD",
    updated: typeof data.updated === "string" ? data.updated : undefined,
  });
  if (
    out.market === undefined &&
    out.low === undefined &&
    out.mid === undefined &&
    out.high === undefined
  ) {
    return { status: "not_available", note: "Row exists but has no prices" };
  }
  return { status: "ok", ...out } as SourceResult;
}

// ---------------------------------------------------------------------------
// FX — fx_rates table first, else exchangerate-api.com, else USD fallback.
// EUR has NO invented fallback: if it cannot be fetched it is omitted.
// ---------------------------------------------------------------------------
export async function fetchFx(
  fetchImpl: FetchLike,
  sb: SupabaseLike | null,
  timeoutMs: number,
): Promise<{ USD_IDR: number; EUR_IDR: number | null; asOf: string | null }> {
  let usd: number | null = null;
  let eur: number | null = null;
  let asOf: string | null = null;
  if (sb) {
    try {
      const u = await sb
        .from("fx_rates")
        .select("rate, as_of")
        .eq("pair", "USD_IDR")
        .maybeSingle();
      if (!u.error && u.data) {
        usd = toNum(u.data.rate);
        if (typeof u.data.as_of === "string") asOf = u.data.as_of;
      }
      const e = await sb
        .from("fx_rates")
        .select("rate, as_of")
        .eq("pair", "EUR_IDR")
        .maybeSingle();
      if (!e.error && e.data) eur = toNum(e.data.rate);
    } catch {
      /* fall through to the API */
    }
  }
  const fxTimeout = Math.min(timeoutMs, 5000);
  if (usd === null) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        "https://api.exchangerate-api.com/v4/latest/USD",
        {},
        fxTimeout,
        "fx USD",
      );
      if (res.ok) {
        const j = await res.json();
        const idr = toNum(j?.rates?.IDR);
        if (idr !== null) {
          usd = idr;
          if (typeof j?.date === "string") asOf = j.date;
        }
      }
    } catch {
      /* fallback below */
    }
  }
  if (eur === null) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        "https://api.exchangerate-api.com/v4/latest/EUR",
        {},
        fxTimeout,
        "fx EUR",
      );
      if (res.ok) {
        const j = await res.json();
        const idr = toNum(j?.rates?.IDR);
        if (idr !== null) eur = idr;
      }
    } catch {
      /* EUR stays null — omitted honestly, never invented */
    }
  }
  if (usd === null) usd = FALLBACK_USD_IDR;
  return { USD_IDR: usd, EUR_IDR: eur, asOf };
}

// ---------------------------------------------------------------------------
// Cache helpers (market_cache, service_role only — §5.3; RLS: no anon access)
// ---------------------------------------------------------------------------
async function readCache(
  sb: SupabaseLike | null,
  cardKey: string,
): Promise<{ payload: any; fetchedAt: string } | null> {
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("market_cache")
      .select("payload, fetched_at")
      .eq("card_key", cardKey)
      .maybeSingle();
    if (error || !data) return null;
    return { payload: data.payload, fetchedAt: data.fetched_at };
  } catch {
    return null;
  }
}

async function writeCache(
  sb: SupabaseLike | null,
  cardKey: string,
  category: string,
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<void> {
  if (!sb) return;
  try {
    await sb.from("market_cache").upsert({
      card_key: cardKey,
      category,
      payload,
      fetched_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + CACHE_TTL_MS).toISOString(),
    });
  } catch {
    /* best-effort: a failed cache write must never fail the response */
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — the §5.2 contract.
// ---------------------------------------------------------------------------
export async function handleMarketPrices(
  deps: Deps,
  input: MarketInput,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nowMs = deps.nowMs ?? Date.now();
  const timeoutMs = deps.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const fetchImpl: FetchLike =
    deps.fetchImpl ??
    ((globalThis as any).fetch as FetchLike);

  // ---- validation (§5.6: validate input, category from the allow-list) ----
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 200) {
    return { status: 400, body: { status: "error", reason: "Invalid or missing 'name'." } };
  }
  const rawCategory =
    typeof input?.category === "string" ? input.category.toLowerCase() : "other";
  if (!(CATEGORIES as readonly string[]).includes(rawCategory)) {
    return { status: 400, body: { status: "error", reason: "Invalid 'category'." } };
  }
  const category = rawCategory as Category;
  const set = typeof input?.set === "string" ? input.set.trim().slice(0, 200) : "";
  const number =
    typeof input?.number === "string" ? input.number.trim().slice(0, 50) : "";
  const language = normalizeLanguage(
    typeof input?.language === "string" ? input.language : "en",
  );
  const forceRefresh = input?.forceRefresh === true;
  const cardKey = buildCardKey(category, name, set, number);
  const sb = deps.supabase ?? null;
  const sales = { status: "not_available", note: SALES_NOT_AVAILABLE_NOTE };

  // ---- step 2: cache first (§5.2) ----
  const cached = await readCache(sb, cardKey);
  if (cached && cached.payload && typeof cached.payload === "object") {
    const ageMs = nowMs - Date.parse(cached.fetchedAt);
    const fresh =
      Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CACHE_TTL_MS;
    const forceBlocked = forceRefresh && ageMs < FORCE_REFRESH_MIN_AGE_MS;
    if (fresh && (!forceRefresh || forceBlocked)) {
      return { status: 200, body: { ...cached.payload, cached: true } };
    }
  }

  // ---- set map (needed by the per-game catalogues; eBay never needs it) ----
  let setMap: any = null;
  let setMapFailed = false;
  if (sb && set) {
    try {
      const { data, error } = await sb
        .from("tcg_set_map")
        .select(
          "tcgdex_set_id, scryfall_set_code, ygoprodeck_set_name, cardmarket_expansion_id, tcgplayer_group_id, tcgcsv_group_id",
        )
        .eq("category", category)
        .eq("teg_set", set)
        .maybeSingle();
      if (error) setMapFailed = true;
      else if (data) setMap = data;
    } catch {
      setMapFailed = true;
    }
  }

  // ---- step 3: parallel fan-out, 8 s per source, one failure never kills
  // the others (Promise.allSettled) — §5.2 step 3, §5.1 principle 4 ----
  const tokenProvider =
    deps.ebayTokenProvider ??
    createEbayTokenProvider(
      fetchImpl,
      deps.ebayAppId ?? "",
      deps.ebayCertId ?? "",
      timeoutMs,
    );
  const ebayQuery = [name, set, number].filter(Boolean).join(" ");
  const attempted: string[] = [];
  const jobs: Array<[string, Promise<SourceResult>]> = [];

  const addJob = (key: string, p: Promise<SourceResult>) => {
    attempted.push(key);
    jobs.push([key, p]);
  };
  if (category === "pokemon") {
    addJob(
      "tcgdex",
      setMapFailed
        ? Promise.resolve({ status: "error", note: "Set map lookup failed" })
        : fetchTcgdex(fetchImpl, setMap?.tcgdex_set_id ?? null, number, language, timeoutMs),
    );
  }
  if (category === "magic") {
    addJob(
      "scryfall",
      setMapFailed
        ? Promise.resolve({ status: "error", note: "Set map lookup failed" })
        : fetchScryfall(fetchImpl, name, setMap?.scryfall_set_code ?? null, timeoutMs),
    );
  }
  if (category === "yugioh") {
    addJob(
      "ygoprodeck",
      setMapFailed
        ? Promise.resolve({ status: "error", note: "Set map lookup failed" })
        : fetchYgoprodeck(fetchImpl, name, timeoutMs),
    );
  }
  addJob("ebay", fetchEbay(fetchImpl, tokenProvider, ebayQuery, timeoutMs));
  addJob("cardmarketFile", fetchMappedTablePrice(sb, "cardmarket_prices", cardKey));
  addJob("tcgcsv", fetchMappedTablePrice(sb, "tcgplayer_prices", cardKey));

  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const sources: Record<string, SourceResult> = {
    tcgdex: { status: "not_applicable" },
    scryfall: { status: "not_applicable" },
    ygoprodeck: { status: "not_applicable" },
    ebay: { status: "not_applicable" },
    cardmarketFile: { status: "not_applicable" },
    tcgcsv: { status: "not_applicable" },
  };
  settled.forEach((r, i) => {
    const key = jobs[i][0];
    if (r.status === "fulfilled") sources[key] = r.value;
    else sources[key] = { status: "error", note: "Source failed unexpectedly" };
  });

  // ---- step 5: ALL upstream failed -> HTTP 200 { status: "unavailable" } ----
  const allFailed =
    attempted.length > 0 &&
    attempted.every((k) => sources[k]?.status === "error");
  const asOf = new Date(nowMs).toISOString();
  if (allFailed) {
    return {
      status: 200,
      body: {
        status: "unavailable",
        reason: "All market sources failed for this card.",
        cardKey,
        asOf,
        sources,
        sales,
      },
    };
  }

  // ---- step 4: FX + IDR conversion + cache write ----
  const fx = await fetchFx(fetchImpl, sb, timeoutMs);
  const converted: Record<string, number> = {};
  const ebay = sources.ebay;
  if (ebay?.status === "ok" && typeof ebay.cheapestActive === "number") {
    converted.cheapestActiveIDR = Math.round(ebay.cheapestActive * fx.USD_IDR);
  }
  const tcgdexMarket =
    sources.tcgdex?.status === "ok"
      ? toNum((sources.tcgdex.tcgplayer as any)?.market)
      : null;
  const tcgcsvMarket =
    sources.tcgcsv?.status === "ok" ? toNum(sources.tcgcsv.market) : null;
  const cmTrend =
    sources.cardmarketFile?.status === "ok"
      ? toNum(sources.cardmarketFile.trend)
      : null;
  if (tcgdexMarket !== null) {
    converted.marketIDR = Math.round(tcgdexMarket * fx.USD_IDR);
  } else if (tcgcsvMarket !== null) {
    converted.marketIDR = Math.round(tcgcsvMarket * fx.USD_IDR);
  } else if (cmTrend !== null && fx.EUR_IDR !== null) {
    converted.marketIDR = Math.round(cmTrend * fx.EUR_IDR);
  }

  const body: Record<string, unknown> = {
    cardKey,
    asOf,
    cached: false,
    sources,
    sales,
    fx: compact({ USD_IDR: fx.USD_IDR, EUR_IDR: fx.EUR_IDR, asOf: fx.asOf }),
    converted,
  };
  await writeCache(sb, cardKey, category, body, nowMs);
  return { status: 200, body };
}
