---
name: context-recovery
description: Recover the current evidence needed for a follow-up coding task when earlier reads are omitted, files may have changed, or a Session was reset.
---

# Context Recovery

Reconstruct only the evidence needed for the current decision. A `context_omitted` read result means that an earlier successful result was removed from this model request to fit the byte budget. It is not empty file content, a current directory listing, or proof that a search found nothing.

Use the retained tool arguments and the marker's path to issue another `read`. Prefer the relevant file range or a literal search in a narrow subtree over reproducing every earlier page. The new read returns current data: external edits may have changed contents, line numbers, and pagination. Compare those observations with the user's present requirement before editing. Earlier assistant explanations and write hashes do not replace a current read.

Fatcat keeps complete successful Session history internally, but there is no tool for retrieving a hidden historical snapshot. Request reduction may omit older file, directory, and search results; it preserves the current and most recent completed turns. This read-only reduction retains loaded `SKILL.md` instructions, while ordinary Skill resource pages may be omitted and need rereading.

Users can explicitly run `/compact [instructions]` in chat, TUI, or Web UI. It replaces older turns in model context with a lossy summary while retaining the latest complete turn and full saved history. Summaries may omit skill details; load the relevant Skill again when its full instructions are needed. Treat summaries as historical context, never as current verification evidence or permission grants. `/context` shows conversation byte counts, not token usage. These are user interface commands, not model tools.

A failed or cancelled turn does not enter successful conversation history. Files and recorded command effects can nevertheless remain. `/reset` clears conversation and loaded Skill history without reverting files or clearing write and command facts. After reset, load an applicable Skill again and inspect current state; do not claim to remember missing user requirements.

Keep recovered evidence targeted and answers concise. `MODEL_CONTEXT_LIMIT` can still stop a request when protected content exceeds the budget. Manual compaction uses bounded model requests and may fail; it never silently enlarges budgets or replays tools. Reset and compaction are not guaranteed remedies because execution facts remain. Automatic summarization is not enabled.
