//! Преобразование найденного лида в карточки CRM (docs/CRM_ARCHITECTURE.md §4). Лид генератора не меняется,
//! кроме отметки `data.crm`; повторный вызов не создаёт дубликатов: компания и контакт находятся по
//! `source_lead_id` или ключам дедупликации.

use super::dedupe;
use super::store::{stamp, WorkspaceStore};
use crate::error::{AppError, AppResult};
use crate::models::{LeadItem, LeadKind};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ConvertOptions {
    /// Создать сделку в воронке (по умолчанию — воронка по умолчанию, первый этап).
    pub create_deal: bool,
    pub pipeline_id: Option<String>,
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub workspace_id: String,
    pub company_id: String,
    pub contact_id: Option<String>,
    pub deal_id: Option<String>,
    pub reused_company: bool,
    pub reused_contact: bool,
}

impl Converted {
    /// Отметка в лиде генератора: `data.crm`.
    pub fn mark(&self) -> Value {
        json!({"workspace_id": self.workspace_id, "company_id": self.company_id, "contact_id": self.contact_id,
               "deal_id": self.deal_id, "converted_at": stamp(Utc::now())})
    }
}

fn split_contacts(lead: &LeadItem) -> (Vec<String>, Vec<String>, Map<String, Value>) {
    let d = &lead.data;
    let mut phones: Vec<String> = d.phone.iter().cloned().collect();
    let mut emails = Vec::new();
    let mut messengers = Map::new();
    for (k, v) in &d.contacts {
        let key = k.to_lowercase();
        if key.contains("mail") {
            emails.push(v.clone());
        } else if key.contains("phone") || key.contains("тел") {
            phones.push(v.clone());
        } else {
            messengers.insert(k.clone(), json!(v));
        }
    }
    phones.dedup();
    emails.dedup();
    (phones.into_iter().take(20).collect(), emails.into_iter().take(20).collect(), messengers)
}

/// Существующая запись: по источнику, затем по ключам дедупликации.
fn find_existing(store: &WorkspaceStore, table: &str, lead_id: &str, keys: &[String]) -> AppResult<Option<String>> {
    let by_source: Option<String> =
        store.conn().query_row(&format!("SELECT id FROM {table} WHERE source_lead_id=?1 AND deleted_at IS NULL LIMIT 1"), [lead_id], |r| r.get(0)).ok();
    if by_source.is_some() {
        return Ok(by_source);
    }
    Ok(store.duplicates(table, keys, None)?.into_iter().next().and_then(|v| v["id"].as_str().map(String::from)))
}

