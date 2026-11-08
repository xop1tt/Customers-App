//! CSV: экранирование (с защитой от формул Excel) и разбор строки с автоопределением разделителя.

/// Ячейки, которые Excel и Numbers считают формулами. Текст из внешних источников может начинаться
/// с «=HYPERLINK(...)», поэтому такие значения экранируются апострофом. Номер телефона вида
/// «+7 (843) 212-48-90» формулой быть не может и не меняется.
fn neutralize_formula(s: &str) -> String {
    let Some(first) = s.chars().next() else { return s.to_string() };
    if !"=+-@\t\r".contains(first) {
        return s.to_string();
    }
    let phone_like = s.chars().all(|c| "0123456789+-() ".contains(c)) && s.chars().any(|c| c.is_numeric());
    if phone_like {
        return s.to_string();
    }
    format!("'{s}")
}

pub fn escape(raw: &str) -> String {
    let s = neutralize_formula(raw);
    if s.chars().any(|c| matches!(c, ',' | '"' | '\n' | '\r' | ';')) {
        return format!("\"{}\"", s.replace('"', "\"\""));
    }
    s
}

/// Разделитель строки: считаются только `;`, `,` и табуляция вне кавычек.
pub fn separator(line: &str) -> char {
    let (mut semi, mut comma, mut tab) = (0, 0, 0);
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => semi += 1,
            ',' if !quoted => comma += 1,
            '\t' if !quoted => tab += 1,
            _ => {}
        }
    }
    if semi >= comma.max(1) && semi >= tab {
        return ';';
    }
    if tab > comma {
        return '\t';
    }
    ','
}

/// Разбор одной строки CSV (запятая, точка с запятой или табуляция, кавычки).
pub fn parse_line(line: &str) -> Vec<String> {
    let sep = separator(line);
    let chars: Vec<char> = line.chars().collect();
    let (mut out, mut cur, mut quoted) = (Vec::new(), String::new(), false);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    cur.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == sep {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
        i += 1;
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formulas_are_neutralized_but_phones_are_not() {
        assert_eq!(escape("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(escape("+7 (843) 212-48-90"), "+7 (843) 212-48-90");
        assert_eq!(escape("@cmd"), "'@cmd");
        assert_eq!(escape("-5 руб"), "'-5 руб");
        assert_eq!(escape("-"), "'-");
        assert_eq!(escape("обычный"), "обычный");
    }

    #[test]
    fn special_characters_are_quoted() {
        assert_eq!(escape("a,b"), "\"a,b\"");
        assert_eq!(escape("a;b"), "\"a;b\"");
        assert_eq!(escape("a\"b"), "\"a\"\"b\"");
        assert_eq!(escape("a\nb"), "\"a\nb\"");
    }

    #[test]
    fn separator_and_parsing() {
        assert_eq!(separator("a;b;c"), ';');
        assert_eq!(separator("a,b,c"), ',');
        assert_eq!(separator("a\tb\tc"), '\t');
        assert_eq!(separator("\"a;b\",c"), ',');
        assert_eq!(parse_line("a;\"b;c\";d"), vec!["a", "b;c", "d"]);
        assert_eq!(parse_line("x,\"he said \"\"hi\"\"\",z"), vec!["x", "he said \"hi\"", "z"]);
        assert_eq!(parse_line(""), vec![""]);
    }
}
