// src/routes/index.tsx — landing view at "/". Replaced by the workspace shell + sidebar
// tree once m21 (workspace routes) lands; until then this is the real, shippable homepage
// for the product, not a placeholder.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const PILLARS: ReadonlyArray<{ title: string; description: string }> = [
  {
    title: "Knowledge Bundles",
    description:
      "Hierarchical Concepts — Markdown bodies with YAML frontmatter — organised into Google Cloud's Open Knowledge Format, editable side by side with your codebase.",
  },
  {
    title: "Block editing, real collaboration",
    description:
      "A Lexical block editor synchronised by Yjs CRDTs, so two engineers can edit the same runbook at the same time without a lock or a merge conflict.",
  },
  {
    title: "Git-synced, source of truth in Postgres",
    description:
      "Every edit is queryable through a Relay-conventions GraphQL API over PostgreSQL, and exported back to plain .md files by the Git-synchronisation worker.",
  },
];

function HomePage() {
  return (
    <main className="home">
      <section className="home-hero">
        <p className="home-eyebrow">Engineering Knowledge Workspace</p>
        <h1 className="home-title">Documentation that keeps up with the code it describes</h1>
        <p className="home-lede">
          A collaborative, block-based knowledge workspace built for engineering teams —
          structured like OKF Knowledge Bundles, edited like a modern block editor, and synced
          back to Git as Markdown.
        </p>
      </section>
      <section className="home-pillars" aria-label="Product pillars">
        {PILLARS.map((pillar) => (
          <article className="home-pillar" key={pillar.title}>
            <h2 className="home-pillar-title">{pillar.title}</h2>
            <p className="home-pillar-description">{pillar.description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
