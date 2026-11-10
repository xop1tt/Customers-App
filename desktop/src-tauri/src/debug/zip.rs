//! Архив ZIP без сжатия (метод «stored») для отчёта диагностики: несколько текстовых файлов, без сторонних
//! библиотек. Открывается проводником Windows, Finder и `unzip`.

use chrono::{Datelike, Timelike, Utc};

fn crc32(data: &[u8]) -> u32 {
    static TABLE: once_cell::sync::Lazy<[u32; 256]> = once_cell::sync::Lazy::new(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c = TABLE[((c ^ b as u32) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

fn dos_time() -> (u16, u16) {
    let n = Utc::now();
    let time = ((n.hour() as u16) << 11) | ((n.minute() as u16) << 5) | (n.second() as u16 / 2);
    let date = (((n.year() - 1980).clamp(0, 127) as u16) << 9) | ((n.month() as u16) << 5) | n.day() as u16;
    (time, date)
}

/// Собрать архив из пар «имя внутри архива — содержимое». Имена в UTF-8 (флаг 0x0800).
pub fn build(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let (time, date) = dos_time();
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in files {
        let offset = out.len() as u32;
        let crc = crc32(data);
        let size = data.len() as u32;
        let name_bytes = name.as_bytes();
        // Локальный заголовок.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // версия для распаковки
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // имя в UTF-8
        out.extend_from_slice(&0u16.to_le_bytes()); // без сжатия
        out.extend_from_slice(&time.to_le_bytes());
        out.extend_from_slice(&date.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);
        // Запись центрального каталога.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&time.to_le_bytes());
        central.extend_from_slice(&date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 8]); // доп. поле, комментарий, номер диска, внутренние атрибуты
        central.extend_from_slice(&0u32.to_le_bytes()); // внешние атрибуты
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// Прочитать архив, собранный `build` (по центральному каталогу, с проверкой CRC). Для тестов и проверки отчёта.
pub fn read(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let u16_at = |p: usize| bytes.get(p..p + 2).map(|b| u16::from_le_bytes([b[0], b[1]])).ok_or("обрыв архива");
    let u32_at = |p: usize| bytes.get(p..p + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).ok_or("обрыв архива");
    let end = (0..bytes.len().saturating_sub(21)).rev().find(|&p| u32_at(p) == Ok(0x0605_4b50)).ok_or("нет конца каталога")?;
    let count = u16_at(end + 10)? as usize;
    let mut p = u32_at(end + 16)? as usize;
    let mut files = vec![];
    for _ in 0..count {
        if u32_at(p)? != 0x0201_4b50 {
            return Err("повреждён центральный каталог".into());
        }
        let crc = u32_at(p + 16)?;
        let size = u32_at(p + 20)? as usize;
        let name_len = u16_at(p + 28)? as usize;
        let extra = u16_at(p + 30)? as usize + u16_at(p + 32)? as usize;
        let local = u32_at(p + 42)? as usize;
        let name = String::from_utf8(bytes.get(p + 46..p + 46 + name_len).ok_or("обрыв архива")?.to_vec()).map_err(|e| e.to_string())?;
        let local_name = u16_at(local + 26)? as usize + u16_at(local + 28)? as usize;
        let start = local + 30 + local_name;
        let data = bytes.get(start..start + size).ok_or("обрыв архива")?.to_vec();
        if crc32(&data) != crc {
            return Err(format!("не совпадает CRC у {name}"));
        }
        files.push((name, data));
        p += 46 + name_len + extra;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn archive_roundtrips_with_unicode_names() {
        let files = vec![("report.json".to_string(), b"{\"ok\":true}".to_vec()), ("журнал/события.txt".to_string(), "строка\n".as_bytes().to_vec())];
        let bytes = build(&files);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert_eq!(read(&bytes).unwrap(), files);
        let mut broken = bytes.clone();
        broken[41] ^= 0xFF; // первый байт содержимого первого файла (30 байт заголовка + 11 байт имени)
        assert!(read(&broken).unwrap_err().contains("CRC"));
    }
}
