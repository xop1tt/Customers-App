//! Customers 2.0: данные CRM одного Workspace на устройстве — своя база на каждый Workspace,
//! очередь операций, загрузка с сервера, конфликты, коллекции, преобразование лидов.
//! Документы: docs/CRM_ARCHITECTURE.md, docs/SYNC_ARCHITECTURE.md, docs/WORKSPACE_AND_PERMISSIONS.md.
//!
//! База генератора лидов (`leads.db`) здесь не открывается и не меняется: связь — только отметка `data.crm` лида.

pub mod catalog;
pub mod convert;
pub mod dedupe;
pub mod import;
pub mod query;
pub mod schema;
pub mod store;
pub mod sync;

#[cfg(test)]
mod tests;
