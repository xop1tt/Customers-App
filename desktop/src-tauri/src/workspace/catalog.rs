//! Список Workspace учётной записи на этом устройстве и выбранный Workspace:
//! `<папка учётной записи>/workspaces/catalog.json`. Права в нём — копия ответа `my_workspaces`
//! для работы без сети; сервер проверяет их заново при каждой выгрузке.
//!
//! Облачный Workspace живёт либо в общем облаке Customers (`cloud: None`), либо в облаке клиента
//! (`cloud: Some(..)`): его собственный проект Supabase или свой сервер с Supabase (ADR-098). У облака клиента
//! свой вход; список его Workspace приходит с него же и обновляется отдельно от общего.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub personal: bool,
    pub role: String,
    #[serde(default)]
    pub role_name: String,
    #[serde(default)]
    pub rank: i64,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "one")]
    pub members: i64,
    /// Workspace в Supabase (иначе — только на этом устройстве).
    #[serde(default)]
    pub remote: bool,
    #[serde(default = "rub")]
    pub default_currency: String,
    /// Облако клиента; `None` — общее облако Customers (или Workspace только на устройстве).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<CloudRef>,
}

/// Облако клиента: адрес проекта Supabase и его публичный ключ (оба значения не секретные).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRef {
    pub url: String,
    pub anon_key: String,
    /// `supabase` — проект в аккаунте Supabase клиента, `server` — Supabase на сервере клиента.
    #[serde(default = "supabase_kind")]
    pub kind: String,
}

fn supabase_kind() -> String {
    "supabase".into()
}

impl CloudRef {
    /// Проверенное облако: адрес https (или локальный http), публичный ключ, известный вид.
    pub fn new(url: &str, anon_key: &str, kind: &str) -> Option<Self> {
        let config = crate::cloud::config::CloudConfig::new(url, anon_key)?;
        if !["supabase", "server"].contains(&kind) {
            return None;
        }
        Some(Self { url: config.url, anon_key: config.anon_key, kind: kind.into() })
    }
}

fn one() -> i64 {
    1
}
fn rub() -> String {
    "RUB".into()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub active: Option<String>,
    pub workspaces: Vec<WorkspaceInfo>,
    /// Подключённые облака клиента, даже если в них ещё нет Workspace.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clouds: Vec<CloudRef>,
}

impl Catalog {
    pub fn file(dir: &Path) -> PathBuf {
        dir.join("catalog.json")
    }

    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(Self::file(dir)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join("catalog.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, Self::file(dir))?;
        Ok(())
    }

    pub fn active_info(&self) -> Option<&WorkspaceInfo> {
        let id = self.active.as_deref()?;
        self.workspaces.iter().find(|w| w.id == id)
    }

    /// Выбранный Workspace, а если его нет в списке — личный или первый.
    pub fn fix_active(&mut self) {
        if self.active_info().is_none() {
            self.active = self.workspaces.iter().find(|w| w.personal).or_else(|| self.workspaces.first()).map(|w| w.id.clone());
        }
    }

    /// Список с общего облака. Возвращает Workspace, из которых пользователя удалили (их локальные базы удаляются).
    /// Workspace в облаках клиента не трогает.
    pub fn replace_remote(&mut self, fresh: Vec<WorkspaceInfo>) -> Vec<WorkspaceInfo> {
        self.replace_in(None, fresh)
    }

    /// Список с облака клиента: заменяет только Workspace этого облака.
    pub fn replace_cloud(&mut self, cloud: &CloudRef, fresh: Vec<WorkspaceInfo>) -> Vec<WorkspaceInfo> {
        let fresh = fresh.into_iter().map(|w| WorkspaceInfo { remote: true, personal: false, cloud: Some(cloud.clone()), ..w }).collect();
        self.replace_in(Some(cloud), fresh)
    }

    fn replace_in(&mut self, cloud: Option<&CloudRef>, fresh: Vec<WorkspaceInfo>) -> Vec<WorkspaceInfo> {
        let ours = |w: &WorkspaceInfo| w.remote && w.cloud.as_ref().map(|c| &c.url) == cloud.map(|c| &c.url);
        let gone: Vec<WorkspaceInfo> = self.workspaces.iter().filter(|w| ours(w) && !fresh.iter().any(|f| f.id == w.id)).cloned().collect();
        self.workspaces.retain(|w| !ours(w));
        // Совпадение id в двух облаках невозможно на практике (uuid), но чужую запись не перезаписываем.
        let fresh: Vec<WorkspaceInfo> = fresh.into_iter().filter(|f| !self.workspaces.iter().any(|w| w.id == f.id)).collect();
        self.workspaces.extend(fresh);
        self.fix_active();
        gone
    }

    /// Запомнить облако клиента (без повторов по адресу).
    pub fn add_cloud(&mut self, cloud: CloudRef) {
        self.clouds.retain(|c| c.url != cloud.url);
        self.clouds.push(cloud);
    }

    /// Отключить облако клиента: его Workspace уходят с устройства (возвращаются для удаления локальных копий).
    pub fn remove_cloud(&mut self, url: &str) -> Vec<WorkspaceInfo> {
        self.clouds.retain(|c| c.url != url);
        let gone: Vec<WorkspaceInfo> = self.workspaces.iter().filter(|w| w.cloud.as_ref().is_some_and(|c| c.url == url)).cloned().collect();
        self.workspaces.retain(|w| !w.cloud.as_ref().is_some_and(|c| c.url == url));
        self.fix_active();
        gone
    }
}

pub fn database_file(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.db"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str, remote: bool, personal: bool) -> WorkspaceInfo {
        WorkspaceInfo {
            id: id.into(),
            name: id.into(),
            personal,
            role: "owner".into(),
            role_name: String::new(),
            rank: 100,
            permissions: vec![],
            members: 1,
            remote,
            default_currency: "RUB".into(),
            cloud: None,
        }
    }

