# Use local Skills

[Documentation](../README.md)

Skills supply task guidance through local `SKILL.md` files. They do not execute automatically or grant file, shell or network permissions.

## Discover and use a Skill

In chat or TUI, run `/skills` to list discovered metadata without a model request or history change. Starting those interfaces still requires provider configuration. Ask for a relevant workflow by name; the agent can read its full instructions when needed.

```powershell
pnpm start --prompt 'Use $workspace-editing to inspect this workspace and make a focused change.'
```

Use PowerShell single quotes to preserve a literal `$skill-name`. Mentioning a Skill guides model selection; it is not a deterministic command router. Loaded instructions may become part of model requests and saved history.

## Add a workspace Skill

Create `.fatcat/skills/<name>/SKILL.md` in the selected workspace, for example:

```markdown
---
name: review-notes
description: Review Markdown notes for broken internal references and unclear instructions.
---
Read the relevant notes, check their local links, and report concrete corrections.
```

The directory and declared name must match. Names use 1–64 lowercase letters, digits and single hyphens, with no leading/trailing hyphen. Descriptions are limited to 1024 characters and a Skill file to 32 KiB. Discovery reads metadata first; the body is loaded through the controlled read tool. Restart after editing catalog metadata to ensure it is rediscovered.

Discovery order is workspace `.fatcat/skills`, workspace `.agents/skills`, the corresponding user-home roots, then the built-in catalog. The first valid same-name Skill wins. Parent directories are not searched; nothing is downloaded automatically. Invalid entries produce diagnostics. Each discovery root is limited to 128 entries; the catalog holds at most 64 Skills.

## Built-in guidance

| Skill | Task |
| --- | --- |
| `workspace-editing` | Inspect and change workspace files |
| `focused-delegation` | Define bounded independent subtasks |
| `context-recovery` | Recover relevant facts after omitted reads or summaries |
| `verification-handoff` | Check changes and report evidence |
| `web-research` | Research and cite public sources |
| `weather-lookup` | Resolve weather location/date and report sources |
| `local-browser-check` | Inspect workspace pages with controlled browser evidence |

Built-ins ship from `packages/runtime/src/skill/<subsystem>/<skill-name>/SKILL.md`. Catalog parsing, diagnostics and source boundaries are maintained in [Skills architecture](../ARCHITECTURE/SKILLS.md); permission enforcement belongs to the runtime, not the instructions.
