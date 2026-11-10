use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

fn main() {
    // Коммит и ветка для Dashboard в Debug Menu — только в сборке Beta; Stable собирается как раньше.
    if std::env::var_os("CARGO_FEATURE_BETA").is_some() {
        let commit = std::env::var("GITHUB_SHA").ok().map(|s| s.chars().take(12).collect()).or_else(|| git(&["rev-parse", "--short=12", "HEAD"]));
        let branch = std::env::var("GITHUB_HEAD_REF")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("GITHUB_REF_NAME").ok())
            .or_else(|| git(&["rev-parse", "--abbrev-ref", "HEAD"]));
        println!("cargo:rustc-env=CUSTOMERS_GIT_COMMIT={}", commit.unwrap_or_default());
        println!("cargo:rustc-env=CUSTOMERS_GIT_BRANCH={}", branch.unwrap_or_default());
        for f in ["../../.git/HEAD", "../../.git/index"] {
            if std::path::Path::new(f).exists() {
                println!("cargo:rerun-if-changed={f}");
            }
        }
        println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    }
    tauri_build::build()
}
