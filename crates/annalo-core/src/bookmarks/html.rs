//! The Netscape bookmarks HTML file every browser exports („Lesezeichen exportieren“):
//! `<DT><H3>` starts a folder whose entries follow in the next `<DL>`, `<DT><A HREF>` is a
//! bookmark. The markup is loose (unclosed `<DT>`/`<p>`, any case), so this reads it as a
//! stream of tags instead of as a document.

use super::{Collector, MAX_DEPTH, Node, Tree};

pub fn parse(src: &str) -> Tree {
    let lower = src.to_ascii_lowercase();
    let mut c = Collector::default();
    // stack[0] holds the file's top level.
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut root_open = false;
    // A folder heading waiting for its `<DL>`.
    let mut pending: Option<Node> = None;
    let mut i = 0;
    while let Some(off) = src[i..].find('<') {
        let start = i + off;
        let Some(len) = src[start..].find('>') else { break };
        let end = start + len;
        let tag = &src[start + 1..end];
        i = end + 1;
        let (closing, name, attrs) = split_tag(tag);
        match (closing, name.as_str()) {
            (false, "h3") => {
                flush(&mut stack, &mut pending);
                let (text, next) = text_until(src, &lower, i, "</h3");
                i = next;
                let a = attributes(attrs);
                let role = if flag(&a, "personal_toolbar_folder") {
                    Some("bar")
                } else if flag(&a, "unfiled_bookmarks_folder") {
                    Some("other")
                } else {
                    None
                };
                let mut f = Node::folder(text.trim(), if stack.len() == 1 { role } else { None });
                f.added = attr(&a, "add_date").and_then(|v| v.trim().parse().ok());
                pending = Some(f);
            }
            (false, "a") => {
                flush(&mut stack, &mut pending);
                let (text, next) = text_until(src, &lower, i, "</a");
                i = next;
                let a = attributes(attrs);
                let Some(href) = attr(&a, "href") else { continue };
                let added = attr(&a, "add_date").and_then(|v| v.trim().parse::<i64>().ok());
                // Some exports write microseconds.
                let added = added.map(|t| if t > 100_000_000_000 { t / 1_000_000 } else { t });
                if let Some(n) = c.link(&text, href, added) {
                    stack.last_mut().expect("top level").children.push(n);
                }
            }
            (false, "dl") => match pending.take() {
                Some(f) if stack.len() <= MAX_DEPTH => stack.push(f),
                Some(f) => stack.last_mut().expect("top level").children.push(f),
                None if !root_open && stack.len() == 1 => root_open = true,
                None => stack.push(Node::default()),
            },
            (true, "dl") => {
                flush(&mut stack, &mut pending);
                if stack.len() > 1 {
                    let f = stack.pop().expect("open folder");
                    stack.last_mut().expect("top level").children.push(f);
                }
            }
            _ => {}
        }
    }
    flush(&mut stack, &mut pending);
    while stack.len() > 1 {
        let f = stack.pop().expect("open folder");
        stack.last_mut().expect("top level").children.push(f);
    }
    let top = stack.pop().expect("top level");
    c.finish(top.children)
}

/// A folder heading without a list (an empty folder) goes into the current folder as it is.
fn flush(stack: &mut [Node], pending: &mut Option<Node>) {
    if let Some(f) = pending.take() {
        stack.last_mut().expect("top level").children.push(f);
    }
}

/// `/a href=…` → (closing, "a", "href=…").
fn split_tag(tag: &str) -> (bool, String, &str) {
    let (closing, rest) = match tag.strip_prefix('/') {
        Some(r) => (true, r),
        None => (false, tag),
    };
    let name_end = rest.find(|ch: char| ch.is_whitespace() || ch == '/').unwrap_or(rest.len());
    (closing, rest[..name_end].to_ascii_lowercase(), &rest[name_end..])
}

/// The decoded text from `from` up to the closing tag `close` (lowercase), and where to go on.
fn text_until(src: &str, lower: &str, from: usize, close: &str) -> (String, usize) {
    let end = lower[from..].find(close).map_or(src.len(), |e| from + e);
    let raw = &src[from..end];
    // Tags inside the text (rare) are dropped.
    let mut text = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }
    let next = lower[end..].find('>').map_or(src.len(), |e| end + e + 1);
    (decode(text.split_whitespace().collect::<Vec<_>>().join(" ").as_str()), next)
}

/// Attributes as (lowercase name, decoded value).
fn attributes(s: &str) -> Vec<(String, String)> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' {
            i += 1;
        }
        if start == i {
            break;
        }
        let name = s[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            out.push((name, String::new()));
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let value = if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
            let q = b[i];
            let vs = i + 1;
            let ve = s[vs..].find(q as char).map_or(s.len(), |e| vs + e);
            i = (ve + 1).min(b.len());
            &s[vs..ve]
        } else {
            let vs = i;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            &s[vs..i]
        };
        out.push((name, decode(value)));
    }
    out
}

fn attr<'a>(a: &'a [(String, String)], name: &str) -> Option<&'a str> {
    a.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn flag(a: &[(String, String)], name: &str) -> bool {
    attr(a, name).is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

/// HTML entities: the named ones exports use, and numeric ones.
pub fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        rest = &rest[p..];
        let Some(semi) = rest.as_bytes().iter().take(12).position(|&b| b == b';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => ent.strip_prefix('#').and_then(|n| {
                let code = match n.strip_prefix(['x', 'X']) {
                    Some(h) => u32::from_str_radix(h, 16).ok(),
                    None => n.parse().ok(),
                };
                code.and_then(char::from_u32)
            }),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_are_decoded() {
        assert_eq!(decode("A &amp; B &lt;C&gt; &#228;&#xFC; &quot;x&quot; & y"), "A & B <C> äü \"x\" & y");
        assert_eq!(decode("&unknown; &#xZZ;"), "&unknown; &#xZZ;");
    }

    #[test]
    fn attributes_in_any_quoting() {
        let a = attributes(r#" HREF="https://a.de/?x=1&amp;y=2" ADD_DATE='17' private"#);
        assert_eq!(attr(&a, "href"), Some("https://a.de/?x=1&y=2"));
        assert_eq!(attr(&a, "add_date"), Some("17"));
        assert_eq!(attr(&a, "private"), Some(""));
    }

    #[test]
    fn unclosed_lists_still_end_up_in_the_tree() {
        let t = parse("<DL><DT><H3>Ordner</H3><DL><DT><A HREF=\"https://x.de\">X</A>");
        assert_eq!(t.roots.len(), 1);
        assert_eq!(t.roots[0].title, "Ordner");
        assert_eq!(t.roots[0].children[0].url.as_deref(), Some("https://x.de"));
    }
}
