"""Статический аудит GitHub Actions: закреплённые SHA, минимальные права, защита от параллельных запусков."""
import re
from pathlib import Path

import yaml

WF = Path(__file__).resolve().parents[1] / ".github" / "workflows"


def load(name):
    return yaml.safe_load((WF / name).read_text(encoding="utf-8"))


def test_actions_pinned_by_full_sha():
    for f in WF.glob("*.yml"):
        for line in f.read_text(encoding="utf-8").splitlines():
            if "uses:" in line:
                ref = line.split("uses:")[1].split("#")[0].strip()
                assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), f"{f.name}: {ref}"


def test_minimal_permissions_everywhere():
    for f in WF.glob("*.yml"):
        assert yaml.safe_load(f.read_text(encoding="utf-8"))["permissions"] == {"contents": "read"}, f.name


def test_tests_workflow_has_no_secrets_and_no_pull_request_target():
    text = (WF / "tests.yml").read_text(encoding="utf-8")
    assert "secrets." not in text and "pull_request_target" not in text


def test_inputs_not_interpolated_into_shell():
    for f in WF.glob("*.yml"):
        wf = yaml.safe_load(f.read_text(encoding="utf-8"))
        for job in wf["jobs"].values():
            for step in job["steps"]:
                assert "${{ inputs." not in step.get("run", ""), f"{f.name}: inputs в run — риск инъекции"


def test_no_data_files_tracked():
    gi = (WF.parents[1] / ".gitignore").read_text()
    for pattern in ("state/", "*.db", "*.csv", ".env"):
        assert pattern in gi


def test_automerge_only_for_dependabot_patch_minor_without_checkout():
    text = (WF / "dependabot-automerge.yml").read_text(encoding="utf-8")
    assert "dependabot[bot]" in text and "semver-patch" in text and "semver-minor" in text
    assert "semver-major" not in text and "actions/checkout" not in text


def test_elevated_permissions_only_in_expected_jobs():
    allowed = {"release.yml": {"publish"}, "dependabot-automerge.yml": {"automerge"}, "wiki.yml": {"publish"},
               # CodeQL загружает результаты во вкладку Security.
               "codeql.yml": {"analyze"},
               }
    for f in WF.glob("*.yml"):
        wf = yaml.safe_load(f.read_text(encoding="utf-8"))
        for name, job in wf["jobs"].items():
            if "permissions" in job:
                assert name in allowed.get(f.name, set()), f"{f.name}:{name} повышает права"


def test_wiki_publishes_only_from_main():
    wf = load("wiki.yml")
    on = wf[True]
    assert set(on) == {"push", "workflow_dispatch"}
    assert on["push"]["branches"] == ["main"]
    assert wf["jobs"]["publish"]["permissions"] == {"contents": "write"}


def test_codeql_runs_on_pull_requests_without_swift():
    # Приложение целиком на Rust и TypeScript: анализ быстрый и идёт в каждом PR; Swift-кода в репозитории больше нет.
    fast = load("codeql.yml")
    assert "pull_request" in fast[True] and "pull_request_target" not in fast[True]
    languages = fast["jobs"]["analyze"]["strategy"]["matrix"]["language"]
    assert "swift" not in languages
    assert {"rust", "javascript-typescript"} <= set(languages)


# ---------------------------------------------------------------- CI, Dependabot и автослияние

import json
import os
import shutil
import subprocess

import pytest

ROOT = WF.parents[1]


def test_dependabot_covers_exactly_the_ecosystems_in_use():
    cfg = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8"))
    ecosystems = {u["package-ecosystem"] for u in cfg["updates"]}
    assert ecosystems == {"github-actions", "npm", "cargo", "pip"}
    # Docker, Poetry, uv и т. п. не используются: лишних экосистем быть не должно.
    for banned in ("Dockerfile", "poetry.lock", "uv.lock"):
        assert not list(ROOT.glob(f"**/{banned}")), banned
    by = {u["package-ecosystem"]: u for u in cfg["updates"]}
    assert by["npm"]["directory"] == "/desktop" and (ROOT / "desktop" / "package-lock.json").exists()
    assert by["cargo"]["directory"] == "/desktop/src-tauri" and (ROOT / "desktop" / "src-tauri" / "Cargo.lock").exists()
    for u in cfg["updates"]:
        assert u["open-pull-requests-limit"] <= 5, "число открытых PR ограничено"
        assert u["groups"], "обновления сгруппированы, а не по одному PR на пакет"
        assert any(g.get("applies-to") == "security-updates" for g in u["groups"].values()), "security-обновления сгруппированы отдельно"


