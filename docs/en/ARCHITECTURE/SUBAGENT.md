# Subagent: bounded delegation and isolated history

English | [简体中文](../../zh-CN/ARCHITECTURE/SUBAGENT.md)

[Architecture](README.md)

Delegation serves small, self-contained tasks. Models can select it by default without requiring users to enable an internal capability. It reuses the same process, Loop and tool boundaries; it is not a thread pool or multi-agent scheduling framework.

## Assembly and protocol

`packages/runtime/src/subagent.ts` adds delegate_task to parent Tools; `packages/runtime/src/agent.ts` assembles parent/child Models and task-selection guidance. Child tools exclude delegate_task to prevent recursion.

Input task is a nonblank description of at most 4000 characters. Each child starts with empty history and only its task plus current system/workspace/permission/Skill metadata. It does not copy parent messages or loaded Skill bodies. Children reread needed materials. Final answer is limited to 12000 characters; overflow fails. Internal child conversations do not merge into successful parent history.

Defaults allow two children per parent turn, each with at most 32 model requests, independent of the parent configured request limit. Execution is sequential, without parallelism or automatic retries. Failed delegation consumes its allowance; failures report the cause code, request count and successful tool-return count without claiming task completion. Existing effects remain. The programmatic constructor may explicitly lower the child limit to 1–32 for bounded verification; ordinary agent assembly uses 32. All children share parent cancellation and base tool journals and cannot expand file, network, material or command permissions.

## Execution identity and budgets

The actual Session/Project/ownership generation captured by the parent turn binds children; identity is not inferred from UI selection. Workspace caches carry no material authorization. Attachment and Memory reads validate through execution-bound accessors.

Parents and children share provider configuration and full request-byte rules, but child allowances are independent. Child vision/transcription requests consume their own allowance while reserving final text delivery. Children cannot write Memory or manage parent automation. Fresh child history has no older completed turns to omit; it cannot evade overflow by discarding current results.

Parent requests see remaining delegation allowance and selection guidance. Only parent tools expose delegation. Skill content cannot add tools or budget. Unconditionally decomposing tasks consumes extra calls and is not a performance promise.

## Events and material evidence

Child events use subagent_event with identity and parent/child relationships. Shared write/command/browser records may appear at both levels; consumers deduplicate by ID. Child completed/stopped does not end the parent turn. Observed failed-request usage remains; missing usage is not zero-filled.

Successful delegation may return attachmentReads produced by actual reads: at most 8 records, 8 KiB total source metadata, up to 4 source links each, with omitted counts. It copies no body and derives no evidence from claims in child answers. Parent history can retain these fixed sources. Failed children do not restore full child history or source panels; see [Documents](DOCUMENTS.md).

## Verification and unimplemented scope

Check isolated context, separate parent/child definitions, count/output limits, recursion rejection, inherited permissions, actual identity, shared journals, cancellation and visual allowances. Historical fixed DeepSeek delegation checks verified independent file reviews and no-side-effect boundaries; filename/call assertions cannot establish every semantic conclusion.

Parallel/recursive delegation, persistent child sessions, message buses, shared working memory, automatic task decomposition and cost-benefit evaluation are unimplemented. Define real tasks and acceptance before adding such capabilities rather than expanding into a general framework.
