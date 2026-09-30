"""Install a reviewed OCR policy into a NEW sibling runtime; never launch it.
Run on the authorized host only after explicit approval. The original handoff,
runtime, budgets and model/dependency hashes stay unchanged.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import sys

APPROVED_PARENT = pathlib.Path("/data/lyc/paddleocr-vllm-trial-20260921-111817")

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def install(source, destination, bundle, manifest_sha, authorization):
    source = source.resolve();destination = destination.absolute();bundle = bundle.resolve()
    approved_parent = APPROVED_PARENT
    if source.parent != approved_parent or destination.parent != approved_parent:
        raise ValueError("Outside approved OCR runtime directory")
    if not re.fullmatch(r"core-learning-runtime-[a-z0-9-]+", destination.name):
        raise ValueError("Invalid new runtime name")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Runtime already exists; will not overwrite/reset")
    if len(authorization.strip()) < 20:
        raise ValueError("Explicit authorization record is required")
    raw = (bundle / "patch-manifest.json").read_bytes()
    if sha(raw) != manifest_sha:
        raise ValueError("Patch manifest checksum differs")
    manifest = json.loads(raw)
    if manifest["version"] != "learning-ocr-resource-v1":
        raise ValueError("Unsupported patch version")
    for relative, expected in manifest["base_runtime_hashes"].items():
        file = (source / relative).resolve()
        if not file.is_relative_to(source) or sha(file.read_bytes()) != expected:
            raise ValueError("Original runtime differs: " + relative)
    for relative, entry in manifest["patches"].items():
        file = (bundle / relative).resolve()
        if not file.is_relative_to(bundle) or sha(file.read_bytes()) != entry["sha256"]:
            raise ValueError("Patch checksum differs: " + relative)
    # Verify dependency/model anchors as well as the files copied below.
    old_integrity = json.loads((source / "evidence/launch-integrity.json").read_bytes())
    for entry in old_integrity["files"]:
        if sha(pathlib.Path(entry["path"]).read_bytes()) != entry["sha256"]:
            raise ValueError("Existing integrity mismatch: " + pathlib.Path(entry["path"]).name)
    saved = {}
    for name in ["budget.json", "start-attempts.jsonl", "business-ledger.jsonl", "launch-integrity.json"]:
        file = source / "evidence" / name
        saved[name] = file.read_bytes() if file.exists() else None
    destination.mkdir(mode=0o700)
    for folder in ["evidence", "private", "outputs", "logs", "scripts", "configs", "adapter"]:
        (destination / folder).mkdir(mode=0o700)
    for folder in ["scripts", "configs", "adapter"]:
        for file in (source / folder).iterdir():
            if file.is_file() and not file.is_symlink():
                shutil.copyfile(file, destination / folder / file.name)
    (destination / "cache").symlink_to(source / "cache", target_is_directory=True)
    for relative in manifest["patches"]:
        shutil.copyfile(bundle / relative, destination / relative)
    plan = json.loads((source / "evidence/frozen-plan.json").read_bytes())
    plan.update(manifest["plan_changes"])
    # Avoid misleading obsolete numeric settings in the new policy only.
    plan.pop("minimum_free_mib", None);plan.pop("max_combined_gpu_mib", None);plan.pop("preflight_free_mib", None)
    (destination / "evidence/frozen-plan.json").write_text(json.dumps(plan, indent=2))
    shutil.copyfile(source / "evidence/adapter-source.json", destination / "evidence/adapter-source.json")
    (destination / "evidence/budget.json").write_text(json.dumps({"starts": 0, "pages": 0, "http": 0}))
    receipt = {"version": manifest["version"], "source": str(source), "destination": str(destination),
               "patch_manifest_sha256": manifest_sha, "authorization": authorization,
               "parent_integrity_revision": old_integrity["revision"], "model_or_dependency_changed": False,
               "old_ledger_sha256": {k: sha(v) if v is not None else None for k, v in saved.items()},
               "global_lock_changed": False, "copied_private_key": False, "started": False}
    (destination / "evidence/runtime-authorization.json").write_text(json.dumps(receipt, indent=2))
    # Keep ALL old dependency/runtime evidence anchors, append the new reviewed files.
    integrity = dict(old_integrity);integrity["files"] = list(old_integrity["files"])
    for folder in ["scripts", "configs", "adapter", "evidence"]:
        for file in (destination / folder).iterdir():
            if file.is_file() and file.name != "budget.json":
                integrity["files"].append({"path": str(file), "sha256": sha(file.read_bytes())})
    integrity["revision"] = old_integrity["revision"] + "-" + destination.name
    (destination / "evidence/launch-integrity.json").write_text(json.dumps(integrity, indent=2))
    for name, before in saved.items():
        file = source / "evidence" / name
        if (file.read_bytes() if file.exists() else None) != before:
            raise ValueError("Original evidence changed during installation; do not start")
    for entry in integrity["files"]:
        if sha(pathlib.Path(entry["path"]).read_bytes()) != entry["sha256"]:
            raise ValueError("New integrity mismatch; do not start")
    return {**receipt, "integrity_revision": integrity["revision"], "old_evidence_unchanged": True, "integrity": "PASS"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--destination", type=pathlib.Path, required=True)
    parser.add_argument("--bundle", type=pathlib.Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--authorization", required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.source, args.destination, args.bundle, args.manifest_sha256, args.authorization)))
