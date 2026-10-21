# Fatcat documentation

English | [简体中文](../zh-CN/README.md)

Fatcat is a TypeScript Agent Harness for local coding tasks on native Windows, with configurable DeepSeek, Kimi, MiMo and Qwen providers. Use CLI chat, TUI or the local Web UI to inspect a workspace, make controlled edits and run checks. These interfaces share persistent sessions, tools and permission boundaries.

These documents describe the current source tree for users, contributors and agents. Fatcat is still an early demo; check each topic for supported workflows and verification limits.

## Quick start

[Windows quick start](QUICK_START.md): install, configure a model, receive a first reply, then choose CLI, TUI or Web UI. A local configuration check does not request a model and cannot verify connectivity.

## Guides

| Task | Read |
| --- | --- |
| Find code, edit files, run checks and assess results | [Coding tasks and execution evidence](GUIDES/CODING.md) |
| Resume sessions, switch directories, organize projects or compact context | [Sessions, projects and context](GUIDES/SESSIONS.md) |
| Upload materials, read documents or remember facts across conversations | [Attachments, documents and Memory](GUIDES/MATERIALS.md) |
| Discover, use or add task guidance | [Local Skills](GUIDES/SKILLS.md) |
| Schedule timed or file-change tasks | [Automation](GUIDES/AUTOMATION.md) |
| Use the terminal, browser interface or file previews | [CLI, chat, TUI and Web UI](GUIDES/INTERFACES.md) |

## Command and configuration reference

- [Commands](REFERENCE/COMMANDS.md): startup options, combination constraints, permission modes, interactive commands and exit codes.
- [Configuration](REFERENCE/CONFIGURATION.md): providers, environment variables, defaults, request budgets and local storage.

## Development and verification

| Topic | Read |
| --- | --- |
| Goals, principles and non-goals | [Project](PROJECT.md) |
| Collaboration, engineering and Git rules | [AGENTS.md](../../AGENTS.md) |
| Installation, builds, test ownership/layout, offline and specialized checks | [Development and verification](DEVELOPMENT.md) |
| Workspace ownership, runtime exports, dependencies and resource builds | [Package boundaries](DEVELOPMENT.md#workspace-package-boundaries) |
| Module responsibilities, state ownership, data flow and topic designs | [Architecture](ARCHITECTURE/README.md) |
| Experiment configuration, result format, statistics and evaluation implementation boundaries | [Eval protocol](ARCHITECTURE/EVAL.md) |

## Documentation responsibilities

| Location | Content |
| --- | --- |
| Root README | Project introduction, platform and reading entry points |
| `docs/README.md` | Bilingual documentation entry point |
| This page | Introduction and task navigation, without duplicating feature details |
| QUICK_START | Shortest path from installation to first run |
| GUIDES | Task-oriented operation, results and common limitations |
| REFERENCE | Commands, configuration, defaults and combination constraints |
| DEVELOPMENT | Development checks, environments and evidence requirements, not a cumulative pass log |
| PROJECT | Stable scope, principles and non-goals |
| ARCHITECTURE | Current modules/interfaces, state ownership, lasting decisions and related proposals explicitly marked as unimplemented |
| AGENTS | Collaboration and engineering rules, without duplicating the operating manual |

Maintain each fact in its owning topic and link to it elsewhere. Report actual execution results in task handoffs and keep material verification limits in public topics. `docs/PROGRESS.md` is an ignored local handoff log; its absence does not affect reading or development, and public pages do not depend on it for facts.

The current task determines development order. Use Git and PRs for historical proposals and delivery history rather than separate phase roadmaps or archives. The architecture overview owns the call chain and state ownership; individual topics own contracts, decisions, verification limits and unimplemented proposals. Historical test results do not validate a new change.

## Bilingual maintenance

`docs/en/` and `docs/zh-CN/` use matching paths and English filenames. Each page links to its counterpart at the top; ordinary documentation links stay in the current language. Keep commands, API names, paths and configuration keys unchanged, and translate explanatory prose naturally. Update both versions in the same change when behavior changes; both describe the same contract. Keep one English `AGENTS.md` at the repository root. Use stable English heading anchors in both versions. Check page parity, relative links and heading anchors after moves or translations.