def test_tauri_and_crypto_updates_are_grouped_apart_from_automerge_groups():
    cfg = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text(encoding="utf-8"))
    by = {u["package-ecosystem"]: u["groups"] for u in cfg["updates"]}
    assert "update-types" not in by["cargo"]["tauri-rust"] and "tauri" in by["cargo"]["tauri-rust"]["patterns"]
    assert "@tauri-apps/*" in by["npm"]["tauri-js"]["patterns"]
    assert "rusqlite" in by["cargo"]["storage-crypto"]["patterns"]
    # группы с обычными minor/patch идут после tauri и криптографии: туда попадает только остальное
    order = list(by["cargo"])
    assert order.index("tauri-rust") < order.index("cargo") and order.index("storage-crypto") < order.index("cargo")


def _policy_step():
    wf = load("dependabot-automerge.yml")
    return next(s for s in wf["jobs"]["automerge"]["steps"] if s.get("id") == "policy")


def _decide(deps, ecosystem="npm_and_yarn"):
    if not (shutil.which("jq") and shutil.which("bash")):
        pytest.skip("нужны bash и jq")
    out = subprocess.run(
        ["bash", "-c", _policy_step()["run"]],
        env={**os.environ, "METADATA": json.dumps(deps), "ECOSYSTEM": ecosystem, "GITHUB_OUTPUT": "/dev/stdout"},
        capture_output=True, text=True, check=True,
    ).stdout
    return "allowed=true" in out


def dep(name, kind, dev=False, eco=None):
    d = {"dependencyName": name, "updateType": f"version-update:semver-{kind}", "dependencyType": "direct:development" if dev else "direct:production"}
    if eco:
        d["packageEcosystem"] = eco
    return d


@pytest.mark.parametrize(
    "deps,eco,allowed",
    [
        ([dep("zod", "patch")], "npm_and_yarn", True),
        ([dep("serde", "patch", eco="cargo")], "cargo", True),
        ([dep("vitest", "minor", dev=True)], "npm_and_yarn", True),
        ([dep("actions/cache", "minor")], "github_actions", True),
        ([dep("actions/cache", "patch")], "github_actions", True),
        ([dep("react", "minor")], "npm_and_yarn", False),            # production minor — вручную
        ([dep("serde", "minor", eco="cargo")], "cargo", False),
        ([dep("typescript", "minor", dev=True)], "npm_and_yarn", False),
        ([dep("vite", "minor", dev=True)], "npm_and_yarn", False),
        ([dep("tauri", "patch", eco="cargo")], "cargo", False),     # Tauri никогда автоматически
        ([dep("tauri-plugin-dialog", "patch", eco="cargo")], "cargo", False),
        ([dep("@tauri-apps/api", "patch")], "npm_and_yarn", False),
        ([dep("@tauri-apps/cli", "minor", dev=True)], "npm_and_yarn", False),
        ([dep("rusqlite", "patch", eco="cargo")], "cargo", False),   # база и криптография — вручную
        ([dep("sha2", "patch", eco="cargo")], "cargo", False),
        ([dep("foo", "major")], "npm_and_yarn", False),
        ([{"dependencyName": "foo", "updateType": "version-update:semver-unknown", "dependencyType": "direct:production"}], "npm_and_yarn", False),
        ([dep("a", "patch"), dep("tauri", "patch", eco="cargo")], "cargo", False),  # одна запрещённая зависимость запрещает всю группу
        ([dep("a", "patch"), dep("b", "patch")], "npm_and_yarn", True),
        ([], "npm_and_yarn", False),
    ],
)
def test_automerge_policy(deps, eco, allowed):
    assert _decide(deps, eco) is allowed


