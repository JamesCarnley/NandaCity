#!/usr/bin/env python3
"""Bounded adapter around the pinned native Nanda Town receipt verifier."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import json
import math
import sys
from pathlib import Path
from typing import Any


PROFILE = "city-a2a-protocol@0.1"
PROFILE_FINGERPRINT = "sha256:e6a1cc01584de3547a76ddc3b2bbac6d366258bc8603a26a1dad2ebd5c5212cc"
CAPABILITY = "city-a2a-structured-task"
PROFILE_EVALUATOR = "city-a2a-protocol-evaluator@0.1"
RESULT_EVALUATOR = "path-city-a2a-protocol-0.1"
TOWN_VERSION = "0.2.0"
PYTHON_VERSION = "3.12.13"
INSPECTED_BASE = "17fbc7902be49683aee5f7610a0a1dcf8c803b3e"
VECTOR = "sha256:2d16426c2bd13fc15ea6b8dbd19772f8e6a2adfff0d73b19d7448c0b319bb6b6"
FILES = (
    "profile.json", "run.json", "intents.jsonl", "events.jsonl",
    "result.json", "manifest.json", "attestation.json", "receipt.json",
)
FILE_LIMITS = {name: 65_536 for name in FILES}
FILE_LIMITS["events.jsonl"] = 7_864_320
TOTAL_LIMIT = 8_388_608
NODE_LIMIT = 100_000
STAGES = ("pinned_card", "structured_send", "acceptance_task", "exact_retry", "terminal_task")
LIMITATIONS = [
    "Synthetic same-host observer selected by demo policy; not independent operators or official Town accreditation.",
    "Protocol shape and one exact retry only; not Ethereum authorization, EIP-712 validity, or ownership verification.",
    "No certification of truthful venues, answer quality, or semantic task success.",
    "One observed retry is not global exactly-once execution.",
    "Replay evaluates retained observer records, not an independent rerun or proof the observer told the truth.",
]


class Rejected(Exception):
    pass


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("nonfinite")
    return result


def _pairs(values: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in values:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result


def _parse_json(raw: bytes) -> Any:
    try:
        return json.loads(
            raw.decode("utf-8"), object_pairs_hook=_pairs,
            parse_float=_finite_float,
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("nonfinite")),
        )
    except (UnicodeError, ValueError, RecursionError):
        raise Rejected() from None


def _charge(value: Any, state: list[int], depth: int = 0) -> None:
    state[0] += 1
    if state[0] > NODE_LIMIT:
        raise Rejected()
    if isinstance(value, (dict, list)):
        if depth >= 32:
            raise Rejected()
        children = list(value.items()) if isinstance(value, dict) else value
        if isinstance(value, dict):
            for key, item in children:
                _charge(key, state, depth + 1)
                _charge(item, state, depth + 1)
        else:
            for item in children:
                _charge(item, state, depth + 1)


def _strict_documents(bundle: Path) -> dict[str, Any]:
    raw: dict[str, bytes] = {}
    total = 0
    for name in FILES:
        path = bundle / name
        try:
            content = path.read_bytes()
        except OSError:
            raise Rejected() from None
        if len(content) > FILE_LIMITS[name]:
            raise Rejected()
        total += len(content)
        if total > TOTAL_LIMIT:
            raise Rejected()
        raw[name] = content
    state = [0]
    parsed: dict[str, Any] = {}
    for name in FILES:
        if name.endswith(".jsonl"):
            records = [_parse_json(line) for line in raw[name].split(b"\n") if line]
            if name == "events.jsonl" and len(records) > 32:
                raise Rejected()
            if name == "intents.jsonl" and records:
                raise Rejected()
            value: Any = records
        else:
            value = _parse_json(raw[name])
        _charge(value, state)
        parsed[name] = value
    return parsed


def _town(town_src: Path):
    source = town_src.resolve(strict=True)
    if not source.is_absolute() or source != town_src:
        raise Rejected()
    sys.path.insert(0, str(source))
    package = importlib.import_module("nandatown")
    package_file = Path(package.__file__).resolve(strict=True)
    if not package_file.is_relative_to(source / "nandatown"):
        raise Rejected()
    records = importlib.import_module("nandatown.records")
    receipt = importlib.import_module("nandatown.receipt")
    bundle = importlib.import_module("nandatown.bundle")
    return package, records, receipt, bundle


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise Rejected()
    return value


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise Rejected()
    return value


def _canonical_base64(value: Any) -> bytes:
    text = _text(value)
    try:
        raw = base64.b64decode(text, validate=True)
    except (ValueError, base64.binascii.Error):
        raise Rejected() from None
    if base64.b64encode(raw).decode("ascii") != text:
        raise Rejected()
    return raw


def _sha256(raw: bytes) -> str:
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _verify(town_src: Path, bundle_path: Path) -> dict[str, Any]:
    package, records, receipt_module, bundle_module = _town(town_src)
    bundle = bundle_path.resolve(strict=True)
    if bundle != bundle_path or not bundle.is_dir():
        raise Rejected()
    parsed = _strict_documents(bundle)

    receipt_problems = receipt_module.verify_receipt(bundle / "receipt.json", bundle)
    bundle_problems = bundle_module.verify_bundle(bundle)
    if receipt_problems or bundle_problems:
        raise Rejected()

    profile = _mapping(parsed["profile.json"])
    run = _mapping(parsed["run.json"])
    events = parsed["events.jsonl"]
    result = _mapping(parsed["result.json"])
    manifest = _mapping(parsed["manifest.json"])
    receipt = _mapping(parsed["receipt.json"])
    payload = _mapping(receipt.get("payload"))
    claim = _mapping(payload.get("claim"))
    release_basis = _mapping(claim.get("release_basis"))
    window = _mapping(payload.get("window"))
    coverage = _mapping(payload.get("coverage"))
    evidence = _mapping(payload.get("evidence"))
    releases = _mapping(run.get("releases"))
    config = _mapping(run.get("config"))
    if not isinstance(events, list) or not events:
        raise Rejected()
    first = _mapping(events[0])
    detail = _mapping(first.get("detail"))

    source_files = {
        name: _sha256((town_src / "nandatown" / name).read_bytes())
        for name in ("city_path.py", "path_profiles.py", "path_runner.py")
    }
    if config.get("source_files") != source_files:
        raise Rejected()
    source_fingerprint = records.fingerprint(source_files)
    if releases.get("city_observer_sources") != source_fingerprint:
        raise Rejected()

    card = _canonical_base64(detail.get("pinned_card_base64"))
    request = _canonical_base64(detail.get("request_base64"))
    parsed_card = _parse_json(card)
    card_fingerprint = records.fingerprint(parsed_card)
    card_sha256 = _sha256(card)
    subject = _text(config.get("subject"))
    card_url = _text(config.get("card_url"))

    bindings = (
        getattr(package, "__version__", None) == TOWN_VERSION,
        manifest.get("nandatown_version") == TOWN_VERSION,
        releases.get("nandatown") == TOWN_VERSION,
        releases.get("python") == PYTHON_VERSION,
        releases.get("town_source_base") == INSPECTED_BASE,
        run.get("profile_name") == PROFILE,
        run.get("profile_fingerprint") == PROFILE_FINGERPRINT,
        profile.get("profile_id") == "city-a2a-protocol",
        profile.get("version") == "0.1",
        profile.get("capability") == CAPABILITY,
        profile.get("evaluator") == PROFILE_EVALUATOR,
        result.get("evaluator_version") == RESULT_EVALUATOR,
        manifest.get("evaluator_version") == RESULT_EVALUATOR,
        claim.get("profile") == PROFILE,
        claim.get("capability") == CAPABILITY,
        release_basis.get("profile_fingerprint") == PROFILE_FINGERPRINT,
        release_basis.get("card_digest") == card_fingerprint,
        config.get("pinned_card_digest") == card_fingerprint,
        config.get("pinned_card_bytes_sha256") == card_sha256,
        config.get("synthetic") is True,
        config.get("limitations") == LIMITATIONS,
        payload.get("limitations") == LIMITATIONS,
        claim.get("subject") == subject,
        first.get("kind") == "city_run",
        first.get("subject") == subject,
        detail.get("subject_url") == subject,
        detail.get("card_url") == card_url,
    )
    if not all(bindings):
        raise Rejected()

    stages = result.get("stages")
    if not isinstance(stages, list):
        raise Rejected()
    safe_stages = []
    for stage in stages:
        item = _mapping(stage)
        name = _text(item.get("name"))
        status = item.get("status")
        if status not in {"passed", "failed", "not_enough_evidence", "not_tested", "error"}:
            raise Rejected()
        safe_stages.append({"name": name, "status": status})

    return {
        "town": {
            "version": TOWN_VERSION, "declaredPython": PYTHON_VERSION,
            "inspectedBase": INSPECTED_BASE, "observerSourceFingerprint": source_fingerprint,
        },
        "receipt": {
            "observer": _text(payload.get("observer")), "capability": CAPABILITY,
            "subject": subject, "profile": PROFILE, "verdict": claim.get("verdict"),
            "profileFingerprint": PROFILE_FINGERPRINT,
            "parsedCardSha256": card_fingerprint,
            "started": window.get("started"), "evaluated": window.get("evaluated"),
            "tested": coverage.get("tested"), "notTested": coverage.get("not_tested"),
            "limitations": payload.get("limitations"),
            "bundleFingerprint": evidence.get("bundle_fingerprint"),
            "resultDigest": evidence.get("result_digest"), "runId": evidence.get("run_id"),
        },
        "observation": {
            "subjectUrl": subject, "cardUrl": card_url,
            "cardBase64": base64.b64encode(card).decode("ascii"),
            "requestRpcBase64": base64.b64encode(request).decode("ascii"),
            "cardBytesSha256": card_sha256, "parsedCardSha256": card_fingerprint,
        },
        "result": {"profileEvaluator": PROFILE_EVALUATOR,
                   "evaluator": RESULT_EVALUATOR, "stages": safe_stages},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    subparsers = parser.add_subparsers(dest="mode", required=True)
    verify = subparsers.add_parser("verify", add_help=False)
    verify.add_argument("--town-src", required=True)
    verify.add_argument("--bundle", required=True)
    vector = subparsers.add_parser("fingerprint-vector", add_help=False)
    vector.add_argument("--town-src", required=True)
    try:
        args = parser.parse_args(argv)
        town_src = Path(args.town_src)
        if args.mode == "fingerprint-vector":
            _package, records, _receipt, _bundle = _town(town_src)
            fingerprint = records.fingerprint({
                "fraction": 1e-7, "integral_float": 1.0,
                "negative_zero": -0.0, "unicode": "é\u2028",
            })
            if fingerprint != VECTOR:
                raise Rejected()
            output: Any = {"fingerprint": fingerprint}
        else:
            output = _verify(town_src, Path(args.bundle))
        print(json.dumps(output, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":"), sort_keys=True))
        return 0
    except (Rejected, OSError, ImportError, AttributeError, TypeError, KeyError, ValueError):
        print("Town evidence rejected", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
