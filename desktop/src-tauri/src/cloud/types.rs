//! Формат обмена — тот же, что у SQL-функции sync_push и таблиц public.leads / exclusions /
//! user_settings (см. docs/cloud.md). Сервер и таблицы не менялись: клиенты macOS, Windows и этот
//! используют один протокол.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Изменение лида для выгрузки. `ts` — время изменения только тех полей, что менялись на этом
/// устройстве; остальные поля сервер использует лишь при создании строки.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadChange {
    pub lead_id: String,
    pub fingerprint: String,
    pub kind: String,
    pub source: String,
    pub title: String,
    pub score: f64,
    pub relevance: String,
    pub discovered_at: String,
    pub data: Value,
    pub favorite: bool,
    pub archived: bool,
    pub deleted: bool,
    pub seen: bool,
    pub note: String,
    pub ts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExclusionChange {
    pub kind: String,
    pub value: String,
    pub deleted: bool,
    pub changed_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingChange {
    pub key: String,
    pub value: Value,
    pub changed_at: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PendingChanges {
    pub leads: Vec<LeadChange>,
    pub exclusions: Vec<ExclusionChange>,
    pub settings: Vec<SettingChange>,
}

impl PendingChanges {
    pub fn is_empty(&self) -> bool {
        self.leads.is_empty() && self.exclusions.is_empty() && self.settings.is_empty()
    }
    pub fn count(&self) -> usize {
        self.leads.len() + self.exclusions.len() + self.settings.len()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteLead {
    pub lead_id: String,
    #[serde(default)]
    pub fingerprint: String,
    pub kind: String,
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub relevance: String,
    pub discovered_at: String,
    pub data: Value,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub seen: bool,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub field_ts: BTreeMap<String, String>,
    pub server_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteExclusion {
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub deleted: bool,
    pub changed_at: String,
    pub server_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteSetting {
    pub key: String,
    pub value: Value,
    pub changed_at: String,
    pub server_seq: i64,
}

/// JSON-текст значения с сортировкой ключей — стабильный при повторной записи.
pub fn canonical_json(v: &Value) -> String {
    fn write(v: &Value, out: &mut String) {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    write(&m[*k], out);
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(x, out);
                }
                out.push(']');
            }
            Value::Number(n) => {
                // Целые числа без «.0», как у Swift/C#.
                if let Some(f) = n.as_f64() {
                    if n.is_f64() && f.fract() == 0.0 && f.abs() < 1e15 {
                        out.push_str(&format!("{}", f as i64));
                        return;
                    }
                }
                out.push_str(&n.to_string());
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let mut s = String::new();
    write(v, &mut s);
    s
}

/// Равенство JSON по смыслу: порядок ключей и вид записи чисел (65 и 65.0) не важны.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_equal(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| json_equal(v, w)).unwrap_or(false)),
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_keys_and_trims_float_zero() {
        let v = json!({"b": 1.0, "a": {"z": [1, 2.5], "y": null}, "c": "x/y"});
        assert_eq!(canonical_json(&v), r#"{"a":{"y":null,"z":[1,2.5]},"b":1,"c":"x/y"}"#);
    }

    #[test]
    fn json_equal_ignores_number_representation_and_key_order() {
        let a: Value = serde_json::from_str(r#"{"score":65,"x":[1,{"b":2,"a":1}]}"#).unwrap();
        let b = json!({"x": [1, {"a": 1, "b": 2}], "score": 65.0});
        assert!(json_equal(&a, &b));
        assert!(!json_equal(&a, &json!({"score": 66, "x": []})));
    }
}