def test_automerge_workflow_guards():
    wf = load("dependabot-automerge.yml")
    job = wf["jobs"]["automerge"]
    cond = " ".join(job["if"].split())
    for part in ("dependabot[bot]", "head.repo.full_name == github.repository", "draft == false"):
        assert part in cond
    assert set(wf[True]) == {"pull_request_target"} and "run" not in str(wf[True])
    text = (WF / "dependabot-automerge.yml").read_text(encoding="utf-8")
    assert "pull_request.head" not in text.replace("head.repo.full_name", ""), "ветка и код PR не используются"
    # проверка защиты main и условие включения автослияния
    enable = next(s for s in job["steps"] if s.get("name") == "Enable auto-merge")
    assert "steps.policy.outputs.allowed == 'true'" in enable["if"] and "steps.protection.outputs.required == 'true'" in enable["if"]
    assert "--auto" in enable["run"] and "--admin" not in text, "обход защиты ветки не используется"
    # данные PR передаются через env, а не подставляются в команды
    for step in job["steps"]:
        assert "${{" not in step.get("run", ""), f"{step.get('name')}: выражения в run"


def test_pull_request_target_only_in_automerge_and_never_checks_out_pr_code():
    for f in WF.glob("*.yml"):
        text = f.read_text(encoding="utf-8")
        if f.name != "dependabot-automerge.yml":
            assert "pull_request_target" not in text, f.name


def test_required_checks_always_report_on_pull_requests():
    # Фильтр путей на уровне workflow оставил бы обязательную проверку без статуса: PR нельзя было бы слить.
    for name, gate, expect in (("desktop.yml", "Desktop gate", {"changes", "frontend", "rust", "build"}), ("cloud.yml", "Cloud gate", {"changes", "cloud"})):
        wf = load(name)
        assert "paths" not in (wf[True]["pull_request"] or {}), name
        job = wf["jobs"]["gate"]
        assert job["name"] == gate and job["if"] == "always()"
        assert set(job["needs"]) == expect and expect - {"changes"} <= set(wf["jobs"])
        for other in expect - {"changes"}:
            assert "needs.changes.outputs.relevant == 'true'" in wf["jobs"][other]["if"], f"{name}:{other}"


def test_gate_fails_unless_every_job_succeeded_or_was_skipped():
    if not shutil.which("bash"):
        pytest.skip("нужен bash")
    run = load("desktop.yml")["jobs"]["gate"]["steps"][0]["run"]
    def gate(results):
        return subprocess.run(["bash", "-c", run], env={**os.environ, "RESULTS": results}, capture_output=True, text=True).returncode
    assert gate("success success skipped") == 0 and gate("skipped skipped") == 0
    assert gate("success failure") == 1 and gate("success cancelled") == 1 and gate("success") == 0


def test_ci_checks_cover_lint_lock_tests_and_both_desktop_builds():
    desktop = load("desktop.yml")
    steps = " ".join(s.get("run", "") for j in desktop["jobs"].values() for s in j.get("steps", []))
    for needed in ("cargo fmt", "cargo clippy", "cargo metadata", "--locked", "npm ci", "npm run typecheck", "npm test", "cargo test", "npx tauri build"):
        assert needed in steps, needed
    names = [m["name"] for m in desktop["jobs"]["build"]["strategy"]["matrix"]["include"]]
    assert names == ["macOS universal", "Windows x64"]


