//! Стабильная запись JSON: ключи по алфавиту, целые числа без «.0». Так одинаковые данные дают
//! одинаковый текст в базе и в файлах выгрузки.

use serde_json::Value;

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
