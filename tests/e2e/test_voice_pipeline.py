"""Offline end-to-end smoke test for the TypeScript Voice QA pipeline.

The Python file is intentionally a thin runner. The real scenario lives in
``voice_pipeline_smoke.ts`` and imports the production VoiceQaBridge, so this
test does not duplicate the application's partial/final or TTS fallback logic.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


class VoicePipelineSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        npm = shutil.which("npm")
        if npm is None:
            raise unittest.SkipTest("npm is required to execute the TypeScript smoke harness")

        environment = os.environ.copy()
        # The harness always injects a mock transport in test mode. Keeping the
        # configured provider name verifies the production selection contract
        # without opening a WebSocket or reading provider credentials.
        environment["VOICE_PROVIDER"] = "volcengine"
        environment["VOICE_TEST_MODE"] = "true"
        environment.setdefault("VOICE_DEBUG", "false")
        completed = subprocess.run(
            [npm, "exec", "--", "tsx", "tests/e2e/voice_pipeline_smoke.ts"],
            cwd=repository_root,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        if completed.returncode != 0:
            raise AssertionError(
                "Voice smoke harness failed.\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        try:
            cls.report = json.loads(completed.stdout.strip())
        except json.JSONDecodeError as error:
            raise AssertionError(
                f"Voice smoke harness returned invalid JSON: {completed.stdout!r}"
            ) from error

    def test_session_is_created_and_audio_enters_pipeline(self) -> None:
        self.assertEqual(self.report["configuredProvider"], "volcengine")
        self.assertEqual(self.report["transport"], "mock")
        self.assertTrue(self.report["testMode"])
        self.assertTrue(self.report["assertions"]["sessionCreated"])
        self.assertTrue(self.report["assertions"]["sessionContextPersisted"])
        self.assertEqual(self.report["normal"]["logicalContextMessages"], 2)
        self.assertEqual(self.report["normal"]["logicalStateBeforeClose"], "IDLE")
        self.assertGreater(self.report["normal"]["audioInputBytes"], 0)

    def test_partial_asr_does_not_trigger_qa(self) -> None:
        self.assertEqual(self.report["normal"]["qaCallsAfterPartial"], 0)
        self.assertTrue(self.report["assertions"]["partialDidNotTriggerQa"])

    def test_final_asr_triggers_qa_and_tts(self) -> None:
        self.assertEqual(self.report["normal"]["qaCallCount"], 1)
        self.assertEqual(self.report["normal"]["ttsRequestCount"], 1)
        self.assertGreater(self.report["normal"]["responseAudioBytes"], 0)
        self.assertTrue(self.report["assertions"]["finalTriggeredQa"])
        self.assertTrue(self.report["assertions"]["normalTtsReturnedAudio"])

    def test_tts_failure_returns_text_fallback(self) -> None:
        failure = self.report["ttsFailure"]
        self.assertEqual(failure["qaCallCount"], 1)
        self.assertEqual(failure["responseAudioBytes"], 0)
        self.assertTrue(failure["responseHasText"])
        self.assertIn("tts_failed", failure["responseErrors"])
        self.assertTrue(self.report["assertions"]["ttsFailureReturnedText"])
        self.assertTrue(self.report["pass"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
