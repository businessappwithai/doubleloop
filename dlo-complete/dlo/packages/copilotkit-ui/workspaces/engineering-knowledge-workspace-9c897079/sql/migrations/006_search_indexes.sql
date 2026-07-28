<<<<<<< HEAD
-- sql/migrations/006_search_indexes.sql
-- Transcribed verbatim from Database.md's "## DDL" block, section "006_search_indexes.sql".
-- The search indexes themselves are declared alongside their tables in 004/005 (they are on
-- GENERATED columns and cannot be added independently of the column). This migration holds
-- search *tuning* that is separable from shape: wider column statistics for the planner, and a
-- smaller GIN pending-list so interactive search stays current between autovacuum runs.
=======
-- sql/migrations/006_search_indexes.sql — module m6. The search indexes themselves are declared
-- alongside their tables in 003/004 (they are GENERATED columns and cannot be added independently
-- of the column). This migration holds search *tuning* that is separable from shape. Transcribed
-- verbatim from Database.md's "## DDL" block.
>>>>>>> origin/claude/engineering-knowledge-workspace-uknsck

ALTER TABLE concept_documents ALTER COLUMN content_blocks SET STATISTICS 1000;
ALTER TABLE concepts          ALTER COLUMN path           SET STATISTICS 1000;

-- GIN pending-list: the default 4 MB makes bulk imports fast but leaves recent
-- rows unindexed until autovacuum. 512 kB keeps interactive search current.
ALTER INDEX concept_documents_blocks_gin   SET (gin_pending_list_limit = 512);
ALTER INDEX concept_documents_body_tsv_gin SET (gin_pending_list_limit = 512);
