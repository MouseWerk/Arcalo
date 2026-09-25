//! Outlook `.msg` files ([MS-OXMSG]): a compound file whose MAPI properties are streams
//! `__substg1.0_<id><type>` (strings as UTF-16 `001F` or 8-bit `001E`, binary `0102`) plus the
//! fixed-size ones in `__properties_version1.0` (times, numbers). Read here: subject, sender
//! (SMTP address before an Exchange one), the display lists of To and Cc, delivery time,
//! importance, conversation topic, the plain text and the attachments
//! (`__attach_version1.0_#XXXXXXXX`: long file name, data). Categories are named properties
//! and are not read.

use std::io::{Cursor, Read};

use cfb::CompoundFile;
use chrono::{DateTime, TimeZone, Utc};

use super::{Mail, MailAttachment, MailSource, Parsed};

/// The compound file signature (`D0 CF 11 E0 A1 B1 1A E1`).
pub fn is_compound(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
}

type Cfb<'a> = CompoundFile<Cursor<&'a [u8]>>;

fn stream(cf: &mut Cfb, path: &str) -> Option<Vec<u8>> {
    let mut s = cf.open_stream(path).ok()?;
    let mut buf = vec![];
    s.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// A string property of the storage `dir` (`/` or `/__attach_version1.0_#00000000/`).
fn string(cf: &mut Cfb, dir: &str, id: u16) -> Option<String> {
    if let Some(b) = stream(cf, &format!("{dir}__substg1.0_{id:04X}001F")) {
        let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_owned());
    }
    let b = stream(cf, &format!("{dir}__substg1.0_{id:04X}001E"))?;
    let (text, _) = crate::vault::decode_text(&b);
    Some(text.trim_end_matches('\0').to_owned())
}

/// The 8-byte value of a fixed-size property of the top-level message.
fn fixed(props: &[u8], id: u16, kind: u16) -> Option<[u8; 8]> {
    // 32 header bytes on the top level, then 16 bytes per property: tag, flags, value.
    props.get(32..)?.chunks_exact(16).find_map(|e| {
        let tag = u32::from_le_bytes([e[0], e[1], e[2], e[3]]);
        ((tag >> 16) as u16 == id && tag as u16 == kind).then(|| e[8..16].try_into().unwrap_or([0; 8]))
    })
}

/// A FILETIME (100 ns since 1601) as UTC.
fn filetime(v: [u8; 8]) -> Option<DateTime<Utc>> {
    let ft = u64::from_le_bytes(v) as i64;
    if ft <= 0 {
        return None;
    }
    let secs = (ft - 116_444_736_000_000_000) / 10_000_000;
    Utc.timestamp_opt(secs, 0).single()
}

fn split_list(s: Option<String>) -> Vec<String> {
    s.unwrap_or_default().split(';').map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()).collect()
}

/// Parses a `.msg` file.
pub fn parse(bytes: &[u8]) -> Result<Parsed, String> {
    let mut cf = CompoundFile::open(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let root = "/";
    let smtp = string(&mut cf, root, 0x5D01).filter(|s| s.contains('@'));
    let address = string(&mut cf, root, 0x0C1F).filter(|s| s.contains('@'));
    let props = stream(&mut cf, "/__properties_version1.0").unwrap_or_default();
    let received =
        fixed(&props, 0x0E06, 0x0040).and_then(filetime).or_else(|| fixed(&props, 0x0039, 0x0040).and_then(filetime));
    let importance =
        fixed(&props, 0x0017, 0x0003).map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]) as u8).unwrap_or(1);
    let mut attachments = vec![];
    let mut parts = vec![];
    let mut dirs: Vec<String> = cf
        .read_root_storage()
        .filter(|e| e.is_storage() && e.name().starts_with("__attach_version1.0_#"))
        .map(|e| e.name().to_owned())
        .collect();
    dirs.sort();
    for (i, name) in dirs.iter().enumerate() {
        let dir = format!("/{name}/");
        let file = string(&mut cf, &dir, 0x3707)
            .filter(|n| !n.trim().is_empty())
            .or_else(|| string(&mut cf, &dir, 0x3704))
            .or_else(|| string(&mut cf, &dir, 0x3001))
            .unwrap_or_else(|| format!("Anhang {}", i + 1));
        // Embedded messages (a storage instead of data) are listed without content.
        let data = stream(&mut cf, &format!("{dir}__substg1.0_37010102")).unwrap_or_default();
        let inline = string(&mut cf, &dir, 0x3712).is_some_and(|c| !c.trim().is_empty());
        attachments.push(MailAttachment {
            index: i as u32 + 1,
            name: file.trim().to_owned(),
            size: data.len() as u64,
            inline,
            file: String::new(),
        });
        parts.push(data);
    }
    let mail = Mail {
        source: MailSource::Msg,
        subject: string(&mut cf, root, 0x0037).unwrap_or_default(),
        from_name: string(&mut cf, root, 0x0C1A).unwrap_or_default(),
        from_email: smtp.or(address).unwrap_or_default(),
        to: split_list(string(&mut cf, root, 0x0E04)),
        cc: split_list(string(&mut cf, root, 0x0E03)),
        received,
        conversation: string(&mut cf, root, 0x0070).unwrap_or_default(),
        importance,
        body: string(&mut cf, root, 0x1000).unwrap_or_default(),
        attachments,
        ..Default::default()
    };
    if mail.subject.is_empty() && mail.from_name.is_empty() && mail.body.is_empty() {
        return Err("keine Nachrichteneigenschaften gefunden".into());
    }
    Ok(Parsed { mail, parts })
}

/// Builds a small `.msg` for tests: string properties (UTF-16), a delivery time, importance
/// and attachments.
#[cfg(test)]
pub(crate) fn build(
    strings: &[(u16, &str)],
    received: Option<DateTime<Utc>>,
    importance: u32,
    files: &[(&str, &[u8])],
) -> Vec<u8> {
    use std::io::Write;
    let mut cf = CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    let utf16 = |s: &str| s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>();
    for (id, s) in strings {
        cf.create_stream(format!("/__substg1.0_{id:04X}001F")).unwrap().write_all(&utf16(s)).unwrap();
    }
    let mut props = vec![0u8; 32];
    let mut entry = |id: u16, kind: u16, v: [u8; 8]| {
        props.extend_from_slice(&(((id as u32) << 16) | kind as u32).to_le_bytes());
        props.extend_from_slice(&6u32.to_le_bytes());
        props.extend_from_slice(&v);
    };
    if let Some(t) = received {
        let ft = (t.timestamp() * 10_000_000 + 116_444_736_000_000_000) as u64;
        entry(0x0E06, 0x0040, ft.to_le_bytes());
    }
    let mut imp = [0u8; 8];
    imp[..4].copy_from_slice(&importance.to_le_bytes());
    entry(0x0017, 0x0003, imp);
    cf.create_stream("/__properties_version1.0").unwrap().write_all(&props).unwrap();
    for (i, (name, data)) in files.iter().enumerate() {
        let dir = format!("/__attach_version1.0_#{i:08X}");
        cf.create_storage(&dir).unwrap();
        cf.create_stream(format!("{dir}/__substg1.0_3707001F")).unwrap().write_all(&utf16(name)).unwrap();
        cf.create_stream(format!("{dir}/__substg1.0_37010102")).unwrap().write_all(data).unwrap();
    }
    cf.flush().unwrap();
    cf.into_inner().into_inner()
}
