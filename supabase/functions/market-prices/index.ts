// =============================================================================
// market-prices — Supabase Edge Function (Deno) for TEG v27.7.
//
// Thin wrapper only: CORS + method/JSON validation + secret injection.
// All rules live in ./logic.ts (pure, unit-tested from Node — see
// test-market-prices.mjs). This file is never imported by the tests.
//
// Client call pattern (mirrors detect-card in the v27.6 staged client):
//   POST {SUPABASE_URL}/functions/v1/market-prices
//   headers: Content-Type application/json, apikey: <anon/publishable key>,
//            Authorization: Bearer <same key>
//   body: { name, set, number, category, rarity, language, forceRefresh }
//
// Deploy (by parent — never from this file):
//   supabase functions deploy market-prices
//   supabase secrets set EBAY_APP_ID=... EBAY_CERT_ID=...
// Secrets are NAMES only here. No secret value is ever written in this repo.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  createEbayTokenProvider,
  handleMarketPrices,
  type EbayTokenProvider,
  type SupabaseLike,
} from "./logic.ts";

// CORS — §5.6: only the TEG origin + localhost for testing. Anything else
// gets no Access-Control-Allow-Origin header (the request is still answered,
// the browser just will not expose it cross-origin).
const TEG_ORIGIN = "https://moloqo.github.io";

function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (origin === TEG_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

// eBay app token (~2 h) is cached in memory at module scope — §5.4 — so a
// warm function instance reuses it instead of minting a token per request.
// The provider is created lazily once; env vars do not change at runtime.
let ebayTokenProvider: EbayTokenProvider | null = null;
function getEbayTokenProvider(): EbayTokenProvider {
  if (!ebayTokenProvider) {
    ebayTokenProvider = createEbayTokenProvider(
      fetch,
      Deno.env.get("EBAY_APP_ID") ?? "",
      Deno.env.get("EBAY_CERT_ID") ?? "",
    );
  }
  return ebayTokenProvider;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (req.method !== "POST") {
    return jsonResponse({ status: "error", reason: "Method not allowed." }, 405, origin);
  }

  let input: unknown;
  try {
    input = await req.json();
  } catch {
    return jsonResponse({ status: "error", reason: "Invalid JSON body." }, 400, origin);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return jsonResponse({ status: "error", reason: "Body must be a JSON object." }, 400, origin);
  }

  // Service-role client for market_cache / tcg_set_map / fx_rates / the
  // Fase 1b price tables (RLS: no anon access — §5.3). SUPABASE_URL and
  // SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase — never set
  // them manually. If they are missing, the function still answers from
  // upstream sources, just without cache/table lookups.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  let supabase: SupabaseLike | null = null;
  if (supabaseUrl && serviceRoleKey) {
    try {
      const client = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      });
      supabase = client as unknown as SupabaseLike;
    } catch (e) {
      console.error("market-prices: failed to create service-role client", e);
      supabase = null;
    }
  }

  try {
    const result = await handleMarketPrices(
      {
        supabase,
        ebayTokenProvider: getEbayTokenProvider(),
      },
      input as Record<string, unknown>,
    );
    return jsonResponse(result.body, result.status, origin);
  } catch (e) {
    // Last-resort guard: the orchestrator is designed never to throw, but a
    // response must still be an honest 200-unavailable, never a 500 and
    // never an internal error detail.
    console.error("market-prices: unexpected failure", e);
    return jsonResponse(
      {
        status: "unavailable",
        reason: "Market data could not be loaded for this card.",
        sales: {
          status: "not_available",
          note: "No recent completed sales from current sources.",
        },
      },
      200,
      origin,
    );
  }
});
