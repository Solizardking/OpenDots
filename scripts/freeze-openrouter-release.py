#!/usr/bin/env python3
"""Apply only snapshotted OpenRouter edits to an immutable agent release.

Run after the root-owned files have been snapshotted under
artifacts/openrouter-batch/before and all OpenRouter edits are complete. This
script never changes the checkout, the parent stage, deployment, or environment.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_NEW_FILES = (
    "src/client/OpenRouterBatches.tsx",
    "src/client/openrouter-batches.css",
    "src/server/openrouter-batch.ts",
    "src/shared/openrouter-types.ts",
    "tests/openrouter-batch.test.ts",
    "docs/OPENROUTER.md",
)
OMIT_DIRECTORIES = {"node_modules", "dist", ".git", "data", "artifacts"}
SECRET_PATTERN = re.compile(
    rb"(?:sk-or-v1-[A-Za-z0-9]{32,}|privy_app_secret_[A-Za-z0-9]{32,}|"
    rb"npg_[A-Za-z0-9]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


class FreezeError(Exception):
    pass


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def source_hash(files: dict[str, str]) -> str:
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def generated_parent_path(value: str) -> bool:
    # One older agent release inventoried a deployment worker build here.
    # Only manifest-verified parent files may use this exception; no such file
    # is copied into the new stage or admitted as a new checkout input.
    return value.startswith("deployment/artifacts/")


def safe_path(value: str, *, allow_parent_generated: bool = False) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or str(path) != value
        or any(character in value for character in "\r\n\x00")
    ):
        raise FreezeError("Unsafe source path")
    omitted = OMIT_DIRECTORIES - {"artifacts"} if allow_parent_generated and generated_parent_path(value) else OMIT_DIRECTORIES
    if any(part in omitted for part in path.parts):
        raise FreezeError(f"Generated or state directory is not a source input: {value}")
    if path.name.startswith(".env") and path.name != ".env.example":
        raise FreezeError(f"Environment file is not a source input: {value}")
    if path.suffix.lower() in {".sqlite", ".sqlite3", ".db", ".pem", ".key"}:
        raise FreezeError(f"State or key file is not a source input: {value}")
    if path.name.endswith(("-wal", "-shm")):
        raise FreezeError(f"Database state is not a source input: {value}")
    return value


def receipt_path(value: str) -> bool:
    path = PurePosixPath(value)
    return path.parent == PurePosixPath("public") and (
        path.name == "release.json" or path.name.endswith("-release.json")
    )


def read_source(directory: Path, relative: str, *, allow_parent_generated: bool = False) -> bytes:
    relative = safe_path(relative, allow_parent_generated=allow_parent_generated)
    path = directory / relative
    if not path.is_file() or path.is_symlink():
        raise FreezeError(f"Missing or symlinked source input: {relative}")
    try:
        path.resolve().relative_to(directory.resolve())
    except ValueError as error:
        raise FreezeError(f"Source input escapes its directory: {relative}") from error
    value = path.read_bytes()
    if SECRET_PATTERN.search(value):
        # Report the filename only; never print matched key material.
        raise FreezeError(f"Potential credential or private key in source input: {relative}")
    return value


def put_source(directory: Path, relative: str, value: bytes) -> None:
    destination = directory / safe_path(relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(value)


def isolated_git_environment(directory: Path) -> dict[str, str]:
    # A stage can be inside the checkout's repository. Git otherwise silently
    # ignores patch paths outside its current repository subdirectory.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update({
        "GIT_CEILING_DIRECTORIES": str(directory.parent.resolve()),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
    })
    return environment


def candidate_identity(candidate: dict) -> tuple[str, str, str]:
    release = candidate.get("release", candidate)
    stage = candidate.get("stagePath") or candidate.get("stage")
    if not stage or not release.get("releaseId") or not release.get("sourceHash"):
        raise FreezeError("Base candidate is missing its stage or release identity")
    return str(stage), str(release["releaseId"]), str(release["sourceHash"])


def load_manifest(base: Path) -> tuple[dict[str, str], Path]:
    path = base.parent / "source-files.json"
    if path.is_file():
        value = json.loads(path.read_text(encoding="utf-8"))
    else:
        path = base.parent / "release-source.json"
        if not path.is_file():
            raise FreezeError("Base release has no external source manifest")
        value = json.loads(path.read_text(encoding="utf-8")).get("files")
    if isinstance(value, list):
        value = dict(value)
    if not isinstance(value, dict) or not value:
        raise FreezeError("Invalid base source manifest")
    for name, checksum in value.items():
        safe_path(name, allow_parent_generated=True)
        if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{64}", checksum):
            raise FreezeError(f"Invalid source checksum: {name}")
    return value, path


def files_on_disk(directory: Path) -> list[str]:
    files = []
    for path in directory.rglob("*"):
        relative = path.relative_to(directory)
        if any(part in OMIT_DIRECTORIES for part in relative.parts):
            continue
        if path.is_file() or path.is_symlink():
            files.append(relative.as_posix())
    return sorted(files)


def patch_file(stage: Path, name: str, before: bytes, after: bytes, scratch: Path) -> str:
    # Identical relative paths under a/ and b/ produce ordinary git patch paths;
    # no absolute checkout/snapshot paths can enter the patch.
    put_source(scratch / "a", name, before)
    put_source(scratch / "b", name, after)
    result = subprocess.run(
        ["git", "diff", "--no-index", "--no-ext-diff", "--binary", "--src-prefix=", "--dst-prefix=", "--", f"a/{name}", f"b/{name}"],
        cwd=scratch,
        env=isolated_git_environment(scratch),
        capture_output=True,
        check=False,
    )
    if result.returncode not in {0, 1}:
        raise FreezeError(f"Could not construct patch for {name}")
    patch = result.stdout
    if not patch:
        return digest(patch)
    check = subprocess.run(
        ["git", "apply", "--check", "--whitespace=nowarn", "-"],
        cwd=stage,
        env=isolated_git_environment(stage),
        input=patch,
        capture_output=True,
        check=False,
    )
    if check.returncode:
        raise FreezeError(f"Patch conflicts with immutable base: {name}")
    applied = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", "-"],
        cwd=stage,
        env=isolated_git_environment(stage),
        input=patch,
        capture_output=True,
        check=False,
    )
    if applied.returncode:
        raise FreezeError(f"Patch could not be applied: {name}")
    return digest(patch)


def freeze(args: argparse.Namespace) -> dict:
    root = args.root.resolve()
    before_dir = args.before_dir.resolve()
    candidate_path = args.base_candidate.resolve()
    output = args.output_root.resolve()
    candidate_bytes = candidate_path.read_bytes()
    candidate = json.loads(candidate_bytes)
    identity = candidate_identity(candidate)
    base = Path(identity[0]).resolve()
    if not base.is_dir():
        raise FreezeError("Base stage does not exist")
    if args.expected_base_hash and args.expected_base_hash != identity[2]:
        raise FreezeError("Latest base candidate does not have the expected source hash")
    manifest, manifest_path = load_manifest(base)
    if source_hash(manifest) != identity[2]:
        raise FreezeError("Base candidate checksum does not match its source manifest")
    if len(manifest) != candidate.get("release", candidate).get("sourceFiles"):
        raise FreezeError("Base candidate source count does not match its manifest")

    base_inputs = {}
    verified_parent_inputs = {}
    excluded_parent_generated = {}
    preserved_receipts = {}
    for name in files_on_disk(base):
        if receipt_path(name):
            preserved_receipts[name] = read_source(base, name)
        elif name not in manifest:
            raise FreezeError(f"Unmanifested file in immutable base: {name}")
    for name, checksum in manifest.items():
        value = read_source(base, name, allow_parent_generated=True)
        if digest(value) != checksum:
            raise FreezeError(f"Immutable base source changed: {name}")
        verified_parent_inputs[name] = value
        if generated_parent_path(name):
            excluded_parent_generated[name] = checksum
        else:
            base_inputs[name] = value
    if "public/openrouter-release.json" in preserved_receipts:
        raise FreezeError("Base already contains an OpenRouter receipt; choose a clean parent release")

    if not before_dir.is_dir():
        raise FreezeError("Before-edit snapshot directory does not exist")
    snapshots = files_on_disk(before_dir)
    if not snapshots:
        raise FreezeError("Before-edit snapshot has no files")
    edits = {}
    for name in snapshots:
        old = read_source(before_dir, name)
        new = read_source(root, name)
        edits[name] = (old, new)
    additions = {}
    for name in args.new_file or DEFAULT_NEW_FILES:
        name = safe_path(name)
        if name in edits or name in base_inputs or name in preserved_receipts:
            raise FreezeError(f"New source file already exists in a snapshot or base: {name}")
        additions[name] = read_source(root, name)

    release_id = args.release_id or (
        "chatgptee-openrouter-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", release_id):
        raise FreezeError("Invalid release ID")
    final_dir = output / "releases" / release_id
    if final_dir.exists():
        raise FreezeError("Release already exists; refusing to overwrite it")
    final_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary = final_dir.parent / f".{release_id}.preparing-{uuid.uuid4().hex}"
    temporary.mkdir()
    stage = temporary / "stage"
    stage.mkdir()
    try:
        for name, value in {**base_inputs, **preserved_receipts}.items():
            put_source(stage, name, value)
            # Preserve source executable permissions without bringing filesystem links.
            (stage / name).chmod((base / name).stat().st_mode & 0o777)
        patched = []
        seeded = []
        with tempfile.TemporaryDirectory(prefix="patch-", dir=temporary) as scratch_name:
            scratch = Path(scratch_name)
            for name, (before, after) in edits.items():
                if name not in base_inputs:
                    if name != ".env.example" and not name.startswith(("tests/", "docs/")):
                        raise FreezeError(f"Runtime snapshot is absent from immutable base: {name}")
                    put_source(stage, name, before)
                    seeded.append({"path": name, "beforeHash": digest(before)})
                base_checksum = digest((stage / name).read_bytes())
                patch_hash = patch_file(stage, name, before, after, scratch)
                if before != after:
                    patched.append({
                        "path": name,
                        "beforeHash": digest(before),
                        "checkoutHash": digest(after),
                        "baseHash": base_checksum,
                        "stagedHash": digest(read_source(stage, name)),
                        "patchHash": patch_hash,
                    })
        for name, value in additions.items():
            put_source(stage, name, value)

        # Catch edits still in progress and candidate/source changes during preparation.
        for name, (_, value) in edits.items():
            if read_source(root, name) != value or read_source(before_dir, name) != edits[name][0]:
                raise FreezeError(f"Owned file changed while freezing: {name}")
        for name, value in additions.items():
            if read_source(root, name) != value:
                raise FreezeError(f"New file changed while freezing: {name}")
        if candidate_identity(json.loads(candidate_path.read_bytes())) != identity:
            raise FreezeError("Latest base candidate changed while freezing; retry over that candidate")
        for name, value in {**verified_parent_inputs, **preserved_receipts}.items():
            if read_source(base, name, allow_parent_generated=True) != value:
                raise FreezeError(f"Immutable parent changed while freezing: {name}")

        source_files = {
            name: digest(read_source(stage, name))
            for name in files_on_disk(stage)
            if not receipt_path(name)
        }
        receipt_hashes = {name: digest(value) for name, value in preserved_receipts.items()}
        release = {
            "releaseId": release_id,
            "sourceHash": source_hash(source_files),
            "sourceFiles": len(source_files),
            "application": "ChatGPTEE",
            "feature": "OpenRouter durable per-user batch jobs",
            "baseURL": "https://chatgptee.ai",
            "baseReleaseId": identity[1],
            "baseSourceHash": identity[2],
        }
        public_receipt = stage / "public/openrouter-release.json"
        write_json(public_receipt, release)
        final_stage = final_dir / "stage"
        report = {
            "stagePath": str(final_stage),
            "stage": str(final_stage),
            "release": release,
            "baseCandidatePath": str(candidate_path),
            "baseCandidate": candidate,
            "baseSourceManifest": str(manifest_path),
            "baseSourceManifestHash": digest(manifest_path.read_bytes()),
            "sourceHashAlgorithm": "sha256(JSON source path-to-sha256 map, sorted keys, compact separators)",
            "files": source_files,
            "patchedFiles": patched,
            "addedSourceFiles": sorted(additions),
            "seededVerificationBaselines": seeded,
            "preservedParentReceiptHashes": receipt_hashes,
            "excludedVerifiedParentGeneratedFiles": excluded_parent_generated,
            "verifiedParentSourceFiles": len(verified_parent_inputs),
            "sourceHashExclusions": sorted([*preserved_receipts, *excluded_parent_generated, "public/openrouter-release.json"]),
            "sourceHashExclusionReason": "Generated release receipts are preserved but excluded from source inputs to avoid self-references and stale parent source identities. Manifest-verified legacy deployment/artifacts files are excluded from the copied stage and new source hash.",
            "noSecretsOrState": True,
        }
        write_json(temporary / "source-files.json", source_files)
        write_json(temporary / "release-source.json", report)
        (temporary / "parent-release-candidate.json").write_bytes(candidate_bytes)
        temporary.rename(final_dir)
        result = {
            "stagePath": str(final_stage),
            "release": release,
            "deployed": False,
            "status": "prepared",
        }
        write_json(output / "release-candidate.json", result)
        return result
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Checkout containing only the owned before/after changes")
    parser.add_argument("--base-candidate", type=Path, default=ROOT / "artifacts/agent-access/release-candidate.json")
    parser.add_argument("--before-dir", type=Path, default=ROOT / "artifacts/openrouter-batch/before")
    parser.add_argument("--output-root", type=Path, default=ROOT / "artifacts/openrouter-batch")
    parser.add_argument("--expected-base-hash", help="Fail if a concurrent candidate superseded the intended parent")
    parser.add_argument("--release-id", help="Optional fixed release identifier for reproducible invocation")
    parser.add_argument("--new-file", action="append", help="Explicit new source input (repeat; replaces the default new-file list)")
    args = parser.parse_args()
    try:
        print(json.dumps(freeze(args)))
        return 0
    except (FreezeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "failed", "reason": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
