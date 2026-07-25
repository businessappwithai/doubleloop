# Skills & routing for this directory

> **Codebase guidance lives in [`../CLAUDE.md`](../CLAUDE.md)** — repository
> structure, the pipeline phases/gates, package map, dev commands, the
> **mandatory unit-testing policy**, coding conventions, and known gaps.
> Read that first when writing code. This file only covers skill routing.
>
> Testing rule in one line: every code change ships with detailed vitest unit
> tests covering the happy path, every new branch, and the failure modes — and
> pipeline-generated applications must come out tested too. See
> [`../CLAUDE.md` §5](../CLAUDE.md).

## gstack
- **gstack** (`~/.claude/skills/gstack/SKILL.md`) - AI-powered browser and development tools
  - Use the `/browse` skill from gstack for all web browsing, never use `mcp__claude-in-chrome__*` tools
  - Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review, /design-consultation, /design-shotgun, /design-html, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /setup-gbrain, /retro, /investigate, /document-release, /document-generate, /codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful, /freeze, /guard, /unfreeze, /gstack-upgrade, /learn

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
