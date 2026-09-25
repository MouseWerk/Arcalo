use chrono::{NaiveDate, TimeZone, Utc};

use super::*;

fn berlin() -> Zone {
    Zone::named("Europe/Berlin").unwrap()
}

// ------------------------------------------------------------------ Outlook script output

/// What the script prints for two selected mails on a German Outlook: non-ASCII as \u escapes,
/// an Exchange sender the script resolved and one it could not (X.500 address), attachments
/// as a list and as a single object, a mail without most fields.
const SELECTION: &str = r#"WARNING: profile noise
{"ok":true,"version":"16.0.0.17928","source":"selection","items":[
 {"entryId":"00000000AB12","storeId":"0000000038A1BB10","subject":"AW: Angebot f\u00fcr das Portal \u2013 R\u00fcckfrage","senderName":"M\u00fcller, Anna","senderEmail":"anna.mueller@example.com","to":"Kleindienst, Maurice; Wei\u00df, J\u00f6rg","cc":"","received":"2026-09-24T12:32:00Z","conversation":"Angebot f\u00fcr das Portal","importance":2,"categories":"Projekt X, Kunde","body":"Hallo Maurice,\r\n\r\nbitte pr\u00fcfe das Angebot bis Freitag.\r\n\r\nGr\u00fc\u00dfe\r\nAnna","truncated":false,"attachments":[{"index":1,"name":"Angebot 2026-09.pdf","size":48213,"type":1,"inline":false},{"index":2,"name":"image001.png","size":3120,"type":1,"inline":true}]},
 {"entryId":"00000000CD34","storeId":"0000000038A1BB10","subject":"Termin\u00e4nderung","senderName":"Wei\u00df, J\u00f6rg","senderEmail":"/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=4B2A-WEISS","to":"Kleindienst, Maurice","received":"2026-09-23T07:05:00Z","importance":"1","categories":"","body":"Kurz verschoben.","attachments":{"index":1,"name":"Einladung.ics","size":"912","inline":"False"}},
 {"entryId":"00000000EF56","subject":"","received":"4501-01-01T00:00:00Z"}
]}"#;

#[test]
fn outlook_output_becomes_mails() {
    let mails = outlook::parse_output(SELECTION).unwrap();
    assert_eq!(mails.len(), 3, "multiple selection");
    let a = &mails[0];
    assert_eq!(a.source, MailSource::Outlook);
    assert_eq!((a.entry_id.as_str(), a.store_id.as_str()), ("00000000AB12", "0000000038A1BB10"));
    assert_eq!(a.subject, "AW: Angebot für das Portal – Rückfrage");
    assert_eq!((a.from_name.as_str(), a.from_email.as_str()), ("Müller, Anna", "anna.mueller@example.com"));
    assert_eq!(a.to, ["Kleindienst, Maurice", "Weiß, Jörg"]);
    assert!(a.cc.is_empty());
    assert_eq!(a.received, Some(Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap()));
    assert_eq!(a.importance, 2);
    assert_eq!(a.categories, ["Projekt X", "Kunde"]);
    assert_eq!(a.body, "Hallo Maurice,\n\nbitte prüfe das Angebot bis Freitag.\n\nGrüße\nAnna", "CRLF normalized");
    assert_eq!(a.attachments.len(), 2);
    assert_eq!(
        (a.attachments[0].index, a.attachments[0].name.as_str(), a.attachments[0].size),
        (1, "Angebot 2026-09.pdf", 48213)
    );
    assert!(!a.attachments[0].inline && a.attachments[1].inline);

    let b = &mails[1];
    assert_eq!(b.from_name, "Weiß, Jörg");
    assert_eq!(b.from_email, "", "an unresolved X.500 address is no address");
    assert_eq!(b.sender_full(), "Weiß, Jörg");
    assert_eq!(b.to, ["Kleindienst, Maurice"], "a single recipient");
    assert_eq!((b.importance, b.store_id.as_str()), (1, "0000000038A1BB10"));
    assert_eq!(b.attachments.len(), 1, "a single attachment object");
    assert_eq!((b.attachments[0].size, b.attachments[0].inline), (912, false));

    let c = &mails[2];
    assert_eq!(
        (c.subject.as_str(), c.received, c.store_id.as_str()),
        ("", None, ""),
        "missing fields, Outlook's none date"
    );
    assert!(c.attachments.is_empty() && c.body.is_empty());
    assert_eq!(c.importance, 0, "importance missing: 0 as written");
}

