---
name: focused-delegation
description: Split independent code investigations or reviews into small Fatcat child tasks when separate context will improve a local coding task.
---

# Focused Delegation

Delegate a bounded question that can be answered independently, such as locating one component's failure cause or reviewing one change against a specific requirement. Handle a direct edit, simple question, or single lookup yourself when delegation would only repeat work.

Call `delegate_task` with one `task` string containing the relevant workspace-relative paths, the user's applicable constraints, the necessary background, and a concrete expected answer. Children cannot see your conversation. Include the exact requirement under review rather than saying "check the above." Request findings with observed evidence and remaining uncertainty; avoid asking for a broad repository audit unless that is the user's task.

Plan for at most two started children per user turn, including failed attempts. Each child has at most three model requests, or fewer when the configured iteration limit is lower. The model requests needed to load Skills, inspect tool results, and answer share that budget. Give a child a narrow reading scope and enough context to reach a final answer. Children execute sequentially and cannot delegate further; they are not background workers.

The shared workspace is real shared state. Independent message history does not isolate file edits or command effects. For an investigation, state that the child should return findings without edits. When the user task calls for delegated implementation, give a clear file scope and integrate it before subsequent work on those files. Children use the same permissions and Skill catalog, but must load applicable Skill instructions in their own history.

Only the child's final answer returns to your conversation, not its internal tool transcript. Treat that answer as a lead; support consequential completion claims with tool evidence available to you. Shared write and command records can reveal actions even after a child fails. Inspect those facts before retrying or assuming nothing changed.
