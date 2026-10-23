"""Harbor 0.23.0 glue; the actual Agent runs in the TypeScript runtime.

Injected and explicitly authorized live execution share the installed runtime.
"""

import hashlib
import json
import os
import re
import shlex
import tempfile
from importlib.metadata import version
from pathlib import Path, PurePosixPath

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class FatcatAgent(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        bundle_path: str,
        bundle_sha256: str,
        mode: str = "injected",
        transport_path: str | None = None,
        requests: int = 8,
        duration_ms: int = 30000,
        prior_cost_nano_cny: int = 0,
        **kwargs,
    ):
        if version("harbor") != "0.23.0":
            raise ValueError("This adapter requires Harbor 0.23.0.")
        if mode not in ("injected", "live"):
            raise ValueError("mode must be injected or live.")
        expected_model = "deepseek/deepseek-flash" if mode == "live" else None
        if kwargs.get("model_name") != expected_model or kwargs.get("extra_env"):
            raise ValueError("Use the mode's exact model; agent environment overrides are unavailable.")
        if kwargs.get("prompt_template_path") or kwargs.get("skills_dir") or kwargs.get("mcp_servers"):
            raise ValueError("Verification uses the original instruction without extra capabilities.")
        if type(requests) is not int or not 1 <= requests <= 32:
            raise ValueError("requests must be an integer from 1 to 32.")
        maximum_duration = 1800000 if mode == "live" else 120000
        if type(duration_ms) is not int or not 100 <= duration_ms <= maximum_duration:
            raise ValueError(f"duration_ms must be an integer from 100 to {maximum_duration}.")
        if type(prior_cost_nano_cny) is not int or not 0 <= prior_cost_nano_cny <= 10_000_000_000:
            raise ValueError("prior_cost_nano_cny must be an integer within the CNY 10 total allowance.")
        if mode == "injected" and prior_cost_nano_cny:
            raise ValueError("Injected runs do not have real billing.")
        if not re.fullmatch(r"[0-9a-f]{64}", bundle_sha256):
            raise ValueError("bundle_sha256 must be a lowercase SHA-256 digest.")
        if mode == "live" and transport_path is not None:
            raise ValueError("Live execution does not accept an injected transport.")
        transport_path = transport_path or "packages/eval/dist/tests/fixtures/harbor-smoke.js"
        transport = PurePosixPath(transport_path)
        if transport.is_absolute() or ".." in transport.parts or "\\" in transport_path or transport.suffix != ".js":
            raise ValueError("transport_path must identify a trusted relative JavaScript module in the bundle.")
        self.bundle = Path(bundle_path).resolve(strict=True)
        self.bundle_sha256 = bundle_sha256
        self.transport = transport
        self.mode = mode
        self.requests = requests
        self.duration_ms = duration_ms
        self.prior_cost_nano_cny = prior_cost_nano_cny
        super().__init__(*args, **kwargs)
        self._version = f"{mode}-{bundle_sha256[:12]}"

    @staticmethod
    def name() -> str:
        return "fatcat"

    async def install(self, environment: BaseEnvironment) -> None:
        # Check the exact caller-provided bundle again just before uploading it.
        with self.bundle.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != self.bundle_sha256:
            raise ValueError("Fatcat bundle hash mismatch.")
        await environment.upload_file(self.bundle, "/installed-agent/fatcat.tar.gz")
        await self.exec_as_root(
            environment,
            command=(
                f"printf '%s  %s\\n' {shlex.quote(digest)} /installed-agent/fatcat.tar.gz | sha256sum -c - && "
                "mkdir /installed-agent/fatcat && "
                "tar -xzf /installed-agent/fatcat.tar.gz -C /installed-agent/fatcat && "
                "chmod -R a+rX /installed-agent/fatcat && "
                "test -x /installed-agent/fatcat/node && "
                "test -f /installed-agent/fatcat/fatcat/packages/eval/dist/scripts/headless.js"
            ),
            timeout_sec=120,
        )

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        context.metadata = {"evidence": self.mode, "bundleSha256": self.bundle_sha256}
        if self.mode == "injected":
            context.metadata.update({"transport": str(self.transport), "networkModelRequests": 0})
        logs = self.environment_logs_dir
        options = {
            "taskCwd": "/app", "instruction": instruction,
            "resultDirectory": str(logs / "fatcat"),
            "permission": {"files": "workspace-write", "shell": "allow"},
            "requests": self.requests, "durationMs": self.duration_ms,
        }
        # JSON upload preserves quotes/newlines without placing the task in a shell command.
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(str(logs))}")
        with tempfile.TemporaryDirectory(prefix="fatcat-harbor-") as directory:
            source = Path(directory) / "input.json"
            source.write_text(json.dumps(options, ensure_ascii=False) + "\n", encoding="utf-8")
            await environment.upload_file(source, str(logs / "input.json"))
        root = PurePosixPath("/installed-agent/fatcat")
        credential_path = "/installed-agent/fatcat-api-key"
        if self.mode == "live":
            key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
            if not key:
                raise ValueError("DEEPSEEK_API_KEY is required for an authorized live run.")
            # No secret in compose argv/env, task inputs, bundle, config or retained logs.
            # The entry consumes and unlinks this temporary file before opening a Session.
            with tempfile.TemporaryDirectory(prefix="fatcat-credential-") as directory:
                source = Path(directory) / "key"
                source.touch(mode=0o600)
                source.write_text(key, encoding="utf-8")
                await environment.upload_file(source, credential_path)
            await self.exec_as_root(environment, command=f"chmod 600 {credential_path}")
        entry = "headless-live.js" if self.mode == "live" else "headless.js"
        arguments = (["--key-file", credential_path, "--prior-cost-nano-cny", str(self.prior_cost_nano_cny)]
                     if self.mode == "live" else ["--transport", str(root / "fatcat" / self.transport)])
        command = shlex.join([
            "env", "-i", f"PATH={root}:/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8",
            str(root / "node"), str(root / "fatcat/packages/eval/dist/scripts" / entry),
            "--config", str(logs / "input.json"), *arguments,
        ])
        # Preserve output on failure; a nonzero entry exit remains a Harbor exception.
        try:
            await self.exec_as_agent(environment, command=f"{command} > {shlex.quote(str(logs / 'console.txt'))} 2>&1",
                                     cwd="/app", timeout_sec=(self.duration_ms + 999) // 1000 + 15)
        finally:
            if self.mode == "live":
                await self.exec_as_root(environment, command=f"rm -f -- {credential_path}", timeout_sec=10)

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "fatcat" / "result.json"
        if not path.is_file():
            return  # Setup/host termination can leave partial evidence; Harbor retains its exception.
        result = json.loads(path.read_text(encoding="utf-8"))
        evidence = json.loads((path.parent / "evidence.json").read_text(encoding="utf-8"))
        if result.get("evidence") != self.mode or evidence.get("evidence") != self.mode:
            raise ValueError("Fatcat evidence mode mismatch.")
        context.metadata = {**(context.metadata or {}), "status": result["status"],
                            "cleanup": result["cleanup"], "requests": len(evidence["requests"]),
                            "trajectory": "fatcat/evidence.json"}
        if self.mode == "injected":
            context.metadata["syntheticConsumption"] = evidence["consumption"]
            return  # Fixture usage is never published as real usage or billing.
        ledger = evidence["model"]
        context.metadata.update({"model": ledger, "networkModelRequests": len(ledger["requests"])})
        if ledger["usageComplete"]:
            usage = [request["usage"] for request in ledger["requests"]]
            context.n_input_tokens = sum(item["promptTokens"] for item in usage)
            context.n_output_tokens = sum(item["completionTokens"] for item in usage)
            if all("cachedPromptTokens" in item for item in usage):
                context.n_cache_tokens = sum(item["cachedPromptTokens"] for item in usage)
        # CNY peak-price ceilings are metadata; there is no USD invoice or invented FX conversion.
