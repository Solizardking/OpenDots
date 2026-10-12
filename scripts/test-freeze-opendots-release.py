"""Release boundary tests using isolated fixtures, never the real environment."""

import argparse
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("freezer", Path(__file__).with_name("freeze-opendots-release.py"))
freezer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(freezer)


class FreezeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "checkout"
        self.root.mkdir()
        self.output = Path(self.temp.name) / "candidate"
        for name in ("package.json", "package-lock.json", "index.html", "src/server/index.ts", "deployment/Dockerfile.chatgptee", "src/build/dark-theme.ts"):
            self.put(name, "{}" if name.endswith(".json") else "fixture source\n")

    def tearDown(self):
        self.temp.cleanup()

    def put(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
        return path

    def freeze(self, release_id="fixture", feature=freezer.DEFAULT_FEATURE):
        return freezer.freeze(argparse.Namespace(source_root=self.root, output=self.output, release_id=release_id, feature=feature, reuse_node_modules=False))

    def test_custom_public_feature_is_receipted_separately_and_tampering_fails(self):
        original = self.freeze("original")
        feature = "Jupiter Swap V2 quotes, custom builds and connected-wallet transaction review"
        candidate = self.freeze("jupiter", feature)
        self.assertEqual(candidate["release"]["feature"], feature)
        self.assertEqual(candidate["release"]["sourceHash"], original["release"]["sourceHash"])
        self.assertTrue(freezer.verify(self.output / "release-candidate.json")["verified"])
        receipt = Path(candidate["stagePath"]) / freezer.RECEIPT
        value = json.loads(receipt.read_text())
        value["feature"] = "altered feature"
        receipt.write_text(json.dumps(value))
        with self.assertRaisesRegex(freezer.FreezeError, "receipt changed"):
            freezer.verify(self.output / "release-candidate.json")

    def test_feature_rejects_private_key_marker_without_value_in_error(self):
        marker = " ".join(("-----BEGIN", "OPENSSH", "PRIVATE KEY-----"))
        with self.assertRaises(freezer.FreezeError) as caught:
            self.freeze(feature=marker)
        self.assertNotIn(marker, str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_feature_rejects_empty_multiline_and_unbounded_descriptions(self):
        for feature in ("", "  ", "Jupiter\nprivate metadata", "x" * 241):
            with self.subTest(featureLength=len(feature)):
                with self.assertRaisesRegex(freezer.FreezeError, "single-line text"):
                    self.freeze(feature=feature)
        self.assertFalse(self.output.exists())

    def test_state_environment_and_packaged_outputs_are_not_read(self):
        for name in (".env", "src/.env.secret", "src/data/account.json", "deployment/artifacts/credentials.json", "electron/out/User.app/account.json", "public/app.zip", "src/private.pem"):
            self.put(name, "DO NOT READ OR COPY")
        read_bytes = Path.read_bytes

        def guarded(path):
            if path.is_relative_to(self.root) and "DO NOT READ OR COPY" in path.read_text():
                raise AssertionError("Excluded state was read")
            return read_bytes(path)

        with patch.object(Path, "read_bytes", guarded):
            candidate = self.freeze()
        stage = Path(candidate["stagePath"])
        self.assertTrue((stage / "src/build/dark-theme.ts").exists())
        self.assertFalse((stage / "src/.env.secret").exists())
        self.assertFalse((stage / "electron/out").exists())
        self.assertFalse((stage / "public/app.zip").exists())

    def test_hash_rejects_source_changes(self):
        candidate = self.freeze()
        (Path(candidate["stagePath"]) / "src/server/index.ts").write_text("edited source")
        with self.assertRaisesRegex(freezer.FreezeError, "identity changed"):
            freezer.verify(self.output / "release-candidate.json")

    def test_hash_rejects_extra_source_files(self):
        candidate = self.freeze()
        (Path(candidate["stagePath"]) / "src/server/extra.ts").write_text("added source")
        with self.assertRaisesRegex(freezer.FreezeError, "Unexpected file"):
            freezer.verify(self.output / "release-candidate.json")

    def test_unexpected_environment_file_is_rejected_without_reading(self):
        candidate = self.freeze()
        env = Path(candidate["stagePath"]) / ".env"
        env.write_text("fixture state")
        read_bytes = Path.read_bytes

        def guarded(path):
            if path == env:
                raise AssertionError("Environment was read")
            return read_bytes(path)

        with patch.object(Path, "read_bytes", guarded):
            with self.assertRaisesRegex(freezer.FreezeError, "Unexpected file"):
                freezer.verify(self.output / "release-candidate.json")

    def test_generated_receipt_is_separate_and_tampering_fails(self):
        self.put("public/old-release.json", '{"releaseId":"old"}')
        candidate = self.freeze()
        stage = Path(candidate["stagePath"])
        self.assertFalse((stage / "public/old-release.json").exists())
        report = json.loads((self.output / "release-source.json").read_text())
        self.assertNotIn(freezer.RECEIPT, [entry["path"] for entry in report["files"]])
        receipt = stage / freezer.RECEIPT
        value = json.loads(receipt.read_text())
        value["sourceHash"] = "altered"
        receipt.write_text(json.dumps(value))
        with self.assertRaisesRegex(freezer.FreezeError, "receipt changed"):
            freezer.verify(self.output / "release-candidate.json")

    def test_symlinked_source_is_rejected(self):
        outside = Path(self.temp.name) / "private-source"
        outside.write_text("private")
        (self.root / "src/server/external.ts").symlink_to(outside)
        with self.assertRaisesRegex(freezer.FreezeError, "regular file"):
            self.freeze()

    def test_private_key_marker_is_rejected_without_value_in_error(self):
        marker = " ".join(("-----BEGIN", "OPENSSH", "PRIVATE KEY-----"))
        self.put("src/server/accident.ts", marker + "\nfixture-key")
        with self.assertRaises(freezer.FreezeError) as caught:
            self.freeze()
        self.assertIn("src/server/accident.ts", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))
        self.assertNotIn("fixture-key", str(caught.exception))

    def test_input_modes_and_shared_state_settings_are_preserved(self):
        script = self.put("deployment/start-chatgptee.sh", "#!/bin/sh\n")
        script.chmod(0o755)
        candidate = self.freeze()
        stage = Path(candidate["stagePath"])
        self.assertEqual((stage / "deployment/start-chatgptee.sh").stat().st_mode & 0o777, 0o755)
        report = json.loads((self.output / "release-source.json").read_text())
        self.assertEqual(report["deployment"]["preserveVolume"], "/data")
        self.assertFalse(report["deployment"]["providerVariablesChanged"])
        self.assertTrue(freezer.verify(self.output / "release-candidate.json")["verified"])

    def test_zip_test_fixture_is_included_without_shipping_app_packages(self):
        self.put("tests/fixtures/learning-skills.zip", "fixture archive")
        self.put("electron/release/app.zip", "packaged application")
        candidate = self.freeze()
        stage = Path(candidate["stagePath"])
        self.assertTrue((stage / "tests/fixtures/learning-skills.zip").exists())
        self.assertFalse((stage / "electron/release").exists())

    def test_only_root_public_environment_template_is_admitted_and_hashed(self):
        self.put(".env.example", "DFLOW_API_KEY=\n")
        self.put("src/.env.example", "private nested configuration")
        candidate = self.freeze()
        stage = Path(candidate["stagePath"])
        self.assertEqual((stage / ".env.example").read_text(), "DFLOW_API_KEY=\n")
        self.assertFalse((stage / "src/.env.example").exists())
        (stage / ".env.example").write_text("DFLOW_API_KEY=edited\n")
        with self.assertRaisesRegex(freezer.FreezeError, "identity changed"):
            freezer.verify(self.output / "release-candidate.json")

    def test_public_environment_template_still_runs_secret_scanner(self):
        marker = " ".join(("-----BEGIN", "OPENSSH", "PRIVATE KEY-----"))
        self.put(".env.example", marker + "\nfixture-key")
        with self.assertRaisesRegex(freezer.FreezeError, "Potential credential") as caught:
            self.freeze()
        self.assertNotIn("fixture-key", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
