//! Время в ядре: момент (`Timestamp`, всегда UTC), длительность (`SignedDuration`) и даты календаря (`Date`,
//! `CivilDateTime`) на библиотеке jiff. chrono заброшен (RUSTSEC-2026-0543), поэтому ядро перешло на jiff (ADR-092).
//!
//! Здесь же — строковые форматы, которые читают предыдущие версии приложения, облако и интерфейс: они должны
//! совпадать с прежними символ в символ.

pub use jiff::civil::{Date, DateTime as CivilDateTime};
pub use jiff::tz::TimeZone;
pub use jiff::{SignedDuration, Timestamp};

use std::fmt::Write as _;
use std::time::SystemTime;

/// Текущий момент.
pub fn now() -> Timestamp {
    Timestamp::now()
}

/// Самый ранний представимый момент: «никогда» при сравнениях.
pub const NEVER: Timestamp = Timestamp::MIN;

/// Длительность в секундах.
pub fn secs(n: i64) -> SignedDuration {
    SignedDuration::from_secs(n)
}

/// Длительность в минутах.
pub fn minutes(n: i64) -> SignedDuration {
    SignedDuration::from_mins(n)
}

/// Длительность в часах.
pub fn hours(n: i64) -> SignedDuration {
    SignedDuration::from_hours(n)
}

/// Длительность в сутках по 24 часа.
pub fn days(n: i64) -> SignedDuration {
    SignedDuration::from_hours(n.saturating_mul(24))
}

/// Длительность в миллисекундах.
pub fn millis(n: i64) -> SignedDuration {
    SignedDuration::from_millis(n)
}

/// Unix-секунды → момент; вне диапазона дат — `None`.
pub fn from_unix(secs: i64) -> Option<Timestamp> {
    Timestamp::from_second(secs).ok()
}

/// Время изменения файла.
pub fn from_system(t: SystemTime) -> Option<Timestamp> {
    Timestamp::try_from(t).ok()
}

/// Часовой пояс компьютера пользователя.
pub fn local_zone() -> TimeZone {
    TimeZone::system()
}

/// Момент в часовом поясе компьютера по шаблону strftime («%Y-%m-%d_%H-%M»).
pub fn local_format(t: Timestamp, fmt: &str) -> String {
    t.to_zoned(local_zone()).strftime(fmt).to_string()
}

/// Календарное время момента в поясе `tz`.
pub fn civil_in(t: Timestamp, tz: &TimeZone) -> CivilDateTime {
    tz.to_datetime(t)
}

/// Календарное время в UTC → момент.
pub fn utc_civil(d: CivilDateTime) -> Option<Timestamp> {
    d.to_zoned(TimeZone::UTC).ok().map(|z| z.timestamp())
}

/// Сколько доли секунды показывать, как прежде: 0, 3, 6 или 9 цифр — сколько нужно без потерь.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Frac {
    None,
    Millis,
    Auto,
}

fn rfc3339(t: Timestamp, frac: Frac) -> String {
    let d = TimeZone::UTC.to_datetime(t);
    let mut s = String::with_capacity(30);
    let year = d.year();
    if (0..=9999).contains(&year) {
        let _ = write!(s, "{year:04}");
    } else {
        let _ = write!(s, "{year:+05}");
    }
    let _ = write!(s, "-{:02}-{:02}T{:02}:{:02}:{:02}", d.month(), d.day(), d.hour(), d.minute(), d.second());
    let nanos = d.subsec_nanosecond();
    match frac {
        Frac::None => {}
        Frac::Millis => {
            let _ = write!(s, ".{:03}", nanos / 1_000_000);
        }
        Frac::Auto if nanos == 0 => {}
        Frac::Auto if nanos % 1_000_000 == 0 => {
            let _ = write!(s, ".{:03}", nanos / 1_000_000);
        }
        Frac::Auto if nanos % 1_000 == 0 => {
            let _ = write!(s, ".{:06}", nanos / 1_000);
        }
        Frac::Auto => {
            let _ = write!(s, ".{nanos:09}");
        }
    }
    s.push('Z');
    s
}

/// «2026-11-05T09:42:00Z» — до секунды.
pub fn rfc3339_secs(t: Timestamp) -> String {
    rfc3339(t, Frac::None)
}

/// «2026-11-05T09:42:00.123Z» — всегда с миллисекундами.
pub fn rfc3339_millis(t: Timestamp) -> String {
    rfc3339(t, Frac::Millis)
}

/// «2026-11-05T09:42:00Z», «…00.5» → «…00.500Z»: доли секунды группами по три цифры, как в JSON прежних версий.
pub fn rfc3339_auto(t: Timestamp) -> String {
    rfc3339(t, Frac::Auto)
}

/// RFC 3339 с любым смещением («+03:00», «Z»).
pub fn parse_rfc3339(s: &str) -> Option<Timestamp> {
    s.trim().parse::<Timestamp>().ok()
}

/// Дата письма и заголовка HTTP (RFC 2822): «Thu, 05 Nov 2026 09:42:00 +0300», «… GMT».
pub fn parse_rfc2822(s: &str) -> Option<Timestamp> {
    jiff::fmt::rfc2822::DateTimeParser::new().parse_timestamp(s.trim()).ok()
}

/// По шаблону strptime со смещением в строке («%Y-%m-%dT%H:%M:%S%z»).
pub fn parse_with_offset(s: &str, fmt: &str) -> Option<Timestamp> {
    jiff::fmt::strtime::parse(fmt, s).ok()?.to_timestamp().ok()
}