pub fn convert_lead(store: &WorkspaceStore, lead: &LeadItem, opts: &ConvertOptions) -> AppResult<Converted> {
    let d = &lead.data;
    let (phones, emails, messengers) = split_contacts(lead);
    let person = d.customer_name.as_deref().map(str::trim).filter(|s| !s.is_empty() && d.kind == LeadKind::Order);
    let company_name = match d.kind {
        LeadKind::Organization => d.title.trim().to_string(),
        LeadKind::Order => d.customer_name.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| d.title.clone()),
    };
    if company_name.trim().is_empty() {
        return Err(AppError::msg("У лида нет названия — нечего переносить в CRM."));
    }
    let source = format!("leadgen:{}", d.source);
    let payload = serde_json::to_value(d)?;
    let payload = if payload.to_string().len() > 60_000 { json!({"title": d.title, "url": d.url, "source": d.source}) } else { payload };

    let mut company = Map::new();
    company.insert("name".into(), json!(company_name.chars().take(300).collect::<String>()));
    if let Some(w) = d.website.as_deref().filter(|s| !s.is_empty()) {
        company.insert("website".into(), json!(w));
        if let Some(dom) = dedupe::domain(w) {
            company.insert("domain".into(), json!(dom));
        }
    }
    if d.kind == LeadKind::Organization || person.is_none() {
        company.insert("phones".into(), json!(phones));
        company.insert("emails".into(), json!(emails));
    }
    if let Some(a) = d.address.as_deref().filter(|s| !s.is_empty()) {
        company.insert("address".into(), json!(a.chars().take(500).collect::<String>()));
    }
    if let Some(c) = d.category.as_deref().filter(|s| !s.is_empty()) {
        company.insert("industry".into(), json!(c.chars().take(200).collect::<String>()));
    }
    company.insert("source".into(), json!(source));
    company.insert("source_lead_id".into(), json!(lead.id));
    company.insert("source_payload".into(), payload.clone());
    if let Some(o) = &opts.owner_id {
        company.insert("owner_id".into(), json!(o));
    }

    let keys = dedupe::keys("companies", &company);
    let (company_id, reused_company) = match find_existing(store, "companies", &lead.id, &keys)? {
        Some(id) => (id, true),
        None => (store.save("companies", None, &company)?["id"].as_str().unwrap_or_default().to_string(), false),
    };

    let mut contact_id = None;
    let mut reused_contact = false;
    if let Some(p) = person {
        let (first, last) = p.split_once(' ').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((p.to_string(), String::new()));
        let mut c = Map::new();
        c.insert("first_name".into(), json!(first.chars().take(120).collect::<String>()));
        c.insert("last_name".into(), json!(last.chars().take(120).collect::<String>()));
        c.insert("company_id".into(), json!(company_id));
        c.insert("phones".into(), json!(phones));
        c.insert("emails".into(), json!(emails));
        c.insert("messengers".into(), Value::Object(messengers));
        c.insert("source".into(), json!(source));
        c.insert("source_lead_id".into(), json!(lead.id));
        if let Some(o) = &opts.owner_id {
            c.insert("owner_id".into(), json!(o));
        }
        let ckeys = dedupe::keys("contacts", &c);
        match find_existing(store, "contacts", &lead.id, &ckeys)? {
            Some(id) => {
                contact_id = Some(id);
                reused_contact = true;
            }
            None => contact_id = store.save("contacts", None, &c)?["id"].as_str().map(String::from),
        }
    }

    // Заметка лида и событие «преобразован» — один раз на лид.
    let already: bool = store
        .conn()
        .query_row(
            "SELECT 1 FROM activities WHERE entity_type='company' AND entity_id=?1 AND type='system' AND json_extract(payload, '$.lead_id')=?2 LIMIT 1",
            [&company_id, &lead.id],
            |_| Ok(()),
        )
        .is_ok();
    if !already {
        if !lead.note.trim().is_empty() {
            let mut n = Map::new();
            n.insert("body".into(), json!(lead.note.chars().take(20000).collect::<String>()));
            n.insert("entity_type".into(), json!("company"));
            n.insert("entity_id".into(), json!(company_id));
            store.save("notes", None, &n)?;
        }
        let mut a = Map::new();
        a.insert("type".into(), json!("system"));
        a.insert("summary".into(), json!(format!("Создано из найденного лида: {}", d.title.chars().take(200).collect::<String>())));
        a.insert("payload".into(), json!({"event": "converted", "lead_id": lead.id, "source": d.source, "url": d.url}));
        a.insert("entity_type".into(), json!("company"));
        a.insert("entity_id".into(), json!(company_id));
        store.save("activities", None, &a)?;
    }

    let mut deal_id = None;
    if opts.create_deal {
        let existing: Option<String> = store
            .conn()
            .query_row("SELECT id FROM deals WHERE company_id=?1 AND title=?2 AND deleted_at IS NULL LIMIT 1", [&company_id, &d.title], |r| r.get(0))
            .ok();
        deal_id = match existing {
            Some(id) => Some(id),
            None => {
                let (pipeline, stage) = store.first_stage(opts.pipeline_id.as_deref())?;
                let mut deal = Map::new();
                deal.insert("title".into(), json!(d.title.chars().take(300).collect::<String>()));
                deal.insert("pipeline_id".into(), json!(pipeline));
                deal.insert("stage_id".into(), json!(stage));
                deal.insert("company_id".into(), json!(company_id));
                if let Some(b) = d.budget.filter(|b| *b >= 0.0) {
                    deal.insert("amount".into(), json!(b));
                }
                if let Some(c) = d.currency.as_deref().filter(|c| c.len() == 3) {
                    deal.insert("currency".into(), json!(c.to_uppercase()));
                }
                if let Some(o) = &opts.owner_id {
                    deal.insert("owner_id".into(), json!(o));
                }
                let id = store.save("deals", None, &deal)?["id"].as_str().map(String::from);
                if let (Some(did), Some(cid)) = (&id, &contact_id) {
                    let mut link = Map::new();
                    link.insert("deal_id".into(), json!(did));
                    link.insert("contact_id".into(), json!(cid));
                    store.save("deal_contacts", Some(&super::store::deal_contact_id(did, cid)), &link)?;
                }
                id
            }
        };
    }

    Ok(Converted { workspace_id: store.workspace_id.clone(), company_id, contact_id, deal_id, reused_company, reused_contact })
}