def test_ci_checks_rust_dependencies_with_cargo_deny():
    # Пакет G8 (ADR-060): уязвимости, лицензии и источники зависимостей проверяются в каждом PR.
    steps = load("desktop.yml")["jobs"]["rust"]["steps"]
    deny = [s for s in steps if s.get("name") == "Dependencies (cargo deny)"]
    assert len(deny) == 1
    run = deny[0]["run"]
    # Бинарник из релиза ставится только после сверки SHA-256, проверка — по lock-файлу и без лишних признаков.
    assert re.fullmatch(r"[0-9a-f]{64}", deny[0]["env"]["DENY_SHA256"])
    assert "sha256sum -c" in run and run.index("sha256sum -c") < run.index("tar -xzf")
    assert "--manifest-path src-tauri/Cargo.toml --locked check" in run and "--all-features" not in run
    assert "set -euo pipefail" in run
    config = (WF.parents[1] / "desktop/src-tauri/deny.toml").read_text(encoding="utf-8")
    for needed in ('unknown-registry = "deny"', 'unknown-git = "deny"', 'yanked = "deny"', "ignore = []"):
        assert needed in config, needed


def test_ci_workflows_cancel_stale_runs_and_do_not_publish():
    for f in WF.glob("*.yml"):
        wf = yaml.safe_load(f.read_text(encoding="utf-8"))
        text = f.read_text(encoding="utf-8")
        if "pull_request" in wf[True]:
            assert wf["concurrency"]["cancel-in-progress"] is True, f.name
        # Публикует только release.yml.
        if f.name != "release.yml":
            assert "gh release" not in text and "git/refs" not in text, f"{f.name}: публикация только в release.yml"
    release = load("release.yml")[True]
    assert "pull_request" not in release, "релиз не запускается из PR"


def test_no_beta_channel_workflows():
    # Beta, Preview и ранний доступ удалены (ADR-034): ни один workflow не собирает и не публикует их.
    assert not (WF / "beta.yml").exists()
    for f in WF.glob("*.yml"):
        text = f.read_text(encoding="utf-8")
        assert "--features beta" not in text and "tauri.beta.conf.json" not in text, f.name
        assert "--prerelease" not in text and "SUPABASE_BETA_" not in text, f.name
        assert "environment: beta" not in text, f.name


def test_stable_release_ignores_beta_tags_and_waits_for_approval():
    wf = load("release.yml")
    assert wf[True]["push"]["tags"] == ["v*", "!v*-*"]
    assert wf["jobs"]["publish"]["environment"] == "production"
    for job in ("macos", "windows"):
        text = str(wf["jobs"][job])
        assert "--features beta" not in text and "tauri.beta.conf.json" not in text, f"{job}: Stable собирается как Beta"


def test_release_is_only_build_and_installers_published_from_main():
    # ADR-068: релиз ускорен — нет задачи guard, тестов, release-check, проверки установщика и обязательных заметок.
    # Защита «только из main» осталась в задаче publish (она после сборок и ждёт подтверждения).
    wf = load("release.yml")
    jobs = wf["jobs"]
    assert set(jobs) == {"macos", "windows", "publish"}
    assert set(jobs["publish"]["needs"]) == {"macos", "windows"}
    for job in ("macos", "windows"):
        text = str(jobs[job])
        assert "npm test" not in text and "cargo test" not in text and "release-check" not in text and "needs" not in jobs[job]
    publish = " ".join(s.get("run", "") for s in jobs["publish"]["steps"])
    assert 'git merge-base --is-ancestor "$GITHUB_SHA" origin/main' in publish
    # Заметки не обязательны: свой файл, если он есть, иначе заметки собирает GitHub.
    assert "--notes-file" in publish and "--generate-notes" in publish


def test_release_publish_rejects_commits_outside_main(tmp_path):
    if not shutil.which("bash") or not shutil.which("git"):
        pytest.skip("нужны bash и git")
    steps = load("release.yml")["jobs"]["publish"]["steps"]
    on_main = next(s["run"] for s in steps if s.get("name") == "The commit is on main")
    repo = tmp_path / "repo"
    git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, text=True).stdout.strip()
    repo.mkdir()
    git("init", "-q", "-b", "main")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "main")
    main_sha = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", main_sha)
    git("checkout", "-q", "-b", "feature")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "feature")
    feature_sha = git("rev-parse", "HEAD")

    def run(sha):
        return subprocess.run(["bash", "-c", on_main], cwd=repo, env={**os.environ, "GITHUB_SHA": sha}, capture_output=True, text=True).returncode

    assert run(main_sha) == 0
    assert run(feature_sha) == 1


