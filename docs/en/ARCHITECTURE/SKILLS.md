# Skills: discovery, guidance and on-demand reads

English | [简体中文](../../zh-CN/ARCHITECTURE/SKILLS.md)

[Architecture](README.md) · [Use and author Skills](../GUIDES/SKILLS.md)

Skills are local task guidance, not a permission system, plugin runtime or deterministic workflow. Models first see metadata and read bodies as needed. The operating guide maintains the built-in list.

## Modules and builds

`packages/runtime/src/skills.ts` owns discoverSkills, metadata validation, catalog guidance and the controlled read wrapper. Built-ins live in `packages/runtime/src/skill/<subsystem>/<name>/SKILL.md`; `packages/runtime/scripts/copy-skills.mjs` validates and copies build resources. Runtime lookup is module-relative, independent of cwd.

workspaceAgentFactory in `packages/runtime/src/agent.ts` rediscovers on directory selection. Even when reusing base Tools it refreshes the Skill catalog and reassembles Agent; see [Assembly](AGENT_LOOP.md). Ordinary execution has no file watcher. Restart after metadata edits; built-in edits also require rebuilding. There is no separate activation cache. Repeated reads use current files and consume context budget.

## Discovery and naming

Priority is workspace .fatcat/skills, .agents/skills, then corresponding user-home roots, then built-ins. The first valid same-name entry wins; ancestors are not scanned. Programmatic calls without a workspace do not choose cwd automatically.

Workspace/user roots scan one level, built-ins scan subsystem/name two levels. Each scanned directory allows 128 raw entries; the full catalog allows 64 Skills. Ordering is stable; invalid entries produce safe diagnostics without YAML source or raw exceptions.

SKILL.md requires valid UTF-8, at most 32 KiB and YAML frontmatter. name must match the directory and contain 1–64 lowercase ASCII letters/digits/single hyphens; description is nonblank and at most 1024 characters. Duplicate keys, aliases and custom tags are rejected. Fields such as allowed-tools grant no behavior. The yaml parser reliably handles quoting, multiline text and structure; this does not claim support for every extension in other clients.

## General read protocol

All sources use skill://name/SKILL.md; subsystem is organizational and absent from the URI. Body results include kind=skill, name, path, baseDirectory and complete content. offset/limit/query are forbidden so truncated instructions cannot masquerade as a full load.

Resources use skill://name/relative-path, resolve under the Skill root and reuse ordinary file/directory/search paging and limits. URIs reject upward traversal, percent encoding, backslashes, hidden segments and unknown Skills. Root/ancestor links or junctions and SKILL.md hard links are rejected and rechecked on read. Skills do not open arbitrary hidden directories to ordinary workspace reads.

Metadata only guides selection. Bodies/resources are task materials and cannot expand workspace, shell, network, delegation or budgets. Children share metadata but not loaded parent bodies; they must read their own.

## Context and verification

Complete bodies enter successful history as ordinary tool results. Older-read omission excludes kind=skill but may omit referenced resources. Explicit/automatic compaction may summarize their older turns lossily while preserving originals; reread when needed. Catalog and body both count toward request budgets. Retained instructions may still cause overflow and cannot justify raising limits.

Check priority, invalid YAML, path/identity/byte limits, assembly without workspace, resource URIs, parent/child isolation, build copying, startup from other directories and Context behavior. Injected models cannot prove that real models always select/follow Skills or improve task quality.

Remote registries, automatic downloads/installation, hot refresh, automatic Skill execution and permission expansion are absent. Add built-in guidance only for implemented subsystems, without future placeholders.
