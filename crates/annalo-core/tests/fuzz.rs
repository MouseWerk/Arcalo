//! Parsers that see text from outside (notes, pasted pages, provider URLs, certificates) must
//! never panic: release builds abort on a panic, which would close the app with unsaved text.

use annalo_core::*;

#[rustfmt::skip]
const TOK: &[&str] = &[
    "---", "\n", "\n", " ", "  ", "- ", "- [ ] ", "- [x] ", "# ", "## ", "```", "`", "[[", "]]", "![[", "|", "#", "!",
    "due:2026-10-01", "ä", "ö", "ß", "€", "😀", "é", "&amp;", "&", "&#x", ";", "{{", "}}", ":", "[", "]", "(", ")",
    "](", "![a](b%20c.png)", "%", "%e2", "<title>", "</title>", "<meta property=\"og:title\" content=\"", "\">",
    "file://", "/", "C:", "http://x/", "tags:", "/zeit", "NP-1", "2h", "@", "x", "abc", "1.", "> ", "\r\n", "\t",
    "a.png", "Angebot.pdf", "[x](y.pdf)", "^",
];

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn text(&mut self) -> String {
        let n = (self.next() % 60) as usize;
        (0..n).map(|_| TOK[(self.next() % TOK.len() as u64) as usize]).collect()
    }
}

#[test]
fn parsers_never_panic() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 24).unwrap();
    for i in 0..20_000 {
        let (a, b, c) = (r.text(), r.text(), r.text());
        let res = std::panic::catch_unwind(|| {
            notes::wiki_links(&a);
            notes::tags(&a);
            notes::chunks(&a);
            notes::replace_link_target(&a, "x", "neu");
            notes::clean_title(&a);
            tasks::parse_tasks(&a);
            merge::merge3(Some(&a), &b, &c);
            properties::page_entries(&a);
            let _ = zeit::parse(&format!("/zeit {a}"), today);
            attachments::embeds(&a);
            let _ = attachments::clean_name(&a);
            attachment_manager::referenced_files(&a);
            attachment_manager::replace_file_refs(&a, "b c.png", "neu (1).png");
            let _ = linktitle::parse_title(&a);
            linktitle::decode_entities(&a);
            let _ = gitsync::redact(&a, Some("tok"));
            let link = settings::QuickLink { name: String::new(), url: a.clone(), icon: String::new() };
            let _ = link.target();
            let _ = ai::provider::AiProvider::ollama("o", &a).root();
            let _ = network::ca_info(a.as_bytes());
        });
        assert!(res.is_ok(), "iteration {i}: a={a:?} b={b:?} c={c:?}");
    }
}
