// refresh-market-files.mjs — TEG v27.7 Fase 1b (job harian, GitHub Actions)
// ---------------------------------------------------------------------------
// What this does (see design spec §5.5) — TCGCSV-ONLY in this round:
//   1. Downloads the TCGCSV per-group PRICES file (TCGCSV_URL, must end
//      in "/prices") AND the matching PRODUCTS file (same URL with
//      "/prices" -> "/products") and JOINS them on productId — the
//      prices file carries NO groupId/name/number, the products file
//      carries them (verified 2026-11-16 on group 23286, Paradox Rift;
//      see the TCGCSV_URL comment below). The Cardmarket price-guide
//      step is DEFERRED — user decision 2026-11-16 01:30 WIB,
//      follow-up round, NOT this round; see CARDMARKET_ENABLED below.
//   2. Reads the mapped sets/groups from Supabase table `tcg_set_map`.
//   3. Imports ONLY products from mapped groups into `tcgplayer_prices`
//      (never the whole file — Supabase free tier is 500 MB).
//      Every imported row also carries `card_key` (spec §5.2 step 1:
//      `category|name|set|number`) — that is the column the
//      `market-prices` Edge Function looks up with
//      `.eq("card_key", cardKey)`, so without it the TCGCSV source stays
//      `not_available`. The job builds it from the PRODUCTS file's
//      product name (trailing " - NNN/NNN" suffix stripped — verified
//      on all 266 numbered products of group 23286) + the card number
//      from extendedData ("Number" -> "Card Number", e.g. "001/182")
//      + the mapped group (group -> category + teg_set via tcg_set_map).
//      A row whose product carries no usable name/number (e.g. sealed
//      product: ETB, booster bundle) is still upserted, but WITHOUT
//      card_key (NULL) + an explicit warning — it stays `not_available`
//      until the mapping exists. card_key collisions (e.g. two printings,
//      same name+set+number) are deduped, first row wins, because
//      card_key is UNIQUE per table and the Edge Function uses
//      `.maybeSingle()`. NOTE: one product can have several prices rows
//      (subTypeName: Normal / Reverse Holofoil / Holofoil) — the first
//      row wins, so the winning subType follows the file order; a later
//      round could prefer Normal explicitly.
//   4. Refreshes `fx_rates` from exchangerate-api.com (old values are kept
//      when that fetch fails).
//
// Failure policy (spec §5.5 + task): ANY download/upstream failure is
// logged as a warning and the script exits 0. Yesterday's tables stay in
// use; the UI shows the observation date. The ONLY hard failure (exit 1)
// is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, i.e. a
// misconfiguration the owner must fix — that is not a download failure.
//
// Secrets: NONE in this file. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// come from GitHub Secrets via environment variables. Never paste values
// here, in the workflow, or in chat.
//
// Node 20, zero dependencies (global fetch only). Run with:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node refresh-market-files.mjs
// Optional env:
//   TCGCSV_URL               — per-group PRICES file URL, must end in
//                              "/prices" (e.g. .../tcgplayer/3/23286/prices);
//                              the products URL is derived from it. Formats
//                              verified 2026-11-16 — see the TCGCSV comment
//                              above the TCGCSV_URL constant.
//   CARDMARKET_ENABLED=true  — DEFERRED: re-enables the Cardmarket step in a
//                              follow-up round (default off; do NOT enable
//                              yet — user decision 2026-11-16 01:30 WIB)
//   CARDMARKET_PRODUCTS_URL  — DEFERRED with the Cardmarket step; optional
//                              products-catalog file, used ONLY to join
//                              idProduct -> expansion when the price guide
//                              itself carries no expansion id
//   DRY_RUN=true             — log what would be upserted, write nothing
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY_RUN = process.env.DRY_RUN === "true";

// --- Upstream URLs ---------------------------------------------------------
//
// DEFERRED — Cardmarket price guide (follow-up round, NOT this round).
// User decision 2026-11-16 01:30 WIB: the daily job in this round is
// TCGCSV-ONLY; the Cardmarket download + upsert step is disabled by
// default. To re-enable in a later round: set CARDMARKET_ENABLED=true
// (env, or the workflow env block) AND verify CARDMARKET_PRICE_GUIDE_URL
// below still serves the current price guide (VERIFY_AT_BUILD, spec §2.3).
// Until then refreshCardmarket() is never called from main() and no
// Cardmarket file is downloaded. The code is kept intact (gated, not
// deleted) so the follow-up round only flips the flag.
//   https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json
// Cardmarket publishes this file daily and free, no account needed.
// VERIFY ON FIRST RUN: confirm the path still serves the current price
// guide (~23 MB JSON) before trusting the numbers; if Cardmarket moved it,
// update this constant and note the new path in the workflow README.
const CARDMARKET_ENABLED = process.env.CARDMARKET_ENABLED === "true";
const CARDMARKET_PRICE_GUIDE_URL =
  "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json";

