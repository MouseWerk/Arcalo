//! The generated part of a page the app writes again („Aktualisieren“): it stands between two
//! HTML comments on lines of their own, which the editor keeps verbatim (raw HTML blocks). A
//! refresh replaces only what is between them; text above and below is the user's and stays.
//! When the markers are gone (deleted in the editor), the new block goes below the first
//! heading (or the front matter) and nothing of the page is lost.

/// The line opening the generated part.
pub const BEGIN: &str = "<!-- arcalo:auto -->";
/// The line closing it.
pub const END: &str = "<!-- /arcalo:auto -->";

/// `body` wrapped in the markers (with the blank lines the editor writes around raw HTML).
pub fn wrap(body: &str) -> String {
    format!("{BEGIN}\n\n{}\n\n{END}", body.trim())
}

/// Byte ranges of the opening and the closing marker line (both on lines of their own, in
/// this order, outside code blocks).
fn markers(content: &str) -> Option<(usize, usize, usize)> {
    let mut begin = None;
    let mut fence = false;
    let mut at = 0;
    for line in content.split_inclusive('\n') {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        } else if !fence && t == BEGIN && begin.is_none() {
            begin = Some(at);
        } else if !fence
            && t == END
            && let Some(b) = begin
        {
            return Some((b, at, at + line.len()));
        }
        at += line.len();
    }
    None
}

/// The generated part of `content` (without the markers), if the page has one.
pub fn current(content: &str) -> Option<&str> {
    let (b, e, _) = markers(content)?;
    let inner = &content[b..e];
    let inner = inner.split_once('\n').map_or("", |(_, rest)| rest);
    Some(inner.trim())
}

/// `content` with its generated part replaced by `body`. Without markers the block goes below
/// the front matter and the first `# heading` (when the page starts with one), else first.
pub fn replace(content: &str, body: &str) -> String {
    let block = wrap(body);
    if let Some((b, _, end)) = markers(content) {
        let mut out = String::with_capacity(content.len() + block.len());
        out.push_str(&content[..b]);
        out.push_str(&block);
        let rest = &content[end..];
        if !rest.is_empty() {
            out.push('\n');
            out.push_str(rest);
        } else {
            out.push('\n');
        }
        return out;
    }
    let (head, rest) = split_head(content);
    let mut out = String::from(head);
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push_str(if out.ends_with('\n') { "\n" } else { "\n\n" });
    }
    out.push_str(&block);
    out.push('\n');
    let rest = rest.trim_start_matches('\n');
    if !rest.is_empty() {
        out.push('\n');
        out.push_str(rest);
    }
    out
}

/// The front matter and a first `# heading` (with their line ends), and the rest.
fn split_head(content: &str) -> (&str, &str) {
    let mut at = 0;
    if content.starts_with("---\n")
        && let Some(close) = content[4..].find("\n---\n")
    {
        at = 4 + close + 5;
    }
    let after = &content[at..];
    let skip = after.len() - after.trim_start_matches('\n').len();
    let line_end = after[skip..].find('\n').map_or(after.len(), |n| skip + n + 1);
    if after[skip..].starts_with("# ") {
        at += line_end;
    }
    content.split_at(at)
}

/// The page without the markers (Markdown export): the generated part reads like the rest.
pub fn strip_markers(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut after_marker = false;
    for line in content.lines() {
        let t = line.trim();
        if t == BEGIN || t == END {
            after_marker = true;
            continue;
        }
        if t.is_empty() && after_marker {
            continue;
        }
        after_marker = false;
        out.push_str(line);
        out.push('\n');
    }
    out
}
