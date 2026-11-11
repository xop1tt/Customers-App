//! Текст из XML для quick-xml 0.41 (ленты RSS/Atom и книги XLSX). С версии 0.38 ссылки на сущности (`&amp;`,
//! `&#1076;`) приходят отдельным событием `GeneralRef`, а текст — без раскодирования; здесь собраны общие
//! помощники, чтобы оба разборщика понимали их одинаково. Обновление закрыло RUSTSEC-2026-0194/0195 (пакет G8).

use quick_xml::events::attributes::Attribute;
use quick_xml::events::{BytesRef, BytesText};
use quick_xml::XmlVersion;

/// Текст события `Text`: кодировка уже UTF-8 (`Reader::from_str`), испорченные байты заменяются.
pub fn text(t: &BytesText) -> String {
    t.xml10_content().map(|c| c.into_owned()).unwrap_or_else(|_| String::from_utf8_lossy(t).into_owned())
}

/// Значение ссылки: символ по коду или одна из пяти стандартных сущностей XML. Неизвестная сущность
/// (например, `&nbsp;` из HTML в RSS) остаётся как есть, чтобы текст не терялся.
pub fn entity(r: &BytesRef) -> String {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        return c.to_string();
    }
    let name = r.decode().map(|n| n.into_owned()).unwrap_or_default();
    match name.as_str() {
        "nbsp" => "\u{a0}".to_string(),
        _ => quick_xml::escape::resolve_predefined_entity(&name).map(str::to_string).unwrap_or_else(|| format!("&{name};")),
    }
}

/// Значение атрибута с раскрытыми стандартными сущностями.
pub fn attr_value(a: &Attribute) -> Option<String> {
    a.normalized_value(XmlVersion::Implicit1_0).ok().map(|v| v.into_owned())
}

#[cfg(test)]
mod tests {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    fn collect(xml: &str) -> (String, Vec<String>) {
        let mut r = Reader::from_str(xml);
        let (mut out, mut attrs) = (String::new(), Vec::new());
        loop {
            match r.read_event().unwrap() {
                Event::Start(e) => attrs.extend(e.attributes().flatten().filter_map(|a| super::attr_value(&a))),
                Event::Text(t) => out.push_str(&super::text(&t)),
                Event::GeneralRef(g) => out.push_str(&super::entity(&g)),
                Event::Eof => break,
                _ => {}
            }
        }
        (out, attrs)
    }

    #[test]
    fn text_with_references_is_joined() {
        let (text, attrs) = collect(r#"<a href="https://x.ru/?a=1&amp;b=2">Рога &amp; копыта &#1076;&#x430; &lt;3&gt; &nbsp;&unknown;</a>"#);
        assert_eq!(text, "Рога & копыта да <3> \u{a0}&unknown;");
        assert_eq!(attrs, ["https://x.ru/?a=1&b=2"]);
    }
}
