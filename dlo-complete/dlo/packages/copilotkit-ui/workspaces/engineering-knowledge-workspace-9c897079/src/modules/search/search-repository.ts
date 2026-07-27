// src/modules/search/search-repository.ts — data access for module m12. Executes the statement
// `query-builder.ts` built, through the `Db` port only (Architecture.md "core" §"Layering":
// "modules/*/repo depends on Db only"), and maps snake_case columns to `SearchRow`. Owns no
// query-shape or validation logic — that lives in `query-builder.ts`, where it is pure and unit
// tested without a database.
import type { Db } from "../../server/ports";
import { buildSearchQuery, type SearchQueryInput } from "./query-builder";

export interface SearchRow {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly rank: number;
}

interface RawSearchRow {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly body_markdown: string;
  readonly rank: number;
}

export interface SearchRepository {
  /** Runs the built statement for `input` and returns every scoped, ordered match. */
  search(input: SearchQueryInput): Promise<readonly SearchRow[]>;
}

export function createSearchRepository(db: Db): SearchRepository {
  return {
    async search(input) {
      const built = buildSearchQuery(input);
      const { rows } = await db.query<RawSearchRow>(built.sql, built.params);
      return rows.map((row) => ({
        id: row.id,
        path: row.path,
        title: row.title,
        bodyMarkdown: row.body_markdown,
        rank: row.rank,
      }));
    },
  };
}