// TCGCSV per-group files — formats VERIFIED 2026-11-16 on group 23286
// ("SV04: Paradox Rift", TCGplayer group id 23286, from TCGCSV's own
// group list). Set TCGCSV_URL (env var, or the workflow_dispatch
// `tcgcsv_url` input) to the PRICES file URL, which MUST end in
// "/prices" — the products URL is derived from it by replacing that
// trailing "/prices" with "/products". No URL is hardcoded here.
//   Prices file:  https://tcgcsv.com/tcgplayer/3/23286/prices
//     -> {"success":true,"errors":[],"results":[
//          {"productId":523584,"lowPrice":...,"midPrice":...,
//           "highPrice":...,"marketPrice":...,"directLowPrice":null,
//           "subTypeName":"Normal"}]}  (469 rows for group 23286)
//     NOTE: the prices file carries NO groupId, NO name, NO number —
//     it cannot be keyed on its own.
//   Products file: https://tcgcsv.com/tcgplayer/3/23286/products
//     -> {"totalItems":309,"success":true,"errors":[],"results":[
//          {"productId":523584,"name":"Surskit","cleanName":"Surskit",
//           "groupId":23286,
//           "extendedData":[{"name":"Number","displayName":"Card Number",
//                            "value":"001/182"}, ...]}]}  (309 items;
//     266 carry a Number — the cards; the other 43 are sealed products
//     with no Number and get no card_key, by design.)
//     NOTE: a card's `name` is the plain card name OR the card name
//     plus a trailing " - NNN/NNN" suffix (147 of the 266 numbered
//     products, e.g. "Froslass ex - 003/182"); stripping that suffix
//     was verified to equal cleanName-minus-number on ALL 266.
//   The job downloads BOTH files and joins them on productId; without
//   the products file there is no name/number/group to filter or key by,
//   so the step is skipped (never guessed, never whole-file).
const TCGCSV_URL = process.env.TCGCSV_URL || "";
const TCGCSV_URL_IS_PLACEHOLDER = TCGCSV_URL.trim() === "";

// Optional products catalog (same Cardmarket host family, e.g. the
// `products_singles_1.json` files named in spec §2.3). DEFERRED with the
// Cardmarket step (see CARDMARKET_ENABLED above) — only used by
// refreshCardmarket(), which is not called while the step is deferred.
// Needed for TWO things: (a) join idProduct -> expansion id when the price
// guide itself carries no expansion id, and (b) join idProduct -> product
// name + number so the job can build `card_key` (spec §5.2 step 1) for
// each row. Without it, rows whose price-guide entry carries no
// name/number are SKIPPED (never written with an invented card_key).
// Leave unset unless the price guide turns out to lack expansion info
// — the exact path is likewise VERIFY_AT_BUILD, not hardcoded.
const CARDMARKET_PRODUCTS_URL = process.env.CARDMARKET_PRODUCTS_URL || "";

// FX source already used by TEG (spec §1): public free endpoint, no key.
const FX_URL = "https://api.exchangerate-api.com/v4/latest/USD";
const FX_FALLBACK_USD_IDR = 16500; // spec §1 / §5.3 — only a display fallback

const FETCH_TIMEOUT_MS = 120_000; // 23 MB file on a slow day
const UPSERT_CHUNK = 500;

const todayISO = () => new Date().toISOString().slice(0, 10);

const log = (...a) => console.log(`[refresh-market-files]`, ...a);
const warn = (...a) => console.warn(`[refresh-market-files] WARNING:`, ...a);
const error = (...a) => console.error(`[refresh-market-files] ERROR:`, ...a);

const summary = { cardmarket: null, tcgcsv: null, fx: null };

// --- Small fetch helpers ---------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url, label) {
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "TEG-market-refresh/1.0 (GitHub Actions)" },
  });
  if (!res.ok) throw new Error(`${label} download failed: HTTP ${res.status}`);
  return await res.text();
}

// --- Supabase REST (service_role, server-side only) ------------------------

function sbHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function sbGetTable(table, select) {
  const url =
    `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}` +
    `?select=${encodeURIComponent(select)}`;
  const res = await fetchWithTimeout(url, { headers: sbHeaders() }, 30_000);
  if (!res.ok) {
    throw new Error(`Supabase GET ${table} failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200)).catch(() => "")}`);
  }
  return await res.json();
}

