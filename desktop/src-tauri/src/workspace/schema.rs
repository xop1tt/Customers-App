//! Описание сущностей CRM для базы Workspace на устройстве. Совпадает с таблицами Supabase
//! (supabase/migrations/20261110120100…20261110120400) и реестром `private.crm_entities`:
//! те же имена таблиц и столбцов, те же поля, которые принимает `crm_push`.

/// Тип значения столбца: как хранится в SQLite и как проверяется до записи.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Num,
    Bool,
    /// Момент времени, RFC 3339 в UTC.
    Ts,
    /// Дата `YYYY-MM-DD`.
    Date,
    /// Массив строк или объект JSON (на сервере text[] / jsonb).
    Json,
    /// Идентификатор другой записи или участника.
    Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Records,
    /// Воронки и этапы: меняет только `pipelines.manage`.
    Settings,
    Collections,
}

#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub name: &'static str,
    pub kind: Kind,
    /// Можно задать с устройства (иначе поле вычисляет сервер, а здесь — те же правила).
    pub writable: bool,
    pub max_len: usize,
}

const fn w(name: &'static str, kind: Kind, max_len: usize) -> Field {
    Field { name, kind, writable: true, max_len }
}
const fn computed(name: &'static str, kind: Kind) -> Field {
    Field { name, kind, writable: false, max_len: 0 }
}

#[derive(Debug)]
pub struct Entity {
    /// Имя таблицы (и сущности в `crm_push`).
    pub table: &'static str,
    /// Значение `entity_type` в полиморфных ссылках и коллекциях.
    pub entity_type: Option<&'static str>,
    pub class: Class,
    pub fields: &'static [Field],
    /// Обязательные при создании.
    pub required: &'static [&'static str],
    /// Поле с названием записи.
    pub title: &'static str,
    /// Поля, по которым идёт поиск.
    pub search: &'static [&'static str],
}

use Kind::*;

const COMMON_OWNED: [Field; 3] = [w("owner_id", Uuid, 36), w("archived_at", Ts, 40), w("deleted_at", Ts, 40)];

pub static COMPANIES: Entity = Entity {
    table: "companies",
    entity_type: Some("company"),
    class: Class::Records,
    fields: &[
        COMMON_OWNED[0],
        COMMON_OWNED[1],
        COMMON_OWNED[2],
        w("name", Text, 300),
        w("legal_name", Text, 300),
        w("inn", Text, 20),
        w("domain", Text, 253),
        w("website", Text, 500),
        w("phones", Json, 20),
        w("emails", Json, 20),
        w("address", Text, 500),
        w("industry", Text, 200),
        w("size_range", Text, 40),
        w("source", Text, 100),
        w("source_lead_id", Text, 300),
        w("source_payload", Json, 65536),
        w("dedupe_keys", Json, 50),
    ],
    required: &["name"],
    title: "name",
    search: &["name", "legal_name", "inn", "domain", "website", "phones", "emails", "address", "industry"],
};

pub static CONTACTS: Entity = Entity {
    table: "contacts",
    entity_type: Some("contact"),
    class: Class::Records,
    fields: &[
        COMMON_OWNED[0],
        COMMON_OWNED[1],
        COMMON_OWNED[2],
        w("company_id", Uuid, 36),
        w("first_name", Text, 120),
        w("last_name", Text, 120),
        computed("full_name", Text),
        w("position", Text, 200),
        w("phones", Json, 20),
        w("emails", Json, 20),
        w("messengers", Json, 4096),
        w("source", Text, 100),
        w("source_lead_id", Text, 300),
        w("source_payload", Json, 65536),
        w("dedupe_keys", Json, 50),
    ],
    required: &[],
    title: "full_name",
    search: &["full_name", "position", "phones", "emails"],
};

pub static CRM_LEADS: Entity = Entity {
    table: "crm_leads",
    entity_type: Some("crm_lead"),
    class: Class::Records,
    fields: &[
        COMMON_OWNED[0],
        COMMON_OWNED[1],
        COMMON_OWNED[2],
        w("title", Text, 500),
        w("person_name", Text, 240),
        w("company_name", Text, 300),
        w("phones", Json, 20),
        w("emails", Json, 20),
        w("status", Text, 20),
        w("source", Text, 100),
        w("source_lead_id", Text, 300),
        w("converted_company_id", Uuid, 36),
        w("converted_contact_id", Uuid, 36),
    ],
    required: &["title"],
    title: "title",
    search: &["title", "person_name", "company_name", "phones", "emails"],
};

pub static PIPELINES: Entity = Entity {
    table: "pipelines",
    entity_type: None,
    class: Class::Settings,
    fields: &[w("archived_at", Ts, 40), w("deleted_at", Ts, 40), w("name", Text, 120), w("position", Num, 0), w("is_default", Bool, 0)],
    required: &["name"],
    title: "name",
    search: &["name"],
};

