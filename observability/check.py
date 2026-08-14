#!/usr/bin/env python3
"""Syntax-check every PromQL expression in the alerts and dashboards.

A dashboard panel querying a malformed or renamed metric renders as "No data"
rather than raising an error, which is indistinguishable at a glance from "the
system is quiet". Review time is the only reliable moment to catch it, so this
runs in CI.

Requires `promtool` (ships with Prometheus).

    python observability/check.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).parent
ALERTS = ROOT / "prometheus" / "alerts.yaml"
DASHBOARDS = ROOT / "grafana" / "dashboards"

# Grafana template variables are not valid PromQL; substitute concrete values
# so promtool sees the same query shape Grafana will send.
SUBSTITUTIONS = {
    "$namespace": "support",
    "$pod": "example-pod",
    "$__range": "1h",
    "$__rate_interval": "5m",
    "$__interval": "1m",
}


def substitute(expr: str) -> str:
    for variable, value in SUBSTITUTIONS.items():
        expr = expr.replace(variable, value)
    return expr


def check_alerts() -> tuple[int, list[str]]:
    document = yaml.safe_load(ALERTS.read_text())
    groups = document["spec"]["groups"]

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
        yaml.safe_dump({"groups": groups}, handle)
        path = handle.name

    result = subprocess.run(
        ["promtool", "check", "rules", path], capture_output=True, text=True
    )
    Path(path).unlink()

    count = sum(len(group["rules"]) for group in groups)
    if result.returncode != 0:
        return count, [result.stdout + result.stderr]
    return count, []


def check_dashboards() -> tuple[int, list[str]]:
    rules: list[dict[str, str]] = []
    origins: dict[str, str] = {}

    for path in sorted(DASHBOARDS.glob("*.json")):
        dashboard = json.loads(path.read_text())
        for panel in dashboard.get("panels", []):
            for index, target in enumerate(panel.get("targets", [])):
                expr = target.get("expr")
                if not expr:
                    continue
                name = re.sub(r"\W", "_", f"check_{path.stem}_{panel['id']}_{index}")
                rules.append({"record": name, "expr": substitute(expr)})
                origins[name] = f"{path.name} panel {panel['id']} ({panel.get('title', '?')})"

    if not rules:
        return 0, ["no dashboard queries found — did the JSON structure change?"]

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as handle:
        yaml.safe_dump({"groups": [{"name": "dashboards", "rules": rules}]}, handle)
        path_name = handle.name

    result = subprocess.run(
        ["promtool", "check", "rules", path_name], capture_output=True, text=True
    )
    Path(path_name).unlink()

    if result.returncode != 0:
        output = result.stdout + result.stderr
        # Map the generated rule name back to the panel it came from, so the
        # failure names something a human can open.
        for name, origin in origins.items():
            output = output.replace(name, origin)
        return len(rules), [output]

    return len(rules), []


def main() -> int:
    if shutil.which("promtool") is None:
        print("error: promtool not found (install Prometheus)", file=sys.stderr)
        return 2

    failures: list[str] = []

    alert_count, alert_errors = check_alerts()
    failures.extend(alert_errors)
    print(f"alert rules:       {alert_count} checked")

    query_count, query_errors = check_dashboards()
    failures.extend(query_errors)
    print(f"dashboard queries: {query_count} checked")

    for path in sorted(DASHBOARDS.glob("*.json")):
        try:
            dashboard = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            failures.append(f"{path.name}: invalid JSON — {exc}")
            continue
        if not dashboard.get("uid"):
            failures.append(f"{path.name}: missing uid (needed for stable links)")
        if not dashboard.get("title"):
            failures.append(f"{path.name}: missing title")

    if failures:
        print("\nFAILED", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    print("\nall PromQL valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
