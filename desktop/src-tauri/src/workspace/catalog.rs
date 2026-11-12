//! Список Workspace учётной записи на этом устройстве и выбранный Workspace:
//! `<папка учётной записи>/workspaces/catalog.json`. Права в нём — копия ответа `my_workspaces`
//! для работы без сети; сервер проверяет их заново при каждой выгрузке.

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

    /// Список с сервера. Возвращает Workspace, из которых пользователя удалили (их локальные базы удаляются).
    pub fn replace_remote(&mut self, fresh: Vec<WorkspaceInfo>) -> Vec<WorkspaceInfo> {
        let gone: Vec<WorkspaceInfo> = self.workspaces.iter().filter(|w| w.remote && !fresh.iter().any(|f| f.id == w.id)).cloned().collect();
        self.workspaces.retain(|w| !w.remote);
        self.workspaces.extend(fresh);
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
        }
    }

    #[test]
    fn removed_workspaces_are_reported_and_active_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let c = Catalog { active: Some("b".into()), workspaces: vec![ws("a", true, true), ws("b", true, false), ws("l", false, false)] };
        c.save(dir.path()).unwrap();
        let mut c = Catalog::load(dir.path());
        let gone = c.replace_remote(vec![ws("a", true, true)]);
        assert_eq!(gone.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert_eq!(c.active.as_deref(), Some("a"));
        assert_eq!(c.workspaces.len(), 2);
    }
}