pub static PIPELINE_STAGES: Entity = Entity {
    table: "pipeline_stages",
    entity_type: None,
    class: Class::Settings,
    fields: &[
        w("deleted_at", Ts, 40),
        w("pipeline_id", Uuid, 36),
        w("name", Text, 120),
        w("position", Num, 0),
        w("color", Text, 7),
        w("probability", Num, 0),
        w("kind", Text, 10),
    ],
    required: &["pipeline_id", "name"],
    title: "name",
    search: &["name"],
};

pub static DEALS: Entity = Entity {
    table: "deals",
    entity_type: Some("deal"),
    class: Class::Records,
    fields: &[
        COMMON_OWNED[0],
        COMMON_OWNED[1],
        COMMON_OWNED[2],
        w("pipeline_id", Uuid, 36),
        w("stage_id", Uuid, 36),
        w("title", Text, 300),
        w("amount", Num, 0),
        w("currency", Text, 3),
        w("expected_close_date", Date, 10),
        w("company_id", Uuid, 36),
        computed("status", Text),
        w("lost_reason", Text, 500),
        computed("closed_at", Ts),
    ],
    required: &["pipeline_id", "stage_id", "title"],
    title: "title",
    search: &["title", "lost_reason"],
};

pub static DEAL_CONTACTS: Entity = Entity {
    table: "deal_contacts",
    entity_type: None,
    class: Class::Records,
    fields: &[w("deleted_at", Ts, 40), w("deal_id", Uuid, 36), w("contact_id", Uuid, 36), w("role", Text, 120)],
    required: &["deal_id", "contact_id"],
    title: "role",
    search: &["role"],
};

pub static TASKS: Entity = Entity {
    table: "tasks",
    entity_type: Some("task"),
    class: Class::Records,
    fields: &[
        w("archived_at", Ts, 40),
        w("deleted_at", Ts, 40),
        w("title", Text, 300),
        w("description", Text, 20000),
        w("assignee_id", Uuid, 36),
        w("due_at", Ts, 40),
        w("remind_at", Ts, 40),
        w("priority", Text, 10),
        w("status", Text, 20),
        computed("completed_at", Ts),
        w("entity_type", Text, 20),
        w("entity_id", Uuid, 36),
    ],
    required: &["title"],
    title: "title",
    search: &["title", "description"],
};

pub static ACTIVITIES: Entity = Entity {
    table: "activities",
    entity_type: None,
    class: Class::Records,
    fields: &[
        w("deleted_at", Ts, 40),
        w("type", Text, 20),
        w("occurred_at", Ts, 40),
        w("summary", Text, 2000),
        w("payload", Json, 16384),
        w("entity_type", Text, 20),
        w("entity_id", Uuid, 36),
    ],
    required: &["type", "entity_type", "entity_id"],
    title: "summary",
    search: &["summary"],
};

pub static NOTES: Entity = Entity {
    table: "notes",
    entity_type: None,
    class: Class::Records,
    fields: &[w("deleted_at", Ts, 40), w("body", Text, 20000), w("entity_type", Text, 20), w("entity_id", Uuid, 36)],
    required: &["body", "entity_type", "entity_id"],
    title: "body",
    search: &["body"],
};

pub static COMMENTS: Entity = Entity {
    table: "comments",
    entity_type: None,
    class: Class::Records,
    fields: &[w("deleted_at", Ts, 40), w("body", Text, 20000), w("entity_type", Text, 20), w("entity_id", Uuid, 36), w("parent_id", Uuid, 36)],
    required: &["body", "entity_type", "entity_id"],
    title: "body",
    search: &["body"],
};

pub static COLLECTIONS: Entity = Entity {
    table: "collections",
    entity_type: None,
    class: Class::Collections,
    fields: &[
        w("deleted_at", Ts, 40),
        w("visibility", Text, 10),
        w("entity_type", Text, 20),
        w("name", Text, 80),
        w("icon", Text, 41),
        w("emoji", Text, 16),
        w("config", Json, 16384),
        w("position", Num, 0),
        computed("builtin", Text),
    ],
    required: &["entity_type", "name"],
    title: "name",
    search: &["name"],
};

/// Порядок важен: ссылки идут на сущности выше по списку (так же применяются загруженные строки).
pub static ENTITIES: [&Entity; 12] =
    [&PIPELINES, &PIPELINE_STAGES, &COMPANIES, &CONTACTS, &CRM_LEADS, &DEALS, &DEAL_CONTACTS, &TASKS, &ACTIVITIES, &NOTES, &COMMENTS, &COLLECTIONS];

pub fn entity(table: &str) -> Option<&'static Entity> {
    ENTITIES.iter().copied().find(|e| e.table == table)
}