def test_ci_runs_core_tests_and_release_check():
    desktop = load("desktop.yml")
    steps = " ".join(s.get("run", "") for j in desktop["jobs"].values() for s in j.get("steps", []))
    assert "cargo test --manifest-path src-tauri/Cargo.toml --locked" in steps and "npm run release:check" in steps
    assert desktop[True]["push"]["branches"] == ["main"]


def test_inactive_accounts_job_is_weekly_and_uses_only_the_cron_secret():
    wf = load("inactive-accounts.yml")
    on = wf[True]
    assert "schedule" in on and "workflow_dispatch" in on
    assert wf["concurrency"]["cancel-in-progress"] is False
    text = (WF / "inactive-accounts.yml").read_text(encoding="utf-8")
    assert "uses:" not in text and "${{ secrets.CRON_SECRET }}" in text
    assert "${{ " not in text.split("run: |")[1]  # в шелл ничего не подставляется напрямую


def test_maintenance_job_is_daily_and_uses_only_the_cron_secret():
    wf = load("maintenance.yml")
    on = wf[True]
    assert "schedule" in on and "workflow_dispatch" in on and "pull_request" not in on
    assert on["schedule"][0]["cron"].endswith("* * *")  # каждый день
    assert wf["concurrency"]["cancel-in-progress"] is False
    text = (WF / "maintenance.yml").read_text(encoding="utf-8")
    assert "uses:" not in text and "${{ secrets.CRON_SECRET }}" in text and "/functions/v1/maintenance" in text
    assert "${{ " not in text.split("run: |")[1]  # в шелл ничего не подставляется напрямую


def test_cloud_backup_is_daily_read_only_and_encrypts_before_storing():
    wf = load("cloud-backup.yml")
    on = wf[True]
    assert "schedule" in on and "workflow_dispatch" in on and "pull_request" not in on
    assert wf["concurrency"]["cancel-in-progress"] is False
    steps = wf["jobs"]["backup"]["steps"]
    names = [s.get("name", "") for s in steps]
    assert names.index("Dump") < names.index("Restore check") < names.index("Encrypt") < names.index("Store")
    store = steps[names.index("Store")]
    assert store["with"]["path"].endswith(".tar.gpg") and store["with"]["retention-days"] == 90
    encrypt = steps[names.index("Encrypt")]["run"]
    assert "--symmetric --cipher-algo AES256" in encrypt and "--passphrase-fd 3" in encrypt
    text = (WF / "cloud-backup.yml").read_text(encoding="utf-8")
    secrets = set(re.findall(r"secrets\.(\w+)", text))
    assert secrets == {"SUPABASE_DB_URL", "BACKUP_PASSPHRASE"}, secrets
    # Пароль шифрования не попадает в командную строку gpg.
    assert "--passphrase \"" not in text and "--passphrase $" not in text



def test_migrations_are_applied_only_manually_after_the_stand_and_approval():
    wf = load("migrate.yml")
    on = wf[True]
    assert list(on) == ["workflow_dispatch"], "миграции рабочего проекта — только ручной запуск"
    assert on["workflow_dispatch"]["inputs"]["action"]["options"] == ["status", "push", "register"]
    assert wf["concurrency"]["cancel-in-progress"] is False
    stand, apply = wf["jobs"]["stand"], wf["jobs"]["apply"]
    assert stand["if"] == "github.ref == 'refs/heads/main'"
    assert "secrets." not in str(stand), "стенд работает без секретов"
    runs = " ".join(s.get("run", "") for s in stand["steps"])
    assert "supabase/tests/stack/up.sh" in runs and "test_migrations.py" in runs
    assert apply["needs"] == "stand" and apply["environment"] == "database"
    assert "supabase/scripts/migrate.sh" in " ".join(s.get("run", "") for s in apply["steps"])
