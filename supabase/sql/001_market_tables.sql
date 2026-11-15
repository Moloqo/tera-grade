-- ============================================================================
-- TEG v27.7 Fase 1 + 1b — Market data tables
-- File: 001_market_tables.sql
-- Run FIRST, via Supabase Dashboard -> SQL Editor (by parent/user).
-- Source spec: ../design-market-data.md §5.3 (schema), §5.5 (daily job),
--              §4 (coverage).
--
-- SECURITY (by design):
--   * Row Level Security is ENABLED on every table below.
--   * NO anon policies are created on purpose. The anon key must NEVER be
--     able to read or write these tables. Only the service_role key may
--     access them, and it is used exclusively server-side by:
--       - the `market-prices` Edge Function (market_cache lookups), and
--       - the daily GitHub Actions job `refresh-market-files`
--         (cardmarket_prices, tcgplayer_prices, fx_rates).
--   * The static TEG client (GitHub Pages) never reads these tables
--     directly; it only calls the `market-prices` Edge Function.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- market_cache — per-card price cache (Edge Function `market-prices`).
-- card_key format (spec §5.2 step 1):
--   category | lowercased name without punctuation | normalized set | number
--   e.g. 'pokemon|zeraora|ma6|137'
-- expires_at = fetched_at + 24 hours (TTL 24h, spec §5.1 rule 3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.market_cache (
  card_key   TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);

-- Index for expiry sweeps / stale-cache checks.
CREATE INDEX IF NOT EXISTS idx_market_cache_expires_at
  ON public.market_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_market_cache_category
  ON public.market_cache (category);

COMMENT ON TABLE public.market_cache IS
  'Per-card market-data cache for the market-prices Edge Function. TTL 24h. Service-role only — no anon access by design.';

-- ---------------------------------------------------------------------------
-- tcg_set_map — manual mapping of TEG set strings to provider IDs.
-- Filled in manually and grown over time; seed rows live in
-- 002_seed_tcg_set_map.sql. A set that is not mapped yet is NOT an error:
-- the catalogue sources are skipped with status "not_applicable" and the
-- note "set not mapped yet" (spec §5.3), while eBay keyword search still
-- runs as a fallback.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tcg_set_map (
  id                      SERIAL PRIMARY KEY,
  category                TEXT NOT NULL,
  teg_set                 TEXT NOT NULL,
  tcgdex_set_id           TEXT,
  scryfall_set_code       TEXT,
  ygoprodeck_set_name     TEXT,
  cardmarket_expansion_id INT,
  tcgplayer_group_id      INT,
  tcgcsv_group_id         INT,
  UNIQUE (category, teg_set)
);

COMMENT ON TABLE public.tcg_set_map IS
  'Manual TEG-set -> provider-ID mapping. Provider IDs are NULL until verified and filled in by hand — never guessed. Service-role only — no anon access by design.';

-- ---------------------------------------------------------------------------
-- cardmarket_prices — Cardmarket price guide (EUR), daily public file.
-- Filled ONLY by the daily GitHub Actions job `refresh-market-files`
-- (spec §5.5), and ONLY for products of sets already present in
-- tcg_set_map. Never import the whole ~23 MB Cardmarket file into the
-- Supabase free tier (500 MB).
--
-- card_key (Fase 1b integration fix): the `market-prices` Edge Function
-- looks this table up with `.eq("card_key", cardKey)` (logic.ts
-- fetchMappedTablePrice), where cardKey is the §5.2 step 1 key
-- `category|nama-lower-tanpa-tanda-baca|set-normalized|nomor`
-- (e.g. 'pokemon|zeraora|ma6|137'). The table was first created keyed
-- only by id_product, so without this column every lookup degraded to
-- `not_available` ("No mapped row for this card"). The daily job fills
-- card_key from the products-catalog join (idProduct -> name + number)
-- plus tcg_set_map (expansion -> category + teg_set); see
-- workflow/refresh-market-files.mjs. The UNIQUE index below also
-- protects the Edge Function's `.maybeSingle()` lookup: two different
-- id_product rows must never share one card_key (the job dedupes
-- card_key collisions, first row wins, and logs them).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cardmarket_prices (
  id_product INT PRIMARY KEY,
  trend      NUMERIC,
  avg        NUMERIC,
  low        NUMERIC,
  updated    DATE
);

COMMENT ON TABLE public.cardmarket_prices IS
  'Cardmarket daily price guide (trend/avg/low, EUR) for mapped sets only. Written by the daily GitHub Actions job. Service-role only — no anon access by design.';

-- Fase 1b integration fix — card_key lookup column for the Edge Function.
-- ALTER ... IF NOT EXISTS (not a CREATE TABLE change) so this file stays
-- safe to re-run when 001 was already applied partially: on a fresh
-- install the column is simply added right after table creation.
ALTER TABLE public.cardmarket_prices ADD COLUMN IF NOT EXISTS card_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cardmarket_prices_card_key
  ON public.cardmarket_prices (card_key);
COMMENT ON COLUMN public.cardmarket_prices.card_key IS
  'Per-card lookup key for the market-prices Edge Function, format spec §5.2 step 1: category|name-lower-no-punctuation|set-normalized|number (e.g. pokemon|zeraora|ma6|137). Filled by the daily job; NULL only if a row predates the fix. UNIQUE so .maybeSingle() can never see two rows.';

-- ---------------------------------------------------------------------------
-- tcgplayer_prices — TCGplayer prices (USD) from the TCGCSV daily dump.
-- Filled ONLY by the daily GitHub Actions job `refresh-market-files`
-- (spec §5.5), and ONLY for groups already present in tcg_set_map.
-- TCGCSV is a daily file dump, not a live API (see spec §2.8).
--
-- card_key (Fase 1b integration fix): same reason as cardmarket_prices
-- above — the `market-prices` Edge Function looks this table up with
-- `.eq("card_key", cardKey)` (logic.ts fetchMappedTablePrice, §5.2 step 1
-- format `category|nama-lower-tanpa-tanda-baca|set-normalized|nomor`).
-- The daily job fills card_key from the file's product name + the mapped
-- group (group -> category + teg_set via tcg_set_map). Rows whose file
-- format carries no usable name/number are still upserted, but WITHOUT
-- card_key (NULL — the UNIQUE index below still allows several NULLs);
-- those rows stay `not_available` in the Edge Function until the mapping
-- exists, and the job logs an explicit warning about it. Never write an
-- invented card_key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tcgplayer_prices (
  product_id INT PRIMARY KEY,
  market     NUMERIC,
  low        NUMERIC,
  mid        NUMERIC,
  high       NUMERIC,
  updated    DATE
);

COMMENT ON TABLE public.tcgplayer_prices IS
  'TCGplayer prices (market/low/mid/high, USD) from the TCGCSV daily dump, for mapped groups only. Written by the daily GitHub Actions job. Service-role only — no anon access by design.';

-- Fase 1b integration fix — card_key lookup column for the Edge Function.
-- ALTER ... IF NOT EXISTS so re-running this file after a partial first
-- run is safe (see the cardmarket_prices note above).
ALTER TABLE public.tcgplayer_prices ADD COLUMN IF NOT EXISTS card_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tcgplayer_prices_card_key
  ON public.tcgplayer_prices (card_key);
COMMENT ON COLUMN public.tcgplayer_prices.card_key IS
  'Per-card lookup key for the market-prices Edge Function, format spec §5.2 step 1: category|name-lower-no-punctuation|set-normalized|number (e.g. pokemon|zeraora|ma6|137). Filled by the daily job from product name + mapped group; NULL when the file format carries no name/number to build it from. UNIQUE so .maybeSingle() can never see two rows.';

-- ---------------------------------------------------------------------------
-- fx_rates — daily FX rates (exchangerate-api.com, spec §5.3).
-- Refreshed by the daily GitHub Actions job. The Edge Function falls back
-- to 16.500 USD_IDR in code if the fetch fails (spec §5.3 / §11).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_rates (
  pair  TEXT PRIMARY KEY,  -- e.g. 'USD_IDR', 'EUR_IDR'
  rate  NUMERIC NOT NULL,
  as_of DATE NOT NULL
);

COMMENT ON TABLE public.fx_rates IS
  'Daily FX rates (e.g. USD_IDR, EUR_IDR) for converting upstream prices to IDR. Written by the daily GitHub Actions job. Service-role only — no anon access by design.';

-- ---------------------------------------------------------------------------
-- Row Level Security — enable on ALL tables above.
-- Deliberately NO policies are created here: with RLS enabled and zero
-- policies, the anon role (and any other non-service role) gets NO access
-- at all, while service_role bypasses RLS by design. That is the intended
-- state — do NOT add an anon SELECT/INSERT policy later without a
-- conscious security review.
-- ---------------------------------------------------------------------------
ALTER TABLE public.market_cache      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tcg_set_map       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cardmarket_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tcgplayer_prices  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rates          ENABLE ROW LEVEL SECURITY;

-- End of 001_market_tables.sql — next: 002_seed_tcg_set_map.sql