/// Таблица по типу полиморфной ссылки (`entity_type`).
pub fn by_type(entity_type: &str) -> Option<&'static Entity> {
    ENTITIES.iter().copied().find(|e| e.entity_type == Some(entity_type))
}

/// Допустимые значения перечислений (те же проверки, что `check` на сервере).
pub fn allowed_values(table: &str, field: &str) -> Option<&'static [&'static str]> {
    const REF_TYPES: &[&str] = &["company", "contact", "crm_lead", "deal"];
    Some(match (table, field) {
        ("crm_leads", "status") => &["new", "in_progress", "qualified", "disqualified", "converted"],
        ("pipeline_stages", "kind") => &["open", "won", "lost"],
        ("tasks", "priority") => &["low", "normal", "high", "urgent"],
        ("tasks", "status") => &["todo", "in_progress", "done", "cancelled"],
        ("activities", "type") => &["call", "email", "meeting", "follow_up", "reminder", "agreement", "payment", "custom", "system"],
        ("tasks" | "activities" | "notes" | "comments", "entity_type") => REF_TYPES,
        ("collections", "visibility") => &["private", "workspace"],
        ("collections", "entity_type") => &["company", "contact", "crm_lead", "deal", "task"],
        _ => return None,
    })
}

/// Ссылки на другие записи: столбец → таблица (проверяются на месте, как триггер `crm_stamp`).
pub const REFERENCES: [(&str, &str); 8] = [
    ("company_id", "companies"),
    ("contact_id", "contacts"),
    ("converted_company_id", "companies"),
    ("converted_contact_id", "contacts"),
    ("pipeline_id", "pipelines"),
    ("stage_id", "pipeline_stages"),
    ("deal_id", "deals"),
    ("parent_id", "comments"),
];

/// Служебные столбцы каждой таблицы (сверх полей сущности).
pub const SYSTEM_COLUMNS: [&str; 10] =
    ["id", "workspace_id", "created_by", "created_at", "updated_by", "updated_at", "version", "field_ts", "field_ver", "server_seq"];

impl Entity {
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }
    pub fn has(&self, name: &str) -> bool {
        self.field(name).is_some()
    }
    /// Любой столбец таблицы, по которому можно фильтровать и сортировать.
    pub fn column_kind(&self, name: &str) -> Option<Kind> {
        if let Some(f) = self.field(name) {
            return Some(f.kind);
        }
        match name {
            "created_at" | "updated_at" => Some(Ts),
            "created_by" | "updated_by" => Some(Uuid),
            "version" | "server_seq" => Some(Num),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_are_consistent() {
        for e in ENTITIES {
            for r in e.required {
                assert!(e.field(r).is_some_and(|f| f.writable), "{}.{r}", e.table);
            }
            assert!(e.column_kind(e.title).is_some(), "{}", e.table);
            for s in e.search {
                assert!(e.has(s), "{}.{s}", e.table);
            }
            let mut names: Vec<_> = e.fields.iter().map(|f| f.name).collect();
            names.sort();
            names.dedup();
            assert_eq!(names.len(), e.fields.len(), "{}", e.table);
            assert!(e.has("deleted_at"), "{}", e.table);
        }
        // Каждая ссылка указывает на сущность раньше по списку (порядок применения загрузки).
        for (i, e) in ENTITIES.iter().enumerate() {
            for (col, target) in REFERENCES {
                if e.has(col) && target != e.table {
                    let j = ENTITIES.iter().position(|x| x.table == target).unwrap();
                    assert!(j < i, "{} → {target}", e.table);
                }
            }
        }
    }

    #[test]
    fn writable_fields_match_the_server_registry() {
        // Те же списки, что `private.crm_attach(...)` в миграциях (порядок не важен).
        let migrations = [
            include_str!("../../../../supabase/migrations/20261110120100_crm_core.sql"),
            include_str!("../../../../supabase/migrations/20261110120200_sales.sql"),
            include_str!("../../../../supabase/migrations/20261110120300_work.sql"),
            include_str!("../../../../supabase/migrations/20261110120400_collections.sql"),
        ]
        .concat();
        for e in ENTITIES {
            let marker = format!("private.crm_attach('{}'", e.table);
            let start = migrations.find(&marker).unwrap_or_else(|| panic!("{} нет в миграциях", e.table));
            let rest = &migrations[start..];
            let list = &rest[rest.find("array[").unwrap() + 6..rest.find("]);").unwrap()];
            let mut server: Vec<String> = list.split(',').map(|s| s.trim().trim_matches('\'').to_string()).collect();
            let mut local: Vec<String> = e.fields.iter().filter(|f| f.writable).map(|f| f.name.to_string()).collect();
            server.sort();
            local.sort();
            assert_eq!(local, server, "{}", e.table);
        }
    }
}