async function sbUpsert(table, rows) {
  if (rows.length === 0) return 0;
  if (DRY_RUN) {
    log(`DRY_RUN: would upsert ${rows.length} rows into ${table} (skipped)`);
    return rows.length;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${table}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          ...sbHeaders(),
          // Merge on primary-key conflict (id_product / product_id / pair).
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      },
      30_000,
    );
    if (!res.ok) {
      throw new Error(
        `Supabase upsert ${table} failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`,
      );
    }
    written += chunk.length;
  }
  return written;
}

// --- Generic tolerant parsing ---------------------------------------------
// Upstream file shapes are NOT fully pinned by the spec, so parsing accepts
// the field-name variants the vendors document and warns (rather than
// crashing) when a shape is unrecognised. Never invent a price: a row that
// cannot be read is skipped and counted.

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function toNumber(v) {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- card_key helpers ------------------------------------------------------
// Byte-for-byte the same normalisation as the Edge Function's buildCardKey
// (edge-function/market-prices/logic.ts, spec §5.2 step 1):
//   category | nama-lower-tanpa-tanda-baca | set-normalized | nomor
// e.g. "pokemon|zeraora|ma6|137". The job MUST build the key exactly this
// way, or the Edge Function's `.eq("card_key", cardKey)` lookup will
// never match a row the job wrote. Rules mirrored from logic.ts:
//   name   — strip diacritics, lowercase, drop [^a-z0-9]
//   set    — drop parenthetical qualifiers ("MA6 (Indonesian)" -> "ma6"),
//            then same as name
//   number — part before "/" ("137/130" -> "137"), then same as name
//   category — used as stored in tcg_set_map (already lowercase there).
// A key is only usable when ALL FOUR parts are non-empty: a missing
// number (or name) makes the key ambiguous (two printings, same
// name+set, different numbers), so callers must NOT write a partial key.

function stripDiacritics(s) {
  return String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeName(s) {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeSet(s) {
  const noParen = stripDiacritics(s).replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return noParen.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeNumber(s) {
  const head = String(s ?? "").split("/")[0].trim();
  return stripDiacritics(head).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildCardKey(category, name, set, number) {
  const parts = [
    String(category ?? ""),
    normalizeName(name),
    normalizeSet(set),
    normalizeNumber(number),
  ];
  if (parts.some((p) => p === "")) return null; // incomplete: do not invent
  return parts.join("|");
}

// Dedupe guard: card_key is UNIQUE per table and the Edge Function uses
// .maybeSingle(), so two rows must never share one key. First row wins;
// collisions are counted and warned about by the caller.
function dedupeByCardKey(rows) {
  const seen = new Set();
  const out = [];
  let collisions = 0;
  for (const r of rows) {
    if (r.card_key === undefined || r.card_key === null) { out.push(r); continue; }
    if (seen.has(r.card_key)) { collisions++; continue; }
    seen.add(r.card_key);
    out.push(r);
  }
  return { rows: out, collisions };
}

function jsonArray(text, label) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: not valid JSON (${e.message})`);
  }
  if (Array.isArray(data)) return data;
  for (const key of ["priceGuide", "price_guide", "products", "data", "results", "items"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  throw new Error(`${label}: JSON has no top-level array (keys: ${Object.keys(data || {}).join(", ")})`);
}

// Minimal CSV parser (handles quoted fields with commas/quotes).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new Error("CSV: fewer than 2 lines");
  const splitLine = (line) => {
    const out = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

// --- Step 1: mapped sets/groups --------------------------------------------

async function loadSetMap() {
  const rows = await sbGetTable(
    "tcg_set_map",
    "category,teg_set,cardmarket_expansion_id,tcgplayer_group_id,tcgcsv_group_id",
  );
  const map = {
    cardmarketExpansionIds: new Set(),
    tcgcsvGroupIds: new Set(),
    tcgplayerGroupIds: new Set(),
    // card_key building: expansion/group id -> { category, tegSet }.
    // The category + teg_set come straight from tcg_set_map, so the key
    // the job builds is the same string the Edge Function builds from
    // the grading input (spec §5.2 step 1). First row wins if an id ever
    // appears on two set rows (should not happen — ids are per set).
    cardmarketExpansionMap: new Map(),
    tcgcsvGroupMap: new Map(),
    rows: rows.length,
  };
  for (const r of rows) {
    if (r.cardmarket_expansion_id != null) {
      map.cardmarketExpansionIds.add(Number(r.cardmarket_expansion_id));
      if (!map.cardmarketExpansionMap.has(Number(r.cardmarket_expansion_id))) {
        map.cardmarketExpansionMap.set(Number(r.cardmarket_expansion_id), { category: r.category, tegSet: r.teg_set });
      }
    }
    if (r.tcgcsv_group_id != null) {
      map.tcgcsvGroupIds.add(Number(r.tcgcsv_group_id));
      if (!map.tcgcsvGroupMap.has(Number(r.tcgcsv_group_id))) {
        map.tcgcsvGroupMap.set(Number(r.tcgcsv_group_id), { category: r.category, tegSet: r.teg_set });
      }
    }
    if (r.tcgplayer_group_id != null) {
      map.tcgplayerGroupIds.add(Number(r.tcgplayer_group_id));
      if (!map.tcgcsvGroupMap.has(Number(r.tcgplayer_group_id))) {
        map.tcgcsvGroupMap.set(Number(r.tcgplayer_group_id), { category: r.category, tegSet: r.teg_set });
      }
    }
  }
  return map;
}

// --- Step 2 (DEFERRED): Cardmarket price guide ----------------------------
// DEFERRED — follow-up round, NOT this round (user decision 2026-11-16
// 01:30 WIB; job is TCGCSV-only). The function is kept intact and gated
// by CARDMARKET_ENABLED in main(); it is never called while the flag is
// off. Do NOT call it from main() without flipping the flag AND verifying
// CARDMARKET_PRICE_GUIDE_URL (VERIFY_AT_BUILD, spec §2.3).

async function refreshCardmarket(setMap) {
  if (setMap.cardmarketExpansionIds.size === 0) {
    warn("Cardmarket: no cardmarket_expansion_id values in tcg_set_map — skipping (nothing mapped yet).");
    summary.cardmarket = "skipped: no mapped expansions";
    return;
  }
  const text = await fetchText(CARDMARKET_PRICE_GUIDE_URL, "Cardmarket price guide");
  log(`Cardmarket: downloaded ${(text.length / 1_048_576).toFixed(1)} MB`);
  const entries = jsonArray(text, "Cardmarket price guide");

  // Optional join source: products catalog idProduct -> { expansion, name,
  // number }. Only fetched when set (env CARDMARKET_PRODUCTS_URL);
  // otherwise the price guide itself must carry an expansion id per entry
  // AND a name/number per entry for card_key. VERIFY_AT_BUILD: the
  // catalog's exact field names for name/number were NOT pinned by the
  // spec (§2.3 only names the file, products_singles_1.json) — the picks
  // below are the common variants; check the first run's log
  // ("with name / with number") and adjust the field mapping if the
  // counts come out 0. Never invent a name/number.
  let productInfo = null;
  if (CARDMARKET_PRODUCTS_URL) {
    try {
      const pText = await fetchText(CARDMARKET_PRODUCTS_URL, "Cardmarket products catalog");
      const pEntries = jsonArray(pText, "Cardmarket products catalog");
      productInfo = new Map();
      let withName = 0, withNumber = 0;
      for (const p of pEntries) {
        const pid = toNumber(pick(p, "idProduct", "productId", "id"));
        const exp = toNumber(pick(p, "idExpansion", "expansionId", "idExpansionId", "expansion_id"));
        const pname = pick(p, "name", "productName", "cardName", "product_name");
        const pnum = pick(p, "number", "cardNumber", "numberInSet", "card_number", "number_in_set");
        if (pid !== undefined) {
          if (typeof pname === "string" && pname.trim() !== "") withName++;
          if (pnum !== undefined && String(pnum).trim() !== "") withNumber++;
          productInfo.set(pid, { expansion: exp, name: pname, number: pnum });
        }
      }
      log(`Cardmarket: products catalog join map has ${productInfo.size} products (${withName} with name, ${withNumber} with number)`);
    } catch (e) {
      warn(`Cardmarket: products catalog failed (${e.message}) — continuing without join map.`);
    }
  }

  const rows = [];
  let skippedNoExpansion = 0, skippedNoPrice = 0, skippedUnmapped = 0, skippedNoCardKey = 0;
  for (const e of entries) {
    const idProduct = toNumber(pick(e, "idProduct", "productId", "id"));
    const trend = toNumber(pick(e, "trend", "avgTrend"));
    const avg = toNumber(pick(e, "avg", "avgPrice"));
    const low = toNumber(pick(e, "low", "lowPrice"));
    if (idProduct === undefined || (trend === undefined && avg === undefined && low === undefined)) {
      skippedNoPrice++;
      continue;
    }
    let expansion = toNumber(pick(e, "idExpansion", "expansionId", "idExpansionId", "expansion_id"));
    const info = productInfo?.get(idProduct);
    if (expansion === undefined && info?.expansion !== undefined) expansion = info.expansion;
    if (expansion === undefined) { skippedNoExpansion++; continue; }
    if (!setMap.cardmarketExpansionIds.has(expansion)) { skippedUnmapped++; continue; }
    // card_key (spec §5.2 step 1) — the Edge Function looks rows up by
    // this key, so a row without it is invisible to the API. Name/number
    // come from the price-guide entry itself when present, else from the
    // products-catalog join; set/category come from tcg_set_map via the
    // expansion id. If any part is missing the row is SKIPPED (never
    // written with an invented card_key).
    const setEntry = setMap.cardmarketExpansionMap.get(expansion);
    const name = pick(e, "name", "productName", "cardName") ?? info?.name;
    const number = pick(e, "number", "cardNumber", "numberInSet", "card_number") ?? info?.number;
    const cardKey = buildCardKey(setEntry?.category, name, setEntry?.tegSet, number);
    if (cardKey === null) { skippedNoCardKey++; continue; }
    rows.push({ id_product: idProduct, card_key: cardKey, trend: trend ?? null, avg: avg ?? null, low: low ?? null, updated: todayISO() });
  }
  log(`Cardmarket: ${entries.length} entries scanned, ${rows.length} mapped, ${skippedUnmapped} unmapped skipped, ${skippedNoExpansion} without expansion id skipped, ${skippedNoCardKey} without card-key data skipped, ${skippedNoPrice} unreadable skipped`);

  if (skippedNoExpansion === entries.length) {
    // The price guide carries no expansion info and no join map was given.
    // Importing the whole file is FORBIDDEN (spec §5.3) — skip, warn loudly.
    warn("Cardmarket: NO entry carried an expansion id and no products-catalog join was available — cannot filter to mapped sets, so NOTHING was imported (whole-file import is forbidden, spec §5.3). Set CARDMARKET_PRODUCTS_URL to a products-catalog file to enable the join.");
    summary.cardmarket = "skipped: no expansion info to filter by";
    return;
  }
  if (skippedNoCardKey > 0) {
    warn(`Cardmarket: ${skippedNoCardKey} mapped row(s) SKIPPED — no product name/number to build card_key (products catalog ${CARDMARKET_PRODUCTS_URL ? "set but did not map them for these products" : "not set — set CARDMARKET_PRODUCTS_URL"}; the price-guide entries carried none either). Those cards stay not_available in the Edge Function until the catalog join supplies name + number — verify the catalog's name/number field names on the first run (VERIFY_AT_BUILD).`);
  }
  const deduped = dedupeByCardKey(rows);
  if (deduped.collisions > 0) {
    warn(`Cardmarket: ${deduped.collisions} card_key collision(s) — two products share one name+set+number; first row kept, the rest dropped (card_key is UNIQUE per table; the Edge Function uses .maybeSingle()).`);
  }
  const written = await sbUpsert("cardmarket_prices", deduped.rows);
  summary.cardmarket = `upserted ${written} rows (of ${entries.length} scanned)`;
  log(`Cardmarket: ${summary.cardmarket}`);
}

// --- Step 3: TCGCSV per-group files (prices + products, joined) --------
// VERIFIED 2026-11-16 on group 23286 (Paradox Rift):
//   prices file   -> {results:[{productId, lowPrice, midPrice, highPrice,
//                    marketPrice, directLowPrice, subTypeName}]} —
//                    NO groupId, NO name, NO number.
//   products file -> {results:[{productId, name, cleanName, groupId,
//                    extendedData:[{name:"Number", value:"001/182"}]}]}
// The step downloads BOTH (products URL = TCGCSV_URL with trailing
// "/prices" replaced by "/products") and joins on productId. Without
// the products file there is no group to filter by and no name/number
// to build card_key with, so the step is skipped — never guessed, never
// whole-file. The products file is group-scoped, so every entry in it
// already belongs to one group; the mapped-groups filter still applies
// per entry (a URL for an unmapped group imports nothing).

// Card name as TCGCSV prints it: the plain card name, or the card name
// plus a trailing " - NNN/NNN" suffix (e.g. "Froslass ex - 003/182").
// Stripping that suffix was verified on ALL 266 numbered products of
// group 23286 to equal cleanName with the number tokens removed
// (0 mismatches), so the cleaned name is exactly the card name the
// Edge Function receives from grading input — the card_key built from
// it matches logic.ts buildCardKey for the same card.
function tcgcsvCardName(rawName) {
  if (typeof rawName !== "string") return undefined;
  const cleaned = rawName.replace(/\s*-\s*\d+\/\d+\s*$/, "").trim();
  return cleaned === "" ? undefined : cleaned;
}

// Card number from a TCGCSV products entry: extendedData holds it as
// {"name":"Number","displayName":"Card Number","value":"001/182"}.
// (A top-level number field does not exist in the verified format;
// the pick() fallback covers it if a future file adds one.)
function tcgcsvCardNumber(product) {
  const ext = product?.extendedData;
  if (Array.isArray(ext)) {
    for (const d of ext) {
      if (
        d && (d.name === "Number" || d.name === "Card Number") &&
        d.value !== undefined && d.value !== null &&
        String(d.value).trim() !== ""
      ) {
        return String(d.value);
      }
    }
  }
  const top = pick(product, "number", "cardNumber", "numberInSet", "card_number");
  return top === undefined ? undefined : String(top);
}

async function refreshTcgcsv(setMap) {
  if (TCGCSV_URL_IS_PLACEHOLDER) {
    warn("TCGCSV: no TCGCSV_URL set. Set it (env, or workflow_dispatch `tcgcsv_url`) to the per-group PRICES file URL, e.g. https://tcgcsv.com/tcgplayer/3/23286/prices — the products file URL is derived from it. Skipping TCGCSV step.");
    summary.tcgcsv = "skipped: no TCGCSV_URL";
    return;
  }
  const mappedGroups = new Set([...setMap.tcgcsvGroupIds, ...setMap.tcgplayerGroupIds]);
  if (mappedGroups.size === 0) {
    warn("TCGCSV: no tcgcsv_group_id / tcgplayer_group_id values in tcg_set_map — skipping (nothing mapped yet).");
    summary.tcgcsv = "skipped: no mapped groups";
    return;
  }
  if (!TCGCSV_URL.endsWith("/prices")) {
    warn("TCGCSV: TCGCSV_URL must end with /prices (per-group prices file, e.g. .../tcgplayer/3/23286/prices) so the products file URL can be derived from it (.../products). Skipping TCGCSV step — the URL is not guessed.");
    summary.tcgcsv = "skipped: TCGCSV_URL is not a per-group prices URL";
    return;
  }
  const productsUrl = TCGCSV_URL.slice(0, -"/prices".length) + "/products";
  const priceText = await fetchText(TCGCSV_URL, "TCGCSV prices");
  log(`TCGCSV: downloaded prices ${(priceText.length / 1_048_576).toFixed(2)} MB`);
  let prodText;
  try {
    prodText = await fetchText(productsUrl, "TCGCSV products");
  } catch (e) {
    warn(`TCGCSV: products file failed (${e.message}) — the prices file carries no groupId/name/number, so no row can be filtered or keyed without the join. Skipping TCGCSV step; yesterday's tcgplayer_prices stay in use.`);
    summary.tcgcsv = "skipped: products file failed, join impossible";
    return;
  }
  log(`TCGCSV: downloaded products ${(prodText.length / 1_048_576).toFixed(2)} MB`);
  const priceEntries = jsonArray(priceText, "TCGCSV prices");
  const prodEntries = jsonArray(prodText, "TCGCSV products");

  // Join map: productId -> { groupId, name, number } from the products file.
  const productInfo = new Map();
  let productsWithGroup = 0, productsWithName = 0, productsWithNumber = 0;
  for (const p of prodEntries) {
    const pid = toNumber(pick(p, "productId", "product_id", "productID", "id"));
    if (pid === undefined) continue;
    const groupId = toNumber(pick(p, "groupId", "group_id", "groupID"));
    const rawName = pick(p, "name", "cleanName", "productName", "product_name");
    const number = tcgcsvCardNumber(p);
    if (groupId !== undefined) productsWithGroup++;
    if (typeof rawName === "string" && rawName.trim() !== "") productsWithName++;
    if (number !== undefined && String(number).trim() !== "") productsWithNumber++;
    productInfo.set(pid, { groupId, name: rawName, number });
  }
  log(`TCGCSV: products join map has ${productInfo.size} products (${productsWithGroup} with group id, ${productsWithName} with name, ${productsWithNumber} with number)`);
  if (productsWithGroup === 0) {
    // No entry carried a group id — cannot filter to mapped groups, so
    // NOTHING is imported (whole-file import is forbidden, spec §5.3).
    warn("TCGCSV: NO products entry carried a group id — cannot filter to mapped groups, so NOTHING was imported (whole-file import is forbidden, spec §5.3). Check the products file format against https://tcgcsv.com/faq and adjust the field mapping.");
    summary.tcgcsv = "skipped: no group info to filter by";
    return;
  }

  const rows = [];
  let skippedUnmapped = 0, skippedNoPrice = 0, skippedNoGroup = 0, skippedNoProduct = 0, skippedNoCardKey = 0;
  for (const e of priceEntries) {
    const productId = toNumber(pick(e, "productId", "product_id", "productID", "id"));
    const market = toNumber(pick(e, "marketPrice", "market", "market_price"));
    const low = toNumber(pick(e, "lowPrice", "low", "low_price"));
    const mid = toNumber(pick(e, "midPrice", "mid", "mid_price"));
    const high = toNumber(pick(e, "highPrice", "high", "high_price"));
    if (productId === undefined || (market === undefined && low === undefined && mid === undefined && high === undefined)) {
      skippedNoPrice++;
      continue;
    }
    // Join: name/number/group come from the products file, never from
    // the prices file (it carries none of them).
    const info = productInfo.get(productId);
    if (info === undefined) { skippedNoProduct++; continue; }
    const groupId = info.groupId;
    if (groupId === undefined) { skippedNoGroup++; continue; }
    if (!mappedGroups.has(groupId)) { skippedUnmapped++; continue; }
    // card_key (spec §5.2 step 1) — the Edge Function looks rows up by
    // this key, so a row without it is invisible to the API. Name is
    // the products file's name with the trailing " - NNN/NNN" suffix
    // stripped (tcgcsvCardName, verified on group 23286); number is the
    // extendedData "Number" (e.g. "001/182"); set/category come from
    // tcg_set_map via the group id. If any part is missing the row is
    // STILL upserted — with card_key: null. The key must ALWAYS be
    // present in the payload: PostgREST rejects a bulk upsert whose
    // objects have different key sets (PGRST102 "All object keys must
    // match") — omitting the property on some rows fails the whole
    // batch (verified live 2026-11-16, workflow run #2). NULL card_key
    // is fine for the UNIQUE constraint (Postgres treats NULLs as
    // distinct). A NULL-card_key row is stored but invisible to the
    // Edge Function's .eq("card_key", ...) lookup. Never invent one.
    const setEntry = setMap.tcgcsvGroupMap.get(groupId);
    const cardKey = buildCardKey(setEntry?.category, tcgcsvCardName(info.name), setEntry?.tegSet, info.number);
    const row = { product_id: productId, card_key: cardKey, market: market ?? null, low: low ?? null, mid: mid ?? null, high: high ?? null, updated: todayISO() };
    if (cardKey === null) { skippedNoCardKey++; }
    rows.push(row);
  }
  log(`TCGCSV: ${priceEntries.length} prices entries scanned, ${prodEntries.length} products in join map, ${rows.length} mapped, ${skippedUnmapped} unmapped skipped, ${skippedNoGroup} without group id skipped, ${skippedNoProduct} prices rows with no products entry skipped, ${skippedNoCardKey} without card-key data (stored without card_key), ${skippedNoPrice} unreadable skipped`);
  if (skippedNoCardKey > 0) {
    warn(`TCGCSV: ${skippedNoCardKey} row(s) stored WITHOUT card_key (NULL) — the product carried no usable name/number to build the §5.2 step 1 key (sealed products have no Number). Those rows stay not_available in the Edge Function until the format supplies name + number — prices are still stored under product_id for reference; only the per-card lookup is blind to them.`);
  }
  const deduped = dedupeByCardKey(rows);
  if (deduped.collisions > 0) {
    warn(`TCGCSV: ${deduped.collisions} card_key collision(s) — two rows share one key (a product with several subType prices: Normal / Reverse Holofoil / Holofoil); first row wins, the rest dropped (card_key is UNIQUE per table; the Edge Function uses .maybeSingle()).`);
  }
  const written = await sbUpsert("tcgplayer_prices", deduped.rows);
  summary.tcgcsv = `upserted ${written} rows (of ${priceEntries.length} prices entries scanned)`;
  log(`TCGCSV: ${summary.tcgcsv}`);
}

// --- Step 4: FX rates ---------------------------------------------------------
// exchangerate-api.com free endpoint, USD base. EUR_IDR is derived:
// EUR_IDR = USD_IDR / EUR-per-USD. On ANY failure the old fx_rates rows
// stay untouched (spec §5.3) and the step warns instead of failing.

async function refreshFx() {
  try {
    const res = await fetchWithTimeout(FX_URL, {}, 30_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const usdIdr = toNumber(data?.rates?.IDR);
    const eurPerUsd = toNumber(data?.rates?.EUR);
    if (usdIdr === undefined) throw new Error("response has no rates.IDR");
    const rows = [{ pair: "USD_IDR", rate: usdIdr, as_of: todayISO() }];
    if (eurPerUsd !== undefined && eurPerUsd > 0) {
      rows.push({ pair: "EUR_IDR", rate: +(usdIdr / eurPerUsd).toFixed(2), as_of: todayISO() });
    } else {
      warn("FX: response has no rates.EUR — EUR_IDR left at its previous value.");
    }
    const written = await sbUpsert("fx_rates", rows);
    summary.fx = `upserted ${written} row(s) (USD_IDR=${usdIdr})`;
    log(`FX: ${summary.fx}`);
  } catch (e) {
    warn(`FX: refresh failed (${e.message}) — keeping previous fx_rates rows (fallback USD_IDR ${FX_FALLBACK_USD_IDR} remains in app code).`);
    summary.fx = "skipped: fetch failed, previous values kept";
  }
}

// --- Main ---------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    error("Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (GitHub Secrets). This is a configuration error, not a download failure — exiting 1 so the misconfiguration is visible.");
    process.exitCode = 1;
    return;
  }

  let setMap;
  try {
    setMap = await loadSetMap();
    log(`tcg_set_map: ${setMap.rows} mapped set(s) — Cardmarket expansions: ${setMap.cardmarketExpansionIds.size}, TCGCSV/TCGplayer groups: ${new Set([...setMap.tcgcsvGroupIds, ...setMap.tcgplayerGroupIds]).size}`);
  } catch (e) {
    // Cannot filter without the map, and importing unfiltered is forbidden:
    // warn and exit 0 — yesterday's tables stay in use.
    warn(`Could not read tcg_set_map (${e.message}) — cannot filter safely, skipping all imports. Exiting 0; yesterday's tables stay in use.`);
    summary.cardmarket = "deferred (follow-up round — not run this round)";
    summary.tcgcsv = "skipped: tcg_set_map unreadable";
    await refreshFx().catch(() => {});
    printSummary();
    return;
  }

  // Each step is independent: one failing must not kill the others.
  // Cardmarket step is DEFERRED this round (user decision 2026-11-16
  // 01:30 WIB — job is TCGCSV-only); gated behind CARDMARKET_ENABLED,
  // default off. Do not call refreshCardmarket() unconditionally.
  if (CARDMARKET_ENABLED) {
    try { await refreshCardmarket(setMap); }
    catch (e) { warn(`Cardmarket step failed (${e.message}) — yesterday's cardmarket_prices stay in use.`); summary.cardmarket = `failed (soft): ${e.message}`; }
  } else {
    warn("Cardmarket: DEFERRED — follow-up round, not this round (user decision 2026-11-16 01:30 WIB). Skipping Cardmarket download + upsert; job is TCGCSV-only.");
    summary.cardmarket = "deferred (follow-up round — not run this round)";
  }

  try { await refreshTcgcsv(setMap); }
  catch (e) { warn(`TCGCSV step failed (${e.message}) — yesterday's tcgplayer_prices stay in use.`); summary.tcgcsv = `failed (soft): ${e.message}`; }

  await refreshFx();
  printSummary();
}

function printSummary() {
  const lines = [
    "## Market refresh summary",
    `- Cardmarket: ${summary.cardmarket ?? "not run"}`,
    `- TCGCSV: ${summary.tcgcsv ?? "not run"}`,
    `- FX: ${summary.fx ?? "not run"}`,
    `- Date (UTC): ${todayISO()} — DRY_RUN=${DRY_RUN}`,
    "",
    "A failed/skipped step leaves yesterday's table in use; the UI shows the observation date.",
  ];
  log(lines.join("\n"));
  // Surface the summary in the Actions run UI when available.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try { appendFileSync(summaryPath, lines.join("\n") + "\n"); } catch { /* summary is best-effort */ }
  }
}

import { appendFileSync } from "node:fs";

main().catch((e) => {
  // Last-resort guard: never hard-fail the scheduled job on an upstream
  // problem. Only a truly unexpected crash lands here; log and exit 0.
  warn(`Unexpected error (${e?.message || e}) — exiting 0; yesterday's tables stay in use.`);
  printSummary();
});
