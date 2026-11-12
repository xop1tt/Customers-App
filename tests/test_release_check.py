"""Готовность сборки: проверка release-check.cjs на настоящих файлах и на испорченных копиях.

Канал один (ADR-034). Каждая порча — реальная ошибка: изменённая идентичность потеряла бы данные, ключи или
обновления пользователей; вернувшиеся Beta-сборка, Debug Menu или devtools попали бы в релиз; ключ сервера
Supabase попал бы в клиент. Скрипт обязан найти каждую. Без Node тест падает, а не пропускается.
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
    "src-tauri/Cargo.toml",
    "src-tauri/src/identity.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/cloud/config.rs",
    "installer/Customers.iss",
    "scripts/release-check.cjs",
]
STABLE_GUID = "6B0F7C1E-3A52-4C58-9E41-5B7D2A9C1F30"


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
    before = p.read_text(encoding="utf-8-sig")
    after = fn(before)
    assert after != before, f"{name}: порча не применилась (изменился исходный файл?)"
    p.write_text(after, encoding="utf-8")


def edit_json(root: Path, name: str, fn):
    p = root / name
    data = json.loads(p.read_text(encoding="utf-8"))
    fn(data)
    p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def add_file(root: Path, name: str, text: str = ""):
    (root / name).parent.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(text, encoding="utf-8")


def test_real_project_passes():
    r = run(DESKTOP)
    assert r.returncode == 0, r.stdout + r.stderr


def test_tag_must_match_version_and_have_no_suffix():
    version = json.loads((DESKTOP / "package.json").read_text())["version"]
    assert run(DESKTOP, "--tag", f"v{version}").returncode == 0
    assert run(DESKTOP, "--tag", "v99.0.0").returncode == 1
    assert run(DESKTOP, "--tag", "v1.2").returncode == 1
    # Предварительных версий нет: тег с суффиксом не проходит даже при совпадении версии.
    assert run(DESKTOP, "--tag", f"v{version}-beta.1").returncode == 1


def test_untouched_copy_passes(copy):
    r = run(copy)
    assert r.returncode == 0, r.stdout + r.stderr


BREAKAGES = {
    "версии расходятся": lambda r: edit_json(r, "package.json", lambda d: d.update(version="9.9.9")),
    "предварительная версия в файлах": lambda r: [
        edit_json(r, f, lambda d: d.update(version="1.3.0-beta.1")) for f in ("package.json", "src-tauri/tauri.conf.json")
    ]
    and edit(r, "src-tauri/Cargo.toml", lambda t: re.sub(r'(\[package\][^[]*?\nversion\s*=\s*")[^"]+', r"\g<1>1.3.0-beta.1", t)),
    "новый идентификатор в конфигурации": lambda r: edit_json(r, "src-tauri/tauri.conf.json", lambda d: d.update(identifier="local.customers.app")),
    "идентификатор в identity.rs расходится с конфигурацией": lambda r: edit(
        r, "src-tauri/src/identity.rs", lambda t: t.replace('identifier: "local.leadgenerator.app"', 'identifier: "local.customers.app"', 1)
    ),
    "новое имя приложения": lambda r: edit_json(r, "src-tauri/tauri.conf.json", lambda d: d.update(productName="Customers CRM")),
    "новая схема ссылок": lambda r: edit_json(
        r, "src-tauri/tauri.conf.json", lambda d: d["plugins"]["deep-link"]["desktop"].update(schemes=["customers"])
    ),
    "новое имя исполняемого файла": lambda r: edit_json(r, "src-tauri/tauri.conf.json", lambda d: d.update(mainBinaryName="customers-crm")),
    "вернулась конфигурация Beta": lambda r: add_file(r, "src-tauri/tauri.beta.conf.json", '{"identifier": "local.customers.beta"}'),
    "вернулся признак beta": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t + '\n[features]\nbeta = []\n'),
    "devtools в релизе": lambda r: edit(r, "src-tauri/Cargo.toml", lambda t: t.replace('features = ["tray-icon"', 'features = ["devtools", "tray-icon"')),
    "вернулся модуль debug": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + "\npub mod debug;\n"),
    "вернулась папка Debug Menu": lambda r: add_file(r, "src/debug/DebugMenu.tsx", "export {};\n"),
    "команда debug_* в обработчике": lambda r: edit(
        r, "src-tauri/src/lib.rs", lambda t: t.replace("        commands::whats_new,\n", "        commands::whats_new,\n        debug_logs,\n")
    ),
    "второй обработчик команд": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + "\nfn other() { let _ = tauri::generate_handler![x,]; }\n"),
    "новый AppId установщика": lambda r: edit(r, "installer/Customers.iss", lambda t: t.replace(STABLE_GUID, "A3E4C2B8-5D71-4F0A-9C36-2B8E7D51F4A9")),
    "вернулся вариант Beta в установщике": lambda r: edit(
        r, "installer/Customers.iss", lambda t: t.replace('#define AppName "Customers"', '#ifdef Beta\n#endif\n#define AppName "Customers"')
    ),
    "новое имя exe в установщике": lambda r: edit(r, "installer/Customers.iss", lambda t: t.replace('"Customers.exe"', '"Customers CRM.exe"')),
    "вернулось облако Beta": lambda r: edit(r, "src-tauri/src/cloud/config.rs", lambda t: t + '\nconst B: &str = "SUPABASE_BETA_URL";\n'),
    "service_role в клиенте": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + '\nconst K: &str = "SUPABASE_SERVICE_ROLE_KEY";\n'),
    "секретный ключ в клиенте": lambda r: edit(r, "src-tauri/src/lib.rs", lambda t: t + '\nconst K: &str = "sb_secret_abcdefgh123";\n'),
}


@pytest.mark.parametrize("name", list(BREAKAGES))
def test_each_breakage_is_caught(copy, name):
    BREAKAGES[name](copy)
    r = run(copy)
    assert r.returncode == 1, f"{name}: не найдено\n{r.stdout}"
    assert "✗" in r.stderr


def test_no_beta_or_debug_left_in_the_project():
    assert not (DESKTOP / "src-tauri/tauri.beta.conf.json").exists()
    assert not (DESKTOP / "src-tauri/src/debug").exists() and not (DESKTOP / "src/debug").exists()
    assert not (DESKTOP / "src-tauri/src/channel.rs").exists()
    assert "[features]" not in (DESKTOP / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
    scripts = json.loads((DESKTOP / "package.json").read_text())["scripts"]
    assert not [k for k, v in scripts.items() if "beta" in k or "beta" in v or k.startswith("debug:")], scripts


def test_set_version_accepts_only_release_versions(tmp_path):
    for f in ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "scripts/set-version.cjs"]:
        (tmp_path / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DESKTOP / f, tmp_path / f)
    node = shutil.which("node")
    for good in ["1.3.0", "1.3.0.1"]:
        ok = subprocess.run([node, str(tmp_path / "scripts/set-version.cjs"), good], capture_output=True, text=True)
        assert ok.returncode == 0, ok.stderr
        assert json.loads((tmp_path / "package.json").read_text())["version"] == good
        assert json.loads((tmp_path / "src-tauri/tauri.conf.json").read_text())["version"] == good
        assert re.search(rf'\[package\][^[]*?\nversion = "{re.escape(good)}"', (tmp_path / "src-tauri/Cargo.toml").read_text())
    for bad in ["1.3", "1.3.0-rc.1", "1.3.0-beta.1", "1.3.0-beta", "v1.3.0", ""]:
        assert subprocess.run([node, str(tmp_path / "scripts/set-version.cjs"), bad], capture_output=True).returncode == 1, bad
