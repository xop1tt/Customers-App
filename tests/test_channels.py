"""Разделение Stable и Debug/Beta: проверка release-check.cjs на настоящих файлах и на испорченных копиях.

Каждая порча — реальная ошибка конфигурации, при которой Beta могла бы задеть Stable или Stable собралась бы с
отладочными возможностями; скрипт обязан её найти. Без Node тест падает, а не пропускается: проверка обязательна.
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

DESKTOP = Path(__file__).resolve().parents[1] / "desktop"
FILES = [
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/tauri.beta.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/src/channel.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/debug/commands.rs",
    "src-tauri/src/cloud/config.rs",
    "installer/Customers.iss",
    "scripts/release-check.cjs",
]


def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    assert node, "нужен Node.js: release-check.cjs — обязательная проверка"
    return subprocess.run([node, str(root / "scripts/release-check.cjs"), *args], capture_output=True, text=True, timeout=60)


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    for f in FILES:
        (tmp_path / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DESKTOP / f, tmp_path / f)
    return tmp_path


def edit(root: Path, name: str, fn):
    p = root / name
    p.write_text(fn(p.read_text(encoding="utf-8-sig")), encoding="utf-8")


def edit_json(root: Path, name: str, fn):
    p = root / name
    data = json.loads(p.read_text(encoding="utf-8"))
    fn(data)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_real_project_passes():
    r = run(DESKTOP)
    assert r.returncode == 0, r.stdout + r.stderr


def test_tag_must_match_version():
    version = json.loads((DESKTOP / "package.json").read_text())["version"]
    assert run(DESKTOP, "--tag", f"v{version}").returncode == 0
    assert run(DESKTOP, "--tag", "v99.0.0").returncode == 1
    assert run(DESKTOP, "--tag", "v1.2").returncode == 1


def test_untouched_copy_passes(copy):
    assert run(copy).returncode == 0


BREAKAGES = {
    "версии расходятся": lambda r: edit_json(r, "package.json", lambda d: d.update(version="9.9.9")),
    "Beta с идентификатором Stable": lambda r: edit_json(r, "src-tauri/tauri.beta.conf.json", lambda d: d.update(identifier="local.leadgenerator.app")),
    "Stable с новым идентификатором": lambda r: edit_json(r, "src-tauri/tauri.conf.json", lambda d: d.update(identifier="local.customers.app")),
    "Beta со ссылками Stable": lambda r: edit_json(
        r, "src-tauri/tauri.beta.conf.json", lambda d: d["plugins"]["deep-link"]["desktop"].update(schemes=["leadgenerator"])
    ),
    "Beta с именем файла Stable": lambda r: edit_json(r, "src-tauri/tauri.beta.conf.json", lambda d: d.update(mainBinaryName="customers")),
    "Beta со своей версией": lambda r: edit_json(r, "src-tauri/tauri.beta.conf.json", lambda d: d.update(version="0.0.1")),
    "beta по умолчанию": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t.replace("\nbeta = [", "\ndefault = [\"beta\"]\nbeta = [")),
    "beta включает другой признак": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t.replace('beta = ["dep:sysinfo"]', 'beta = ["dep:sysinfo", "tauri/devtools"]')),
    "зависимость Debug Menu попадает в Stable": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t.replace('features = ["system"], optional = true }', 'features = ["system"] }')),
    "devtools в Stable": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t.replace('features = ["tray-icon"', 'features = ["devtools", "tray-icon"')),
    "общий AppId установщика": lambda r: edit(r, "installer/Customers.iss", lambda t: t.replace("A3E4C2B8-5D71-4F0A-9C36-2B8E7D51F4A9", "6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30")),
    "облако Beta = облако Stable": lambda r: edit(r, "src-tauri/src/cloud/config.rs", lambda t: t.replace("SUPABASE_BETA_", "SUPABASE_")),
    "идентификатор в channel.rs расходится с конфигурацией": lambda r: edit(
        r, "src-tauri/src/channel.rs", lambda t: t.replace('identifier: "local.customers.beta"', 'identifier: "local.customers.beta2"')
    ),
    "service_role в клиенте": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + '\nconst K: &str = "SUPABASE_SERVICE_ROLE_KEY";\n'),
    "секретный ключ в клиенте": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + '\nconst K: &str = "sb_secret_abcdefgh123";\n'),
    "команда Debug Menu не зарегистрирована": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t.replace("        debug_set_window_size,\n", "")),
    "команда Debug Menu без префикса": lambda r: edit(
        r, "src-tauri/src/debug/commands.rs", lambda t: t + "\n#[tauri::command]\npub fn reset_everything() {}\n"
    ),
    "команда Debug Menu в обработчике Stable": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t.replace("        commands::whats_new,\n", "        commands::whats_new,\n        debug_logs,\n")),
    "Debug-модуль без cfg(beta)": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t.replace('#[cfg(feature = "beta")]\npub mod debug;', "pub mod debug;")),
}


@pytest.mark.parametrize("name", list(BREAKAGES))
def test_each_breakage_is_caught(copy, name):
    BREAKAGES[name](copy)
    r = run(copy)
    assert r.returncode == 1, f"{name}: не найдено\n{r.stdout}"
    assert "✗" in r.stderr


def test_debug_module_is_behind_cfg_in_the_project():
    lib = (DESKTOP / "src-tauri/src/lib.rs").read_text(encoding="utf-8")
    assert '#[cfg(feature = "beta")]\npub mod debug;' in lib
    assert lib.count("pub mod debug;") == 1


def test_set_version_accepts_beta_and_rejects_garbage(tmp_path):
    for f in ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "scripts/set-version.cjs"]:
        (tmp_path / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DESKTOP / f, tmp_path / f)
    node = shutil.which("node")
    ok = subprocess.run([node, str(tmp_path / "scripts/set-version.cjs"), "1.3.0-beta.2"], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    assert json.loads((tmp_path / "package.json").read_text())["version"] == "1.3.0-beta.2"
    assert re.search(r'\[package\][^[]*?\nversion = "1\.3\.0-beta\.2"', (tmp_path / "src-tauri/Cargo.toml").read_text())
    for bad in ["1.3", "1.3.0-rc.1", "1.3.0-beta", "v1.3.0"]:
        assert subprocess.run([node, str(tmp_path / "scripts/set-version.cjs"), bad], capture_output=True).returncode == 1, bad