/// По шаблону strptime без пояса: календарное время.
pub fn parse_civil(s: &str, fmt: &str) -> Option<CivilDateTime> {
    jiff::fmt::strtime::parse(fmt, s).ok()?.to_datetime().ok()
}

/// «2026-11-05» → дата.
pub fn parse_ymd(s: &str) -> Option<Date> {
    Date::strptime("%Y-%m-%d", s).ok()
}

/// Сериализация момента строкой, как прежде в JSON: `#[serde(with = "crate::time::serde_auto")]`.
pub mod serde_auto {
    use super::*;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &Timestamp, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&rfc3339_auto(*t))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Timestamp, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339(&s).ok_or_else(|| serde::de::Error::custom("неверная дата"))
    }

    /// То же для `Option<Timestamp>`.
    pub mod option {
        use super::*;

        pub fn serialize<S: Serializer>(t: &Option<Timestamp>, s: S) -> Result<S::Ok, S::Error> {
            match t {
                Some(t) => s.serialize_str(&rfc3339_auto(*t)),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Timestamp>, D::Error> {
            match Option::<String>::deserialize(d)? {
                Some(s) => parse_rfc3339(&s).map(Some).ok_or_else(|| serde::de::Error::custom("неверная дата")),
                None => Ok(None),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Timestamp {
        parse_rfc3339(s).unwrap()
    }

    #[test]
    fn formats_match_previous_versions() {
        let t = at("2026-11-05T12:42:00.5+03:00");
        assert_eq!(rfc3339_secs(t), "2026-11-05T09:42:00Z");
        assert_eq!(rfc3339_millis(t), "2026-11-05T09:42:00.500Z");
        assert_eq!(rfc3339_auto(t), "2026-11-05T09:42:00.500Z");
        assert_eq!(rfc3339_millis(at("2026-11-05T09:42:00Z")), "2026-11-05T09:42:00.000Z");
        assert_eq!(rfc3339_auto(at("2026-11-05T09:42:00Z")), "2026-11-05T09:42:00Z");
        assert_eq!(rfc3339_auto(at("2026-11-05T09:42:00.000123Z")), "2026-11-05T09:42:00.000123Z");
        assert_eq!(rfc3339_auto(at("2026-11-05T09:42:00.000000007Z")), "2026-11-05T09:42:00.000000007Z");
        assert_eq!(rfc3339_millis(at("2026-11-05T09:42:00.123999Z")), "2026-11-05T09:42:00.123Z", "миллисекунды отбрасываются, не округляются");
        assert_eq!(rfc3339_secs(at("0099-01-02T03:04:05Z")), "0099-01-02T03:04:05Z");
    }

    #[test]
    fn parses_rfc3339_rfc2822_and_patterns() {
        let want = at("2026-11-05T06:42:00Z");
        assert_eq!(parse_rfc3339(" 2026-11-05T09:42:00+03:00 "), Some(want));
        assert_eq!(parse_rfc3339("2026-11-05T09:42:00"), None, "без пояса — не RFC 3339");
        assert_eq!(parse_rfc2822("Thu, 05 Nov 2026 09:42:00 +0300"), Some(want));
        assert_eq!(parse_rfc2822("Thu, 05 Nov 2026 06:42:00 GMT"), Some(want));
        assert_eq!(parse_rfc2822("Wed, 05 Nov 2026 09:42:00 +0300"), None, "день недели не сходится");
        assert_eq!(parse_with_offset("2026-11-05T09:42:00+0300", "%Y-%m-%dT%H:%M:%S%z"), Some(want));
        assert_eq!(parse_civil("2026-11-05 06:42:00", "%Y-%m-%d %H:%M:%S").and_then(utc_civil), Some(want));
        assert_eq!(parse_ymd("2024-03-01"), Some(jiff::civil::date(2024, 3, 1)));
        assert_eq!(parse_ymd("2024-02-30"), None);
    }

    #[test]
    fn arithmetic_and_local_time() {
        let t = at("2026-11-05T09:42:00Z");
        assert_eq!((t + hours(2)).duration_since(t), secs(7200));
        assert_eq!(days(1), secs(86_400));
        assert_eq!(from_unix(1_793_871_720).map(|t| t.as_second()), Some(1_793_871_720));
        assert!(NEVER < t);
        let msk = TimeZone::fixed(jiff::tz::offset(3));
        assert_eq!(civil_in(t, &msk), jiff::civil::date(2026, 11, 5).at(12, 42, 0, 0));
        assert_eq!(local_format(t, "%Y").len(), 4);
        assert_eq!(t.strftime("%Y%m%d-%H%M%S").to_string(), "20261105-094200", "момент без пояса — в UTC");
    }

    #[test]
    fn serde_keeps_the_json_format() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct W {
            #[serde(with = "serde_auto")]
            a: Timestamp,
            #[serde(with = "serde_auto::option")]
            b: Option<Timestamp>,
        }
        let w = W { a: at("2026-11-05T09:42:00.5Z"), b: None };
        let text = serde_json::to_string(&w).unwrap();
        assert_eq!(text, r#"{"a":"2026-11-05T09:42:00.500Z","b":null}"#);
        assert_eq!(serde_json::from_str::<W>(&text).unwrap(), w);
    }
}
