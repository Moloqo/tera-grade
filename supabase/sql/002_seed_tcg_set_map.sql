-- ============================================================================
-- TEG v27.7 Fase 1 + 1b — Seed for tcg_set_map
-- File: 002_seed_tcg_set_map.sql
-- Run SECOND (after 001_market_tables.sql), via Supabase SQL Editor.
-- Source spec: ../design-market-data.md §5.3 (tcg_set_map), §5.2 (example).
--
-- HONESTY RULE (binding):
--   * Only `teg_set` + `category` are filled in here. Every provider-ID
--     column is left NULL on purpose.
--   * The spec gives NO concrete provider IDs, and no provider ID was
--     verified during this task — so NOTHING is guessed.
--     -- TODO: map manually — DO NOT guess provider IDs
--   * To fill a row in later: look the set up in the provider's own
--     catalogue (TCGdex set list, Scryfall set list, YGOPRODeck set list,
--     Cardmarket expansion list, TCGplayer/TCGCSV group list), copy the
--     ID exactly, and UPDATE that one column.
--
-- PROVENANCE of the two seed rows (what was actually verified):
--   * 'MA6 (Indonesian)' — the set string used in the spec §5.2 request
--     example (Zeraora, Pokémon, ©2026) and the set code `ma6` present in
--     the staged v27.6 file (year-code table: ma6 -> 2026). History
--     entries named in the task context: Zeraora / Gengar ex / Espeon ex.
--   * 'Paradox Rift' — named in the task context as the set of the
--     Galarian Meowth history entry. In the staged v27.6 file it appears
--     ONLY as a year-detection phrase ("paradox rift" -> 2023), not as a
--     readable history row, because live history loads from Supabase, not
--     from the staged file. Kept on the task's authority; re-check it
--     against live history before mapping its provider IDs.
--   * No other set strings could be verified from the staged file
--     (history rows are not embedded in it), so no other rows are seeded.
--     Add further sets manually after checking live history.
-- ============================================================================

INSERT INTO public.tcg_set_map
  (category, teg_set, tcgdex_set_id, scryfall_set_code, ygoprodeck_set_name,
   cardmarket_expansion_id, tcgplayer_group_id, tcgcsv_group_id)
VALUES
  -- Pokémon, Indonesian set (Zeraora / Gengar ex / Espeon ex, ©2026).
  -- TODO: map manually — DO NOT guess provider IDs
  ('pokemon', 'MA6 (Indonesian)',
   NULL, NULL, NULL, NULL, NULL, NULL),
  -- Pokémon, set of the Galarian Meowth history entry (2023).
  -- TODO: map manually — DO NOT guess provider IDs
  ('pokemon', 'Paradox Rift',
   NULL, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (category, teg_set) DO NOTHING;

-- End of 002_seed_tcg_set_map.sql — 2 seed rows.
