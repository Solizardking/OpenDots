#!/usr/bin/env python3
"""Freeze the current OpenDots sources for a reproducible, secret-free release.

This does not read private environment files, copy user state, deploy, or change the
checkout. The candidate records every admitted source byte and executable mode.
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
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FEATURE = "Registration, Pump.fun panel and connected-wallet transaction review"
SOURCE_DIRECTORIES = ("src", "public", "scripts", "tests", "docs", "deployment", "electron", "agent", ".github")
ROOT_FILES = (
    "package.json", "package-lock.json", "index.html", "vite.config.ts",
    "vitest.config.ts", "tsconfig.json", "tsconfig.server.json", "eslint.config.js",
    "Dockerfile", ".dockerignore", ".gitignore", ".gitattributes", ".env.example",
    ".prettierrc.json", ".prettierignore", "README.md", "CONTRIBUTING.md",
    "SECURITY.md", "LICENSE", "compose.yml", "compose.computers.yml",
    "compose.computers-app.yml", "ARTICLE.md", "PRIVACY.md", "TERMS.md", "SERVICE.md",
)
OMIT_DIRECTORIES = {
    ".git", ".vercel", ".railway", ".wrangler", ".cache", "__pycache__",
    "node_modules", "dist", "data", "artifacts", "coverage", "test-results", "playwright-report",
    "secrets", "credentials",
}
OMIT_SUFFIXES = {".sqlite", ".sqlite3", ".db", ".pem", ".key", ".p12", ".pfx", ".zip", ".dmg", ".asar", ".apk", ".pyc", ".log"}
RECEIPT = "public/opendots-release.json"
RAILWAY_IGNORE = "\n".join([
    ".git", ".vercel", "node_modules", "**/node_modules", "dist", "**/dist",
    ".env", ".env.*", "**/.env", "**/.env.*", "data", "**/data",
    "artifacts", "**/artifacts", ".wrangler", "**/.wrangler", "**/*.app",
    "**/*.zip", "**/*.dmg", "**/*.asar", "**/*.apk", "**/*.sqlite*", "**/*.db*",
    "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/__pycache__", "**/*.pyc", "",
]).encode()
SECRET_PATTERN = re.compile(
    rb"(?:sk-or-v1-[A-Za-z0-9]{32,}|privy_app_secret_[A-Za-z0-9]{32,}|"
    rb"sm_[A-Za-z0-9_-]{60,}|npg_[A-Za-z0-9]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)


class FreezeError(Exception):
    pass


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def receipt_path(relative: str) -> bool:
    path = Path(relative)
    return path.parent == Path("public") and (path.name == "release.json" or path.name.endswith("-release.json"))


def omitted(path: Path, *, directory: bool = False) -> bool:
    name = path.name.lower()
    if name.startswith(".env") or name.startswith(("secrets.", "credentials.")):
        return True
    if directory:
        return name in OMIT_DIRECTORIES or name.endswith(".app")
    return path.suffix.lower() in OMIT_SUFFIXES or name.endswith(("-wal", "-shm"))


def inputs(root: Path) -> tuple[dict[str, tuple[bytes, int]], list[str]]:
    admitted: dict[str, tuple[bytes, int]] = {}
    excluded: list[str] = []

    def admit(path: Path) -> None:
        relative = path.relative_to(root).as_posix()
        test_archive = relative.startswith("tests/fixtures/") and path.suffix.lower() == ".zip"
        public_env_template = relative == ".env.example"
        if (omitted(path) and not test_archive and not public_env_template) or receipt_path(relative):
            excluded.append(relative)
            return
        if path.is_symlink() or not path.is_file():
            raise FreezeError(f"Source input must be a regular file: {relative}")
        value = path.read_bytes()
        if SECRET_PATTERN.search(value):
            raise FreezeError(f"Potential credential or private key in source input: {relative}")
        admitted[relative] = (value, path.stat().st_mode & 0o777)

    for name in ROOT_FILES:
        path = root / name
        if path.exists() or path.is_symlink():
            admit(path)
    for name in SOURCE_DIRECTORIES:
        directory = root / name
        if not directory.exists():
            continue
        if directory.is_symlink() or not directory.is_dir():
            raise FreezeError(f"Source directory must be a real directory: {name}")
        for folder, directories, files in os.walk(directory, followlinks=False):
            base = Path(folder)
            for entry in list(directories):
                path = base / entry
                packaged_electron = name == "electron" and entry.lower() in {"runtime", "release", "releases", "out", "build"}
                if omitted(path, directory=True) or packaged_electron:
                    directories.remove(entry)
                    excluded.append(path.relative_to(root).as_posix() + "/")
                elif path.is_symlink():
                    raise FreezeError(f"Symlinked source directory: {path.relative_to(root)}")
            for entry in sorted(files):
                admit(base / entry)
    for name in ("package.json", "package-lock.json", "index.html", "src/server/index.ts", "deployment/Dockerfile.chatgptee"):
        if name not in admitted:
            raise FreezeError(f"Required deployment source is missing: {name}")
    return admitted, sorted(excluded)


def inventory(values: dict[str, tuple[bytes, int]]) -> list[dict[str, object]]:
    return [{"path": name, "sha256": digest(value), "mode": mode, "bytes": len(value)} for name, (value, mode) in sorted(values.items())]


def source_hash(files: list[dict[str, object]]) -> str:
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":")).encode())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def verify(candidate_path: Path) -> dict[str, object]:
    candidate = json.loads(candidate_path.read_text())
    stage = Path(candidate["stagePath"])
    report = json.loads((candidate_path.parent / "release-source.json").read_text())
    expected = {str(entry["path"]) for entry in report["files"]} | {RECEIPT}
    # Refuse newly introduced state or unknown inputs before opening their bytes.
    # Only local dependency reuse and build output may exist outside the manifest.
    for folder, directories, names in os.walk(stage, followlinks=False):
        base = Path(folder)
        directories[:] = [name for name in directories if name != "__pycache__"]
        if base == stage:
            directories[:] = [name for name in directories if name not in {"node_modules", "dist"}]
        for name in names:
            relative = (base / name).relative_to(stage).as_posix()
            if relative not in expected:
                raise FreezeError(f"Unexpected file in frozen stage: {relative}")
    values, _ = inputs(stage)
    values[".railwayignore"] = ((stage / ".railwayignore").read_bytes(), (stage / ".railwayignore").stat().st_mode & 0o777)
    files = inventory(values)
    if files != report["files"] or source_hash(files) != candidate["release"]["sourceHash"]:
        raise FreezeError("Frozen source identity changed")
    receipt = json.loads((stage / RECEIPT).read_text())
    if receipt != candidate["release"]:
        raise FreezeError("Public release receipt changed")
    return {"verified": True, "stagePath": str(stage), "release": receipt}


def freeze(args: argparse.Namespace) -> dict[str, object]:
    root = args.source_root.resolve()
    feature = getattr(args, "feature", DEFAULT_FEATURE)
    if not isinstance(feature, str) or not feature.strip() or len(feature) > 240 or any(ord(character) < 32 for character in feature):
        raise FreezeError("Feature description must be public, single-line text of 1 to 240 characters")
    if SECRET_PATTERN.search(feature.encode("utf-8")):
        raise FreezeError("Potential credential or private key in feature description")
    values, excluded = inputs(root)
    values[".railwayignore"] = (RAILWAY_IGNORE, 0o644)
    files = inventory(values)
    release_id = args.release_id or "opendots-pump-wallet-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", release_id):
        raise FreezeError("Invalid release ID")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    release_dir = output / "releases" / release_id
    if release_dir.exists():
        raise FreezeError("Release already exists; choose a new release ID")
    temporary = output / "releases" / f".{release_id}.preparing-{uuid.uuid4().hex}"
    stage = temporary / "stage"
    stage.mkdir(parents=True)
    try:
        for name, (value, mode) in values.items():
            path = stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
            path.chmod(mode)
        current, _ = inputs(root)
        current[".railwayignore"] = (RAILWAY_IGNORE, 0o644)
        if inventory(current) != files:
            raise FreezeError("Checkout changed during freeze; finish edits and retry")
        try:
            commit = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        except subprocess.CalledProcessError:
            commit = None
        release = {
            "releaseId": release_id, "sourceHash": source_hash(files), "sourceFiles": len(files),
            "sourceBytes": sum(int(entry["bytes"]) for entry in files), "sourceCommit": commit,
            "application": "ChatGPTEE", "baseURL": "https://chatgptee.ai",
            "feature": feature,
        }
        write_json(stage / RECEIPT, release)
        if args.reuse_node_modules:
            installed = root / "node_modules"
            if not installed.is_dir():
                raise FreezeError("Installed dependencies are unavailable for reuse")
            (stage / "node_modules").symlink_to(installed, target_is_directory=True)
        stage_path = release_dir / "stage"
        candidate = {"stagePath": str(stage_path), "stage": str(stage_path), "release": release, "deployed": False, "status": "prepared"}
        report = {
            **candidate, "files": files, "excludedPaths": excluded, "sourceRoot": str(root),
            "sourceHashExclusions": [RECEIPT, "node_modules", "dist"],
            "exclusionReason": "Real environment files, secrets, workspace state and packaged outputs are never read or copied. Only the root public .env.example template is admitted and scanned. The generated receipt is excluded to avoid a self-reference; local build dependencies and build outputs are not source inputs.",
            "deployment": {"dockerfile": "deployment/Dockerfile.chatgptee", "healthcheck": "/healthz", "preserveVolume": "/data", "replicas": 1, "providerVariablesChanged": False},
        }
        write_json(temporary / "release-source.json", report)
        write_json(temporary / "release-candidate.json", candidate)
        temporary.rename(release_dir)
        write_json(output / "release-source.json", report)
        write_json(output / "release-candidate.json", candidate)
        verify(output / "release-candidate.json")
        return candidate
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/opendots-pump-wallet")
    parser.add_argument("--release-id")
    parser.add_argument("--feature", default=DEFAULT_FEATURE, help="Public feature summary written into the release receipt")
    parser.add_argument("--reuse-node-modules", action="store_true")
    parser.add_argument("--verify-candidate", type=Path)
    args = parser.parse_args()
    try:
        result = verify(args.verify_candidate.resolve()) if args.verify_candidate else freeze(args)
        print(json.dumps(result))
        return 0
    except (FreezeError, OSError, KeyError, ValueError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
