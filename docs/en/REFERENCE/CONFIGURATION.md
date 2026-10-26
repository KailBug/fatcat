# Configuration reference

English | [简体中文](../../zh-CN/REFERENCE/CONFIGURATION.md)

[Documentation](../README.md) · [Quick start](../QUICK_START.md) · [Commands](COMMANDS.md)

Configuration is read at startup. `pnpm start` loads `.env` from the repository root before its launcher restores the invocation directory. Existing environment variables take precedence over the env file. Direct `node packages/cli/dist/cli.js` does not implicitly load it; use Node's `--env-file-if-exists=.env` option when needed, resolving that path from your current directory.

Keep credentials only in local environment variables or the ignored `.env`. Do not copy real keys into prompts, documentation or logs. `pnpm start --checkConfig` validates local values without testing the account or contacting the provider. Restart to reload credentials or endpoint configuration. Web UI can switch a session between already configured model connections; see [model controls](../ARCHITECTURE/WEBUI.md#model-thinking-and-context-controls).

## Providers

`HARNESS_PROVIDER` selects `deepseek` (default), `kimi`, `mimo`, `qwen` or `glm`.

| Provider | Required key | Model variable and default | Region |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL=deepseek-flash` | No region option |
| Kimi | `MOONSHOT_API_KEY` | `KIMI_MODEL=kimi-k2.6` | `KIMI_REGION=cn` (default) or `global` |
| MiMo | `MIMO_API_KEY` | `MIMO_MODEL=mimo-v2.6-flash` | Pay-as-you-go API, not Token Plan |
| GLM | `GLM_API_KEY` | `GLM_MODEL=glm-5.3` | Domestic BigModel standard API; fixed `cn`, no region option |
| Qwen | `DASHSCOPE_API_KEY` | `QWEN_MODEL=qwen-plus` | `QWEN_REGION=cn` (default), `intl`, `us`, `eu`, `jp`, `hk` |

`HARNESS_PROVIDER` selects the startup default, whose configuration is validated by `--checkConfig`. The host also reads the other providers' environment settings into `ModelConnections`; invalid or unconfigured connections are unavailable for switching. There is no fallback to another provider's key or `OPENAI_API_KEY`. Region-specific keys must match their region. Optional values use defaults when absent; explicitly empty selected values are invalid. Fields are trimmed before validation.

Qwen optionally accepts `QWEN_WORKSPACE_ID`, a lowercase DNS label (1–63 letters, digits or hyphens, starting and ending with a letter/digit). When present, it selects the workspace-specific PAYG endpoint. `cn` maps to Beijing, `intl` to Singapore, `us` to Virginia, `eu` to Frankfurt, `jp` to Tokyo and `hk` to Hong Kong. Without a workspace ID, only `cn` and `intl` can use their existing DashScope endpoints. Credentials must belong to the selected workspace and region; the application never probes or falls back to another endpoint. Workspace identity is public configuration, not a credential. Leave the variable absent to keep an existing configuration; an explicitly empty value is invalid.

Current Qwen alternatives include `qwen3.8-max`, `qwen3.8-flash` and `qwen3.7-plus`. Existing startup defaults remain unchanged. Kimi K3 and K2.7 Code support main-agent execution with session reasoning-history replay. Stateless document requests use the model's mandatory thinking protocol. The catalog is not a guarantee of account access, region-specific model availability or online verification.

The shared OpenAI-compatible client uses non-streaming Chat Completions. New sessions use the catalog thinking default: medium when supported, on for off/on models, otherwise the explicit model default or off. Explicit Config.thinking and saved session choices take precedence. Exact endpoints, request fields, model versions, image capabilities, retirement notices and subscription-only entry points live in [provider architecture](../ARCHITECTURE/PROVIDERS.md). Protocol checks use fake credentials and injected transport; they do not establish real account access or task quality. Existing live verification scripts remain DeepSeek-specific.

For GLM, configure the domestic standard API key, not a Coding Plan or Z.ai key:

```dotenv
HARNESS_PROVIDER=glm
GLM_API_KEY=your-local-key
GLM_MODEL=glm-5.3
```

GLM uses the fixed `https://open.bigmodel.cn/api/paas/v4` endpoint. `glm-5.3` supports low/high/max thinking (default max, cannot disable); `glm-5.2` supports off/high/max (default max); `glm-5.1`, `glm-5` and `glm-4.7` support off/on (default on). These catalog entries cover text and tools, not image input. Unknown custom names retain off-only compatibility without inferred capabilities. The model catalog is shared by all clients; configure `GLM_MODEL` for startup or select a configured connection in Web UI. Run `pnpm start --checkConfig` for local validation. This does not send a model request.

## Request budgets

| Variable | Runtime default when unset | Accepted values / purpose |
| --- | --- | --- |
| `HARNESS_MAX_ITERATIONS` | `32` | Positive decimal safe integer; parent request allowance per turn |
| `HARNESS_REQUEST_TIMEOUT_MS` | `60000` | Positive integer up to 2147483647; request timeout in milliseconds |
| `HARNESS_MAX_REQUEST_BYTES` | `262144` | Positive integer up to 16777216; serialized model request-body bytes |
| `HARNESS_AUTO_COMPACT` | `true` | `true` or `false`; one bounded automatic history-compaction recovery after local request overflow |

The repository's [.env.example](../../../.env.example) explicitly sets `HARNESS_MAX_ITERATIONS=128`. Copying it selects 128; it does not change the runtime's absent-value default. Invalid, empty or out-of-range values fail configuration validation.

Request bytes are not provider tokens. System guidance, tools, history, journals and visual payloads contribute to the serialized request. Older successful read payloads can be omitted with explicit markers while full saved history remains intact. [Context management](../GUIDES/SESSIONS.md#context-management) describes further compaction and the remaining failure cases. Delegated work has its own bounded requests; total provider calls can exceed the parent's iteration allowance.

## Automation JSON

`--automation <path>` loads a UTF-8 JSON file inside the selected workspace, even in Free to go. The config file uses the ordinary 1 MiB text-file limit; watched paths resolve from the workspace, not the config's directory. Unknown fields are rejected at every level. Validate configuration and watched paths with `--check-automation`; it does not contact the model. A runnable example and process lifecycle are in the [automation guide](../GUIDES/AUTOMATION.md#standalone-json-runner).

| Top-level field | Required / default | Contract |
| --- | --- | --- |
| `version` | Required | Exactly `1` |
| `maxRuns` | `20` | Integer 1–1000; total activation attempts across all tasks |
| `maxRuntimeSeconds` | `86400` | Integer 1–604800; whole-run lifetime, including active work |
| `tasks` | Required | 1–32 task objects |

| Task field | Required / default | Contract |
| --- | --- | --- |
| `id` | Required | Unique, 1–64 characters; starts with an ASCII letter/digit, followed by letters, digits, `_` or `-` |
| `prompt` | Required | Nonblank, at most 16000 UTF-16 code units |
| `trigger` | Required | One of the objects below |
| `maxRuns` | `20` | Integer 1–1000; per-task attempts, also subject to the total limit |

Every trigger requires `type`; only the fields for that type are accepted:

| `type` | Fields |
| --- | --- |
| `interval` | Required `seconds`: integer 60–604800; first activation follows one interval |
| `at` | Required `time`: real ISO date/time with seconds and `Z` or numeric offset; optional milliseconds use exactly three digits |
| `cron` | Required `expression`: at most 256 characters, five numeric minute/hour/day/month/weekday fields; optional `timezone`: `local` (default) or `UTC` |
| `file_changed` | Required `paths`: 1–32 unique, explicit workspace-relative text paths, each at most 512 characters; optional `debounceMs`: integer 1000–60000, default 1000 |

Cron permits `*`, lists, ranges and steps; Sunday is 0 or 7, and restricted day-of-month/day-of-week fields match with OR. Names, seconds fields and named IANA timezones are unsupported. At most 64 distinct files may be watched across the configuration; see [file-change restrictions](../GUIDES/AUTOMATION.md#file-change-triggers).

Standalone one-shot times already past at startup are skipped; a time beyond the runner's lifetime will never fire. Failed activations consume both attempt limits. Restarting resets standalone counters. Session-bound tasks reuse the trigger schema but have generated IDs and their own persisted attempts/expiry; their one-shot time must be in the future and before expiry. They are created through conversation or UI, not by editing this JSON.

## Local storage and interface settings

| Variable | Purpose |
| --- | --- |
| `FATCAT_SESSION_DIR` | Override the default user-home `.fatcat/sessions` store root, including project/material/Memory state |
| `FATCAT_WEBUI_OPEN_BROWSER=0` | Disable automatic opening of the Web UI startup link |
| `FATCAT_VERIFY_SCREENSHOTS` | Retain `verify:webui` and `verify:webui-models` screenshots in a selected directory |
| `NO_COLOR` | Disable TUI color; does not alter model behavior |

`INIT_CWD` is used by the pnpm start launcher to recover the invocation directory after the package-root build and env-file load. Direct CLI execution ignores it. For directory changes and plaintext retention limits, see [sessions](../GUIDES/SESSIONS.md#storage-and-recovery). For verification-only settings, see [development](../DEVELOPMENT.md).
