---
name: context-recovery
description: Recover the current evidence needed for a follow-up coding task when earlier reads are omitted, files may have changed, or a Session was reset.
---

# Context Recovery

Reconstruct only the evidence needed for the current decision. A `context_omitted` read result means that an earlier successful result was removed from this model request to fit the byte budget. It is not empty file content, a current directory listing, or proof that a search found nothing.

Use the retained tool arguments and the marker's path to issue another `read`. Prefer the relevant file range or a literal search in a narrow subtree over reproducing every earlier page. The new read returns current data: external edits may have changed contents, line numbers, and pagination. Compare those observations with the user's present requirement before editing. Earlier assistant explanations and write hashes do not replace a current read.

Fatcat keeps complete successful Session history internally, but there is no tool for retrieving a hidden historical snapshot. Request reduction may omit older file, directory, and search results; it preserves the current and most recent completed turns. Loaded `SKILL.md` instructions remain, while ordinary Skill resource pages may be omitted and need rereading.

A failed or cancelled turn does not enter successful conversation history. Files and recorded command effects can nevertheless remain. `/reset` clears conversation and loaded Skill history without reverting files or clearing write and command facts. After reset, load an applicable Skill again and inspect current state; do not claim to remember missing user requirements.

Keep recovered evidence targeted and answers concise. `MODEL_CONTEXT_LIMIT` can still stop a request when protected content exceeds the budget. Reset is not a guaranteed remedy because execution facts remain; there is no automatic summary, larger budget, or persistent recovery mechanism to invoke.
