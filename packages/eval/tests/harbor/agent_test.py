"""Run with the pinned Harbor Python environment; no Docker or network is used."""

import hashlib
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path, PurePosixPath
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "harbor"))

from fatcat_agent import FatcatAgent
from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.models.agent.context import AgentContext


class Environment:
    default_user = None

    def __init__(self):
        self.commands = []
        self.uploads = {}
        self.exit_code = 0

    async def exec(self, **kwargs):
        self.commands.append(kwargs)
        return SimpleNamespace(return_code=self.exit_code if "headless.js --config" in kwargs["command"] else 0,
                               stdout="", stderr="injected execution failure")

    async def upload_file(self, source, target):
        self.uploads[target] = Path(source).read_bytes()


class AgentTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fatcat-harbor-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle.tar.gz"
        self.bundle.write_bytes(b"test bundle")
        self.digest = hashlib.sha256(self.bundle.read_bytes()).hexdigest()

    def agent(self, **kwargs):
        return FatcatAgent(logs_dir=self.root, bundle_path=str(self.bundle), bundle_sha256=self.digest,
                                   environment_logs_dir=PurePosixPath("/logs/agent"), **kwargs)

    def test_rejects_live_execution_and_unbounded_options(self):
        for kwargs in [{"model_name": "deepseek/deepseek-flash"}, {"extra_env": {"API_KEY": "fake"}},
                       {"requests": True}, {"requests": 33}, {"duration_ms": 120001},
                       {"transport_path": "../escape.js"}, {"transport_path": "/absolute.js"}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.agent(**kwargs)

    async def test_checks_bundle_before_upload(self):
        agent = self.agent()
        self.bundle.write_bytes(b"changed after construction")
        environment = Environment()
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            await agent.install(environment)
        self.assertEqual(environment.uploads, {})
        self.assertEqual(environment.commands, [])

    async def test_uploads_instruction_as_data_and_preserves_failed_exit(self):
        agent = self.agent()
        environment = Environment()
        await agent.install(environment)
        self.assertIn("sha256sum -c", environment.commands[-1]["command"])
        instruction = "Quotes ' \" $(touch /app/unexpected)\nUnicode: \u4e2d\u6587"
        context = AgentContext()
        await agent.run(instruction, environment, context)
        options = json.loads(environment.uploads["/logs/agent/input.json"])
        self.assertEqual(options["instruction"], instruction)
        self.assertEqual(options["taskCwd"], "/app")
        self.assertEqual(options["permission"], {"files": "workspace-write", "shell": "allow"})
        command = environment.commands[-1]
        self.assertNotIn(instruction, command["command"])
        self.assertIn("env -i", command["command"])
        self.assertEqual(command["cwd"], "/app")
        self.assertEqual(command["timeout_sec"], 45)
        self.assertIsNone(context.n_input_tokens)
        self.assertIsNone(context.cost_usd)
        environment.exit_code = 7
        with self.assertRaises(NonZeroAgentExitCodeError):
            await agent.run(instruction, environment, AgentContext())

    def test_collects_native_trajectory_without_inventing_billing(self):
        agent = self.agent()
        context = AgentContext(metadata={"evidence": "injected"})
        agent.populate_context_post_run(context)  # An interrupted setup has no result.
        path = self.root / "fatcat"
        path.mkdir()
        (path / "result.json").write_text(json.dumps({"evidence": "injected", "status": "failed", "cleanup": "removed"}))
        (path / "evidence.json").write_text(json.dumps({"evidence": "injected", "requests": [{}],
                                                       "consumption": {"synthetic": True}}))
        agent.populate_context_post_run(context)
        self.assertEqual(context.metadata["status"], "failed")
        self.assertEqual(context.metadata["requests"], 1)
        self.assertEqual(context.metadata["trajectory"], "fatcat/evidence.json")
        self.assertIsNone(context.n_input_tokens)
        self.assertIsNone(context.cost_usd)

    async def test_live_credentials_are_not_in_commands_or_retained_inputs(self):
        agent = self.agent(mode="live", model_name="deepseek/deepseek-flash", duration_ms=1800000, prior_cost_nano_cny=2820469360)
        environment = Environment()
        with patch.dict("os.environ", {"DEEPSEEK_API_KEY": "fake-key-for-offline-test"}):
            await agent.run("Original task", environment, AgentContext())
        self.assertEqual(environment.uploads.pop("/installed-agent/fatcat-api-key"), b"fake-key-for-offline-test")
        self.assertNotIn("fake-key-for-offline-test", repr(environment.commands) + repr(environment.uploads))
        self.assertIn("headless-live.js", environment.commands[-2]["command"])
        self.assertIn("--prior-cost-nano-cny 2820469360", environment.commands[-2]["command"])
        self.assertIn("rm -f -- /installed-agent/fatcat-api-key", environment.commands[-1]["command"])
        for kwargs in [{"mode": "live"}, {"mode": "live", "model_name": "deepseek/deepseek-flash", "transport_path": "fake.js"}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.agent(**kwargs)

    def test_live_usage_keeps_unknown_counters_and_cny_separate(self):
        agent = self.agent(mode="live", model_name="deepseek/deepseek-flash")
        path = self.root / "fatcat"
        path.mkdir()
        (path / "result.json").write_text(json.dumps({"evidence": "live", "status": "completed", "cleanup": "removed"}))
        record = {"evidence": "live", "requests": [{}], "model": {"usageComplete": True, "accountedCnyCeiling": 0.01,
                  "requests": [{"usage": {"promptTokens": 100, "completionTokens": 20}}]}}
        (path / "evidence.json").write_text(json.dumps(record))
        context = AgentContext()
        agent.populate_context_post_run(context)
        self.assertEqual(context.n_input_tokens, 100)
        self.assertEqual(context.n_output_tokens, 20)
        self.assertIsNone(context.n_cache_tokens)
        self.assertIsNone(context.cost_usd)
        record["model"]["usageComplete"] = False
        (path / "evidence.json").write_text(json.dumps(record))
        incomplete = AgentContext()
        agent.populate_context_post_run(incomplete)
        self.assertIsNone(incomplete.n_input_tokens)


if __name__ == "__main__":
    unittest.main()
