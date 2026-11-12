"""Приёмочные проверки (docs/E2E.md): workflow, изоляция признака e2e от релиза, сценарии и эталоны."""
import json
import re
import shutil
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
E2E = ROOT / "desktop" / "e2e"
WF = ROOT / ".github" / "workflows"
TAURI = ROOT / "desktop" / "src-tauri"


def scenario_ids() -> list[str]:
    ids: list[str] = []
    for f in sorted((E2E / "scenarios").glob("*.js")):
        ids += re.findall(r'scenario\("([a-z0-9-]+)"', f.read_text(encoding="utf-8"))
    return ids


def test_workflow_structure():
    wf = yaml.safe_load((WF / "e2e.yml").read_text(encoding="utf-8"))
    triggers = wf.get(True) or wf.get("on")
    assert {"pull_request", "push", "schedule", "workflow_dispatch"} <= set(triggers)
    assert wf["permissions"] == {"contents": "read"}
    job = wf["jobs"]["e2e"]
    systems = {m["os"].split("-")[0] for m in job["strategy"]["matrix"]["include"]}
    assert systems == {"macos", "windows"}
    text = (WF / "e2e.yml").read_text(encoding="utf-8")
    assert "--cfg e2e" in text and "secrets." not in text
    assert wf["jobs"]["gate"]["needs"] == ["changes", "e2e"]


def test_release_builds_do_not_contain_e2e():
    for name in ("release.yml", "desktop.yml"):
        assert "e2e" not in (WF / name).read_text(encoding="utf-8").lower(), name
    cargo = (TAURI / "Cargo.toml").read_text(encoding="utf-8")
    assert "[features]" not in cargo, "раздел [features] запрещён (ADR-034): e2e включается флагом --cfg e2e"
    assert 'check-cfg = ["cfg(e2e)"]' in cargo
    assert not (TAURI / ".cargo" / "config.toml").exists()


def test_e2e_code_is_behind_the_feature():
    lib = (TAURI / "src" / "lib.rs").read_text(encoding="utf-8")
    assert re.search(r'#\[cfg\(e2e\)\]\s*pub mod e2e;', lib)
    shell = (TAURI / "src" / "shell.rs").read_text(encoding="utf-8")
    uses = [m.start() for m in re.finditer(r"crate::e2e::", shell)]
    assert uses
    for pos in uses:
        before = shell[max(0, pos - 200):pos]
        assert "cfg(e2e)" in before, "вызов e2e в shell.rs без cfg(e2e)"


def test_scenarios_are_unique_and_valid_javascript():
    ids = scenario_ids()
    assert len(ids) >= 40
    assert len(ids) == len(set(ids)), "повторяющиеся идентификаторы сценариев"
    node = shutil.which("node")
    assert node, "нужен Node.js"
    files = [*(E2E / "scenarios").glob("*.js"), E2E / "lib.js", E2E / "run.cjs", E2E / "verify.cjs", E2E / "mock-server.cjs"]
    for f in files:
        r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, f"{f.name}: {r.stderr}"


def test_golden_files_exist_and_parse():
    golden = E2E / "golden"
    for f in golden.glob("*.json"):
        json.loads(f.read_text(encoding="utf-8"))
    for name in ("companies.golden.txt", "deals-en.golden.txt", "received.json", "crm.json", "search.json"):
        assert (golden / name).is_file(), name


def test_every_scenario_is_documented():
    doc = (ROOT / "docs" / "E2E.md").read_text(encoding="utf-8")
    missing = [i for i in scenario_ids() if f"`{i}`" not in doc]
    assert not missing, f"нет в матрице docs/E2E.md: {missing}"