    fn own() -> CloudRef {
        CloudRef::new("https://client.supabase.co", &format!("sb_publishable_{}", "c".repeat(30)), "supabase").unwrap()
    }

    #[test]
    fn client_clouds_refresh_separately_from_the_shared_one() {
        let mut c = Catalog::default();
        c.replace_remote(vec![ws("a", true, true), ws("b", true, false)]);
        c.add_cloud(own());
        let gone = c.replace_cloud(&own(), vec![ws("x", true, true), ws("y", true, false)]);
        assert!(gone.is_empty());
        let x = c.workspaces.iter().find(|w| w.id == "x").unwrap();
        assert_eq!(x.cloud.as_ref().map(|r| r.url.as_str()), Some("https://client.supabase.co"));
        assert!(!x.personal, "личный Workspace бывает только в общем облаке");

        // Обновление общего облака не трогает Workspace клиента, и наоборот.
        let gone = c.replace_remote(vec![ws("a", true, true)]);
        assert_eq!(gone.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(c.workspaces.iter().any(|w| w.id == "x"));
        let gone = c.replace_cloud(&own(), vec![ws("x", true, false)]);
        assert_eq!(gone.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["y"]);
        assert!(c.workspaces.iter().any(|w| w.id == "a"));

        // Отключение облака убирает его Workspace и само облако.
        c.add_cloud(own());
        assert_eq!(c.clouds.len(), 1);
        c.active = Some("x".into());
        let gone = c.remove_cloud("https://client.supabase.co");
        assert_eq!(gone.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["x"]);
        assert!(c.clouds.is_empty());
        assert_eq!(c.active.as_deref(), Some("a"));
    }

    #[test]
    fn client_cloud_needs_a_public_key_and_known_kind() {
        assert!(CloudRef::new("https://c.supabase.co", &["sb", "secret", "abc"].join("_"), "supabase").is_none());
        assert!(CloudRef::new("http://c.example.com", "sb_publishable_abc", "server").is_none());
        assert!(CloudRef::new("https://c.example.com", "sb_publishable_abc", "ftp").is_none());
        assert_eq!(CloudRef::new("https://c.example.com/", "sb_publishable_abc", "server").unwrap().url, "https://c.example.com");
    }

    #[test]
    fn old_catalog_files_still_load() {
        let old = r#"{"active":"a","workspaces":[{"id":"a","name":"A","role":"owner","remote":true}]}"#;
        let c: Catalog = serde_json::from_str(old).unwrap();
        assert!(c.workspaces[0].cloud.is_none() && c.clouds.is_empty());
    }

    #[test]
    fn removed_workspaces_are_reported_and_active_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog { active: Some("b".into()), workspaces: vec![ws("a", true, true), ws("b", true, false), ws("l", false, false)], clouds: vec![] };
        c.save(dir.path()).unwrap();
        let mut c = Catalog::load(dir.path());
        let gone = c.replace_remote(vec![ws("a", true, true)]);
        assert_eq!(gone.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(c.active.as_deref(), Some("a"));
        assert_eq!(c.workspaces.len(), 2);
    }
}