#[test]
fn outlook_errors_become_german_messages() {
    let err = |code: &str| {
        outlook::parse_output(&format!(r#"{{"ok":false,"error":"{code}","message":"0x80040154"}}"#))
            .unwrap_err()
            .to_string()
    };
    assert!(err("not_running").contains("Outlook läuft nicht"));
    assert!(err("no_selection").contains("keine E-Mail markiert"));
    assert!(err("new_outlook").contains("neue Outlook") && err("new_outlook").contains(".msg"));
    assert!(err("not_installed").contains("nicht installiert"));
    assert!(err("server_exec").contains("Administrator"));
    assert!(err("not_found").contains("findet diese E-Mail nicht"));
    assert!(err("com").contains("0x80040154"));
    assert!(outlook::parse_output("Fehler").unwrap_err().to_string().contains("unlesbar"));
    // Items without an EntryID are no mails.
    assert!(
        outlook::parse_output(r#"{"ok":true,"items":[{"subject":"x"}]}"#)
            .unwrap_err()
            .to_string()
            .contains("keine E-Mail")
    );
    let saved =
        outlook::parse_saved(r#"{"ok":true,"files":{"index":2,"name":"a.pdf","path":"C:\\Temp\\2\\a.pdf"}}"#).unwrap();
    assert_eq!(saved, vec![(2, PathBuf::from("C:\\Temp\\2\\a.pdf"))]);
    assert!(
        outlook::parse_saved(r#"{"ok":false,"error":"save","message":"a.pdf: denied"}"#)
            .unwrap_err()
            .to_string()
            .contains("a.pdf: denied")
    );
}

#[test]
fn the_mail_script_is_ascii_and_has_its_modes() {
    assert!(outlook::SCRIPT.is_ascii(), "Windows PowerShell reads scripts without BOM as ANSI");
    for needle in [
        "[ValidateSet('read', 'save', 'open')]",
        "ActiveExplorer().Selection",
        "ActiveInspector()",
        "GetExchangeUser()",
        "PrimarySmtpAddress",
        "SaveAsFile(",
        "GetItemFromID(",
        ".Display(",
        "ToUniversalTime()",
        "not_running",
        "no_selection",
        "GetActiveObject('Outlook.Application')",
    ] {
        assert!(outlook::SCRIPT.contains(needle), "{needle}");
    }
    if std::env::var("ANNALO_TEST_FIXTURES").is_err() {
        assert_eq!(outlook::fixture_path(), None);
    }
}

// --------------------------------------------------------------------------------- .eml

const EML: &str = "From: =?utf-8?Q?M=C3=BCller=2C_Anna?= <anna.mueller@example.com>\r
To: \"Kleindienst, Maurice\" <maurice@example.com>, =?iso-8859-1?Q?J=F6rg_Wei=DF?= <joerg@example.com>\r
Cc: team@example.com\r
Subject: =?utf-8?B?QW5nZWJvdCBmw7xyIGRhcyBQb3J0YWwg4oCTIFLDvGNrZnJhZ2U=?=\r
Date: Thu, 24 Sep 2026 14:32:00 +0200\r
Importance: high\r
Thread-Topic: Angebot Portal\r
Keywords: Projekt X, Kunde\r
MIME-Version: 1.0\r
Content-Type: multipart/mixed; boundary=\"XYZ\"\r
\r
--XYZ\r
Content-Type: multipart/alternative; boundary=\"ALT\"\r
\r
--ALT\r
Content-Type: text/plain; charset=utf-8\r
Content-Transfer-Encoding: quoted-printable\r
\r
Hallo Maurice,\r
\r
bitte pr=C3=BCfe das Angebot bis Freitag. Gr=C3=BC=C3=9Fe aus K=C3=B6ln, ein l=\r
anger Satz.\r
\r
--ALT\r
Content-Type: text/html; charset=utf-8\r
\r
<p>Hallo Maurice</p>\r
--ALT--\r
\r
--XYZ\r
Content-Type: application/pdf; name=\"Angebot.pdf\"\r
Content-Disposition: attachment; filename*=utf-8''Angebot%20f%C3%BCr%20Portal.pdf\r
Content-Transfer-Encoding: base64\r
\r
JVBERi0xLjQKJcOkw7zDtsOfCg==\r
\r
--XYZ\r
Content-Type: image/png; name=\"logo.png\"\r
Content-Disposition: inline; filename=\"logo.png\"\r
Content-ID: <logo@example>\r
Content-Transfer-Encoding: base64\r
\r
iVBORw0KGgo=\r
--XYZ--\r
";

#[test]
fn eml_files_are_read_with_their_encodings_and_attachments() {
    let p = parse_file("Angebot.eml", EML.as_bytes()).unwrap();
    let m = &p.mail;
    assert_eq!(m.source, MailSource::Eml);
    assert_eq!(m.file_name, "Angebot.eml");
    assert_eq!(m.subject, "Angebot für das Portal – Rückfrage", "base64 encoded word");
    assert_eq!(
        (m.from_name.as_str(), m.from_email.as_str()),
        ("Müller, Anna", "anna.mueller@example.com"),
        "Q encoded name"
    );
    assert_eq!(m.to, ["Kleindienst, Maurice", "Jörg Weiß"], "ISO-8859-1 encoded word");
    assert_eq!(m.cc, ["team@example.com"]);
    assert_eq!(m.received, Some(Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap()));
    assert_eq!(m.importance, 2);
    assert_eq!(m.conversation, "Angebot Portal");
    assert_eq!(m.categories, ["Projekt X", "Kunde"]);
    assert!(
        m.body.starts_with("Hallo Maurice,\n\nbitte prüfe das Angebot bis Freitag. Grüße aus Köln, ein langer Satz."),
        "{:?}",
        m.body
    );
    assert_eq!(m.attachments.len(), 2);
    assert_eq!(m.attachments[0].name, "Angebot für Portal.pdf", "RFC 2231 file name");
    assert_eq!(p.parts[0], b"%PDF-1.4\n%\xc3\xa4\xc3\xbc\xc3\xb6\xc3\x9f\n", "base64 decoded");
    assert_eq!(m.attachments[0].size, p.parts[0].len() as u64);
    assert!(!m.attachments[0].inline);
    assert!(m.attachments[1].inline, "inline image with a content id");
}

#[test]
fn html_only_and_broken_files() {
    let html = "From: a@example.com\nSubject: Nur HTML\nX-Priority: 5 (Lowest)\nContent-Type: text/html; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\n<html><body><p>Gr=FC=DFe<br>und <b>Danke</b></p></body></html>\n";
    let p = parse_file("x.eml", html.as_bytes()).unwrap();
    assert_eq!(p.mail.subject, "Nur HTML");
    assert!(
        p.mail.body.contains("Grüße") && p.mail.body.contains("Danke") && !p.mail.body.contains("<b>"),
        "{}",
        p.mail.body
    );
    assert_eq!(p.mail.importance, 0);
    assert_eq!(p.mail.from_email, "a@example.com");
    assert!(parse_file("x.eml", b"").unwrap_err().to_string().contains("leer"));
    assert!(parse_file("x.eml", b"\x00\x01\x02 kein Text").is_err());
    assert!(parse_file("x.msg", b"From: a@b\n\nText").unwrap_err().to_string().contains(".msg"));
}

// --------------------------------------------------------------------------------- .msg

#[test]
fn msg_files_are_read_best_effort() {
    let when = Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap();
    let bytes = msg::build(
        &[
            (0x0037, "Angebot für das Portal"),
            (0x0C1A, "Müller, Anna"),
            (0x0C1F, "/O=EXCHANGELABS/OU=X/CN=RECIPIENTS/CN=MUELLER"),
            (0x5D01, "anna.mueller@example.com"),
            (0x0E04, "Kleindienst, Maurice; Weiß, Jörg"),
            (0x0E03, "Team"),
            (0x1000, "Hallo,\r\nbitte prüfen.\r\n"),
            (0x0070, "Angebot Portal"),
        ],
        Some(when),
        2,
        &[("Angebot.pdf", b"%PDF-1.4"), ("Übersicht.xlsx", b"PK\x03\x04")],
    );
    assert!(msg::is_compound(&bytes));
    let p = parse_file("Angebot.msg", &bytes).unwrap();
    let m = &p.mail;
    assert_eq!(m.source, MailSource::Msg);
    assert_eq!(m.subject, "Angebot für das Portal");
    assert_eq!(
        (m.from_name.as_str(), m.from_email.as_str()),
        ("Müller, Anna", "anna.mueller@example.com"),
        "SMTP before X.500"
    );
    assert_eq!(m.to, ["Kleindienst, Maurice", "Weiß, Jörg"]);
    assert_eq!(m.cc, ["Team"]);
    assert_eq!(m.received, Some(when));
    assert_eq!(m.importance, 2);
    assert_eq!(m.body, "Hallo,\nbitte prüfen.");
    assert_eq!(m.attachments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["Angebot.pdf", "Übersicht.xlsx"]);
    assert_eq!(p.parts[1], b"PK\x03\x04");
    // A compound file that is no mail.
    let empty = msg::build(&[], None, 1, &[]);
    assert!(parse_file("leer.msg", &empty).unwrap_err().to_string().contains("Outlook-Nachricht"));
}

// ------------------------------------------------------------------------ pasted headers

#[test]
fn german_outlook_header_blocks_are_read() {
    let text = "Siehe unten.\n\n-----Ursprüngliche Nachricht-----\nVon: Müller, Anna <anna.mueller@example.com>\nGesendet: Donnerstag, 24. September 2026 14:32\nAn: Kleindienst, Maurice <maurice@example.com>; Weiß, Jörg\n <joerg@example.com>\nCc: Team Portal\nBetreff: AW: Angebot Portal\nWichtigkeit: Hoch\n\nHallo Maurice,\nbitte bis Freitag prüfen.\n";
    let m = paste::parse(text, &berlin()).unwrap();
    assert_eq!(m.source, MailSource::Text);
    assert_eq!((m.from_name.as_str(), m.from_email.as_str()), ("Müller, Anna", "anna.mueller@example.com"));
    assert_eq!(m.received, Some(Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap()), "local time in Berlin");
    assert_eq!(m.to, ["Kleindienst, Maurice", "Weiß, Jörg"], "the wrapped address belongs to the name before");
    assert_eq!(m.cc, ["Team Portal"]);
    assert_eq!(m.subject, "AW: Angebot Portal");
    assert_eq!(m.importance, 2);
    assert_eq!(m.body, "Hallo Maurice,\nbitte bis Freitag prüfen.");
}

#[test]
fn english_outlook_header_blocks_are_read() {
    let text = "> From: John Smith [mailto:john.smith@example.com]\r\n> Sent: Thursday, September 24, 2026 2:32 PM\r\n> To: Kleindienst, Maurice\r\n> Subject: RE: Budget Q4\r\n> Importance: Low\r\n>\r\n> Please send the numbers.";
    let m = paste::parse(text, &berlin()).unwrap();
    assert_eq!((m.from_name.as_str(), m.from_email.as_str()), ("John Smith", "john.smith@example.com"));
    assert_eq!(m.received, Some(Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap()));
    assert_eq!(m.to, ["Kleindienst, Maurice"]);
    assert_eq!((m.subject.as_str(), m.importance), ("RE: Budget Q4", 0));
    assert!(m.body.contains("Please send the numbers."));
    // Dates as written elsewhere.
    let d = |s: &str| paste::parse_date(s);
    let at = |y, mo, da, h, mi| NaiveDate::from_ymd_opt(y, mo, da).unwrap().and_hms_opt(h, mi, 0).unwrap();
    assert_eq!(d("24.09.2026 14:32"), Some(at(2026, 9, 24, 14, 32)));
    assert_eq!(d("Mittwoch, 3. März 2027 09:05"), Some(at(2027, 3, 3, 9, 5)));
    assert_eq!(d("Tuesday, December 1, 2026 12:10 AM"), Some(at(2026, 12, 1, 0, 10)));
    assert_eq!(d("Mo 5. Okt. 2026 17:00"), Some(at(2026, 10, 5, 17, 0)));
    assert_eq!(d("irgendwann"), None);
    // Not a header block.
    assert!(paste::parse("Von: hier bis dort\nsind es 5 km", &berlin()).is_none());
    assert!(paste::parse("Einfach ein Text", &berlin()).is_none());
}

// ------------------------------------------------------------------------ links, export

fn sample() -> Mail {
    Mail {
        source: MailSource::Outlook,
        entry_id: "00000000AB12".into(),
        store_id: "STORE".into(),
        subject: "Angebot [Portal] #42 Rückfrage".into(),
        from_name: "Müller, Anna".into(),
        from_email: "anna.mueller@example.com".into(),
        to: vec!["Kleindienst, Maurice".into()],
        received: Some(Utc.with_ymd_and_hms(2026, 9, 24, 12, 32, 0).unwrap()),
        importance: 2,
        categories: vec!["Projekt X".into()],
        body: "Hallo,\n\nbitte prüfen.\n#wichtig bleibt Text".into(),
        attachments: vec![MailAttachment { index: 1, name: "Angebot.pdf".into(), size: 10, ..Default::default() }],
        ..Default::default()
    }
}

#[test]
fn link_text_is_safe_and_the_export_writes_only_the_text() {
    let text = link_text(&sample(), &berlin());
    assert_eq!(text, "E-Mail: Angebot (Portal) ＃42 Rückfrage (Müller, Anna, 24.09.2026)");
    let md = format!(
        "- [ ] Prüfen {} due:2026-09-25\n\nSiehe [Doku](https://x.de) und {}.",
        link_markdown("k3v9x2qa", &text),
        link_markdown("zz11", "E-Mail: Kurz")
    );
    assert_eq!(link_ids(&md), ["k3v9x2qa", "zz11"]);
    assert_eq!(
        export_text(&md),
        "- [ ] Prüfen E-Mail: Angebot (Portal) ＃42 Rückfrage (Müller, Anna, 24.09.2026) due:2026-09-25\n\nSiehe [Doku](https://x.de) und E-Mail: Kurz."
    );
    assert_eq!(export_text("ohne Links"), "ohne Links");
    assert_eq!(export_text("[x](annalo-mail://)"), "[x](annalo-mail://)", "no id, no link");
    let anon = Mail { subject: " ".into(), ..Default::default() };
    assert_eq!(link_text(&anon, &berlin()), "E-Mail: (ohne Betreff)");
}

#[test]
fn tasks_go_below_the_task_section() {
    let spec = TaskSpec {
        target: TaskTarget::Daily,
        text: "Angebot [prüfen]".into(),
        due: Some("2026-09-25".into()),
        priority: 2,
    };
    let line =
        task_line(&spec, Some("[E-Mail: A](annalo-mail://abc)"), "NP-8801/1020", &["Projekt X".into(), "123".into()]);
    assert_eq!(
        line,
        "- [ ] Angebot (prüfen) [E-Mail: A](annalo-mail://abc) (NP-8801/1020) due:2026-09-25 !! #projekt-x"
    );
    let parsed = crate::tasks::parse_tasks(&line);
    assert_eq!((parsed[0].due.as_deref(), parsed[0].priority), (Some("2026-09-25"), 2));
    assert_eq!(parsed[0].tags, ["projekt-x"]);

    let daily = "# Tag\n\n## Aufgaben\n\n- [ ] alt\n\n## Notizen\n\nText\n";
    assert_eq!(insert_task(daily, "- [ ] neu"), "# Tag\n\n## Aufgaben\n\n- [ ] alt\n- [ ] neu\n\n## Notizen\n\nText\n");
    let empty = "## Aufgaben\n\n- [ ] \n\n## Notizen\n";
    assert_eq!(
        insert_task(empty, "- [ ] neu"),
        "## Aufgaben\n\n- [ ] neu\n\n## Notizen\n",
        "the placeholder is replaced"
    );
    assert_eq!(insert_task("## Tasks\n## Rest\n", "- [ ] neu"), "## Tasks\n\n- [ ] neu\n## Rest\n");
    assert_eq!(insert_task("Absatz", "- [ ] neu"), "Absatz\n\n- [ ] neu\n");
    assert_eq!(insert_task("- a\n", "- [ ] neu"), "- a\n- [ ] neu\n");
    assert_eq!(insert_task("", "- [ ] neu"), "- [ ] neu\n");
    assert_eq!(
        (tag_of("#Projekt X"), tag_of("Kunde: ABC"), tag_of("2026")),
        ("projekt-x".into(), "kunde-abc".into(), String::new())
    );
}

#[test]
fn a_mail_becomes_note_and_task_with_one_link() {
    let db = Database::open_in_memory().unwrap();
    let zone = berlin();
    let now = Utc.with_ymd_and_hms(2026, 9, 25, 8, 0, 0).unwrap();
    let page = db.create_page(None, "Portal", None).unwrap();
    db.save_page_content(page.id, "Intro\n\n## Aufgaben\n\n- [ ] alt\n").unwrap();
    let settings = MailSettings::default();
    let files = StoredFiles { original: None, attachments: vec!["Angebot.pdf".into()] };
    let req = MailImport {
        mail: sample(),
        task: Some(TaskSpec {
            target: TaskTarget::Page { id: page.id },
            text: "Angebot prüfen".into(),
            due: Some("2026-09-26".into()),
            priority: 2,
        }),
        note: Some(NoteSpec::default()),
        vorgang: "NP-8801/1020".into(),
        tags: vec!["Projekt X".into()],
        attachments: vec![1],
    };
    let out = db.mail_create(&req, &files, &settings, Some("#vertraulich"), &zone, now).unwrap();
    let id = out.link.clone().unwrap();
    assert_eq!(id.len(), 8);
    let note = out.note_page.unwrap();
    assert_eq!(note.title, "Angebot (Portal) ＃42 Rückfrage");
    let parent = db.page(note.parent_id.unwrap()).unwrap();
    assert_eq!((parent.title.as_str(), parent.icon.as_deref()), ("E-Mails", Some("mail")));
    let content = db.page_doc(note.id).unwrap().content;
    assert!(content.starts_with("---\nvon: \"Müller, Anna <anna.mueller@example.com>\"\nan: \"Kleindienst, Maurice\"\ndatum: 2026-09-24 14:32\nbetreff: \"Angebot [Portal] #42 Rückfrage\"\n"), "{content}");
    assert!(
        content.contains(&format!(
            "e-mail: annalo-mail://{id}\nvorgang: NP-8801/1020\ntags: [e-mail, projekt-x, vertraulich]\n---\n"
        )),
        "{content}"
    );
    assert!(content.contains(&format!("[E-Mail: Angebot (Portal) ＃42 Rückfrage (Müller, Anna, 24.09.2026)](annalo-mail://{id})\n\n> Hallo,\n>\n> bitte prüfen.\n> #wichtig bleibt Text\n")));
    assert!(content.contains("## Anhänge\n\n![[Angebot.pdf]]\n"));
    let doc = db.page_doc(note.id).unwrap();
    assert!(doc.tags.contains(&"vertraulich".to_owned()), "private marker as tag: {:?}", doc.tags);
    assert!(crate::ai::privacy::page_is_private(&db, note.id, &["#vertraulich".into()]).unwrap());

    let task_page = out.task_page.unwrap();
    assert_eq!(task_page.id, page.id);
    let text = db.page_doc(page.id).unwrap().content;
    assert!(
        text.contains(&format!("- [ ] alt\n- [ ] Angebot prüfen [E-Mail: Angebot (Portal) ＃42 Rückfrage (Müller, Anna, 24.09.2026)](annalo-mail://{id}) [[{}]] due:2026-09-26 !! #projekt-x\n", note.title)),
        "{text}"
    );
    let tasks = db.list_tasks(&crate::tasks::TaskFilter { page_id: Some(page.id), ..Default::default() }).unwrap();
    let mut dues: Vec<_> = tasks.iter().map(|t| t.due.as_deref()).collect();
    dues.sort();
    assert_eq!(dues, [None, Some("2026-09-26")]);

    // The link row, reused for the same Outlook item.
    let link = db.mail_link(&id).unwrap();
    assert_eq!(
        (link.entry_id.as_str(), link.store_id.as_str(), link.vorgang.as_str()),
        ("00000000AB12", "STORE", "NP-8801/1020")
    );
    assert_eq!(link.subject, "Angebot [Portal] #42 Rückfrage");
    let again = MailImport {
        task: Some(TaskSpec { target: TaskTarget::Daily, text: "Nachfassen".into(), due: None, priority: 0 }),
        note: None,
        ..req.clone()
    };
    let out2 = db.mail_create(&again, &StoredFiles::default(), &settings, None, &zone, now).unwrap();
    assert_eq!(out2.link.as_deref(), Some(id.as_str()));
    let daily = out2.task_page.unwrap();
    assert_eq!(daily.daily_date.as_deref(), Some("2026-09-25"));
    assert!(db.page_doc(daily.id).unwrap().content.contains(&format!("- [ ] Nachfassen [E-Mail: Angebot (Portal) ＃42 Rückfrage (Müller, Anna, 24.09.2026)](annalo-mail://{id}) (NP-8801/1020) #projekt-x")));
    // A second note of the same subject gets the date.
    let out3 = db.mail_create(&MailImport { task: None, ..req.clone() }, &files, &settings, None, &zone, now).unwrap();
    assert_eq!(out3.note_page.unwrap().title, "Angebot (Portal) ＃42 Rückfrage 24.09.2026");
    assert!(db.mail_link("fehlt").is_err());
}

#[test]
fn pasted_and_file_mails_link_as_they_can() {
    let db = Database::open_in_memory().unwrap();
    let zone = berlin();
    let now = Utc.with_ymd_and_hms(2026, 9, 25, 8, 0, 0).unwrap();
    let settings = MailSettings { private_notes: false, notes_parent: "Posteingang".into(), ..Default::default() };
    // Pasted: nothing to open, no link, the task goes into the note.
    let pasted = Mail {
        source: MailSource::Text,
        subject: "Budget".into(),
        from_name: "John".into(),
        body: "Text".into(),
        ..Default::default()
    };
    let req = MailImport {
        mail: pasted,
        task: Some(TaskSpec { target: TaskTarget::Note, text: "Zahlen senden".into(), due: None, priority: 0 }),
        note: Some(NoteSpec { parent: String::new(), title: "Budget Q4".into() }),
        ..Default::default()
    };
    let out = db.mail_create(&req, &StoredFiles::default(), &settings, Some("#vertraulich"), &zone, now).unwrap();
    assert_eq!(out.link, None);
    assert!(out.task_page.is_none());
    let note = out.note_page.unwrap();
    assert_eq!(note.title, "Budget Q4");
    assert_eq!(db.page(note.parent_id.unwrap()).unwrap().title, "Posteingang");
    let content = db.page_doc(note.id).unwrap().content;
    assert!(!content.contains("annalo-mail") && !content.contains("vertraulich"), "{content}");
    assert!(content.ends_with("## Notizen\n\n- [ ] Zahlen senden\n"), "{content}");

    // An .eml: the stored file is the link target.
    let eml = Mail { source: MailSource::Eml, subject: "Datei".into(), ..Default::default() };
    let files = StoredFiles { original: Some("Datei.eml".into()), attachments: vec![] };
    let req = MailImport { mail: eml, note: Some(NoteSpec::default()), ..Default::default() };
    let out = db.mail_create(&req, &files, &settings, None, &zone, now).unwrap();
    let link = db.mail_link(out.link.as_deref().unwrap()).unwrap();
    assert_eq!((link.source, link.file.as_str()), (MailSource::Eml, "Datei.eml"));
    assert!(db.page_doc(out.note_page.unwrap().id).unwrap().content.contains("Original: [[Datei.eml]]"));

    // Refused requests.
    let none = MailImport::default();
    assert!(
        db.mail_create(&none, &StoredFiles::default(), &settings, None, &zone, now)
            .unwrap_err()
            .to_string()
            .contains("Aufgabe")
    );
    let into_note = MailImport {
        task: Some(TaskSpec { target: TaskTarget::Note, text: "x".into(), due: None, priority: 0 }),
        ..Default::default()
    };
    assert!(db.mail_create(&into_note, &StoredFiles::default(), &settings, None, &zone, now).is_err());
}

#[test]
fn files_are_staged_below_the_temp_folder_only() {
    let root = std::env::temp_dir().join(format!("annalo-mail-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let parsed = parse_file("Angebot.eml", EML.as_bytes()).unwrap();
    let mail = stage(&root, "Angebot.eml", EML.as_bytes(), parsed).unwrap();
    assert!(mail.file.ends_with("/Angebot.eml") && mail.file.len() == 16 + 1 + "Angebot.eml".len());
    let original = temp_file(&root, &mail.file).unwrap();
    assert_eq!(std::fs::read(original).unwrap(), EML.as_bytes());
    let pdf = temp_file(&root, &mail.attachments[0].file).unwrap();
    assert!(pdf.ends_with("1/Angebot für Portal.pdf"));
    for bad in ["../x", "abc/Angebot.eml", "/etc/passwd", &format!("{}/../../x", &mail.file[..16]), ""] {
        assert!(temp_file(&root, bad).is_none(), "{bad}");
    }
    clean_temp(&root, std::time::Duration::ZERO);
    assert!(temp_file(&root, &mail.file).is_none(), "cleaned");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn suggestions_are_read_from_json_or_text() {
    let today = NaiveDate::from_ymd_opt(2026, 9, 25).unwrap();
    let (system, user) = suggestion_messages(&sample(), today);
    assert!(system.contains("2026-09-25 (Freitag)") && system.contains("JSON"));
    assert!(user.contains("Betreff: Angebot [Portal]") && user.contains("bitte prüfen"));
    let s = parse_suggestion("```json\n{\"aufgabe\": \"Angebot [Portal] prüfen\", \"faellig\": \"2026-09-30\"}\n```")
        .unwrap();
    assert_eq!(s, Suggestion { task: "Angebot (Portal) prüfen".into(), due: Some("2026-09-30".into()) });
    let s = parse_suggestion("{\"aufgabe\": \"Rückruf\", \"faellig\": null}").unwrap();
    assert_eq!(s.due, None);
    assert_eq!(parse_suggestion("Zahlen senden\nweil …").unwrap().task, "Zahlen senden");
    assert_eq!(parse_suggestion("{\"aufgabe\": \"\"}"), None);
    assert_eq!(parse_suggestion("  "), None);
}

#[test]
fn settings_are_normalized() {
    let s = MailSettings {
        notes_parent: "  ".into(),
        shortcut: " Ctrl+Shift+M ".into(),
        default_action: "x".into(),
        ..Default::default()
    }
    .normalized();
    assert_eq!(
        (s.notes_parent.as_str(), s.shortcut.as_str(), s.default_action.as_str()),
        ("E-Mails", "Ctrl+Shift+M", "task")
    );
    assert!(!MailSettings::default().save_attachments && MailSettings::default().shortcut.is_empty());
}

#[test]
fn the_markdown_export_writes_the_link_text_the_mirror_keeps_the_link() {
    let db = Database::open_in_memory().unwrap();
    let page = db.create_page(None, "Portal", None).unwrap();
    let md = "- [ ] Prüfen [E-Mail: Angebot (Anna, 24.09.2026)](annalo-mail://k3v9x2qa)\n";
    db.save_page_content(page.id, md).unwrap();
    let dir = std::env::temp_dir().join(format!("annalo-mail-export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    crate::vault::export_vault(&db, &dir, &dir.join("att")).unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.join("Portal.md")).unwrap(),
        "- [ ] Prüfen E-Mail: Angebot (Anna, 24.09.2026)\n"
    );
    // The mirror (Git sync takes its files back) writes the page as it is.
    let mirror = dir.join("mirror");
    crate::vault::export_snapshot(&crate::vault::VaultSnapshot::read(&db).unwrap(), &mirror, &dir.join("att")).unwrap();
    assert_eq!(std::fs::read_to_string(mirror.join("Portal.md")).unwrap(), md);
    let _ = std::fs::remove_dir_all(&dir);
}
