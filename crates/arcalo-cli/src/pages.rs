//! Pages, daily notes, tags and the trash.

use std::io::Read;

use arcalo_core::external::Change;
use arcalo_core::model::{Page, PageNode};
use arcalo_core::properties::{self, Yaml};
use arcalo_core::{Database, Error, Result, attachment_manager, capture, tr, trf};
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;

use crate::model::{BacklinkOut, PageDocOut, PageOut, Pages, local};
use crate::output::{Failure, Outcome};
use crate::{Body, Ctx, DailyCmd, PagesCmd, TagsCmd, TrashCmd};

/// A version younger than this is not followed by another one before a change from the command
/// line: a burst of commands keeps the text from before the first of them.
const VERSION_GAP_SECONDS: i64 = 60;

/// The Markdown of `body` (or `text`, given without an option); `None` when none was given.
pub fn read_body(body: &Body, text: Option<&str>) -> Outcome<Option<String>> {
    let given = [body.body.is_some(), body.file.is_some(), body.stdin, text.is_some()];
    if given.iter().filter(|g| **g).count() > 1 {
        return Err(Failure::Usage(
            tr!(
                "Den Text nur auf eine Art angeben: als Argument, mit --body, --file oder --stdin",
                "Give the text one way only: as an argument, with --body, --file or --stdin"
            )
            .into(),
        ));
    }
    if let Some(b) = &body.body {
        return Ok(Some(b.clone()));
    }
    if let Some(f) = &body.file {
        return Ok(Some(std::fs::read_to_string(f).map_err(|e| Error::file(f, e))?));
    }
    if body.stdin {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        return Ok(Some(s));
    }
    Ok(text.map(str::to_owned))
}

fn missing_text() -> Failure {
    Failure::Usage(
        tr!(
            "Der Text fehlt: als Argument, mit --body, --file oder --stdin",
            "The text is missing: as an argument, with --body, --file or --stdin"
        )
        .into(),
    )
}

fn required(text: Option<String>) -> Outcome<String> {
    text.filter(|t| !t.trim().is_empty()).ok_or_else(missing_text)
}

/// A day: `YYYY-MM-DD`, `today`/`heute`, `yesterday`/`gestern`, `tomorrow`/`morgen`.
pub fn day(s: &str) -> Outcome<NaiveDate> {
    let today = chrono::Local::now().date_naive();
    match s.trim().to_lowercase().as_str() {
        "today" | "heute" => Ok(today),
        "yesterday" | "gestern" => Ok(today - Duration::days(1)),
        "tomorrow" | "morgen" => Ok(today + Duration::days(1)),
        other => NaiveDate::parse_from_str(other, "%Y-%m-%d").map_err(|_| {
            Failure::Usage(trf!(
                "Kein Datum: {s} (erwartet YYYY-MM-DD, today, yesterday oder tomorrow)",
                "Not a date: {s} (expected YYYY-MM-DD, today, yesterday or tomorrow)"
            ))
        }),
    }
}

pub fn day_or_today(s: Option<&str>) -> Outcome<NaiveDate> {
    s.map_or_else(|| Ok(chrono::Local::now().date_naive()), day)
}

/// Keeps the page's text from before a change of the command line as a version, so the change
/// can be undone in the app („Versionen“), unless a version was kept within the last minute.
fn keep_version(db: &Database, id: i64) -> Result<()> {
    let recent = db
        .list_versions(id)?
        .first()
        .is_some_and(|v| Utc::now() - v.created_at < Duration::seconds(VERSION_GAP_SECONDS));
    if !recent {
        db.snapshot_page(id)?;
    }
    Ok(())
}

/// Saves a page's new Markdown as the editor does (a canvas must stay a valid canvas), after
/// keeping the old one as a version.
pub fn save(db: &Database, id: i64, content: &str) -> Result<()> {
    keep_version(db, id)?;
    db.save_page(id, content).map(|_| ())
}

/// The page's Markdown, refused for a canvas (its content is a JSON Canvas document).
fn note_content(db: &Database, id: i64) -> Result<String> {
    let doc = db.page_doc(id)?;
    if doc.page.kind.as_deref() == Some(arcalo_core::canvas::KIND) {
        return Err(Error::State(trf!(
            "„{}“ ist eine Canvas: ihr Inhalt lässt sich nur als Ganzes ersetzen (pages replace --whole)",
            "“{}” is a canvas: its content can only be replaced as a whole (pages replace --whole)",
            doc.page.title
        )));
    }
    Ok(doc.content)
}

fn page_changed(id: i64) -> Change {
    Change { pages: vec![id], ..Default::default() }
}

fn tree_changed(ids: &[i64]) -> Change {
    Change { pages: ids.to_vec(), tree: true, ..Default::default() }
}

/// The page `id` as printed (read again after a change).
fn out_of(ctx: &Ctx, id: i64) -> Outcome<PageOut> {
    let pages = Pages::load(&ctx.ws.db)?;
    let page = ctx.ws.db.page(id)?;
    Ok(pages.out(&page))
}

fn show_page(ctx: &Ctx, page: &PageOut) -> Outcome<()> {
    ctx.out.show(page, |p| format!("id:{}  {}", p.id, p.path))
}

fn doc_out(ctx: &Ctx, pages: &Pages, id: i64) -> Outcome<PageDocOut> {
    let db = &ctx.ws.db;
    let doc = db.page_doc(id)?;
    let mut links = db.outgoing_links(id, &doc.content)?;
    links.dedup();
    Ok(PageDocOut {
        page: pages.out(&doc.page),
        links,
        unresolved_links: doc.unresolved_links,
        tags: doc.tags,
        backlinks: doc
            .backlinks
            .into_iter()
            .map(|b| BacklinkOut { id: b.page_id, title: b.title, context: b.context })
            .collect(),
        content: doc.content,
    })
}

/// A tree node as printed.
#[derive(Serialize)]
struct NodeOut {
    #[serde(flatten)]
    page: PageOut,
    children: Vec<NodeOut>,
}

fn node_out(pages: &Pages, n: &PageNode) -> NodeOut {
    NodeOut { page: pages.out(&n.page), children: n.children.iter().map(|c| node_out(pages, c)).collect() }
}

fn tree_text(nodes: &[NodeOut], depth: usize, out: &mut String) {
    for n in nodes {
        out.push_str(&format!("{}{}  id:{}\n", "  ".repeat(depth), n.page.title, n.page.id));
        tree_text(&n.children, depth + 1, out);
    }
}

fn flatten(nodes: &[PageNode], out: &mut Vec<Page>) {
    for n in nodes {
        out.push(n.page.clone());
        flatten(&n.children, out);
    }
}

fn find_node(nodes: &[PageNode], id: i64) -> Option<&PageNode> {
    nodes.iter().find_map(|n| if n.page.id == id { Some(n) } else { find_node(&n.children, id) })
}

fn list_text(list: &[PageOut]) -> String {
    list.iter().map(|p| format!("id:{}  {}\n", p.id, p.path)).collect()
}

/// A property value as JSON (`null` for YAML this reader does not take apart).
fn yaml_json(v: Option<&Yaml>) -> serde_json::Value {
    match v {
        None => serde_json::Value::Null,
        Some(Yaml::Str(s)) => s.clone().into(),
        Some(Yaml::List(items)) => items.iter().map(|i| yaml_json(Some(i))).collect(),
        Some(Yaml::Map(m)) => m.iter().map(|(k, v)| (k.clone(), yaml_json(Some(v)))).collect(),
    }
}

/// A property name the property editor accepts.
fn check_key(key: &str) -> Outcome<()> {
    let k = key.trim();
    let bad = k.is_empty() || k.contains([':', '\n', '\r']) || k.starts_with(|c: char| "#-[]{}'\"".contains(c));
    if bad {
        return Err(Failure::Usage(trf!("Kein gültiger Eigenschaftsname: {key}", "Not a valid property name: {key}")));
    }
    Ok(())
}

/// The new Markdown of `pages replace`: the page's properties stay unless the text brings its own
/// (or `whole`).
fn replaced(old: &str, body: &str, whole: bool) -> String {
    if whole || properties::frontmatter_lines(body).is_some() {
        return body.to_owned();
    }
    let Some(lines) = properties::frontmatter_lines(old) else { return body.to_owned() };
    // The block as written: the opening line, its lines and the closing line with their line ends.
    let mut end = 0;
    for (i, l) in old.split_inclusive('\n').enumerate() {
        end += l.len();
        if i == lines.len() + 1 {
            break;
        }
    }
    let block = &old[..end];
    let eol = if block.ends_with("\r\n") { "\r\n" } else { "\n" };
    let block = if block.ends_with('\n') { block.to_owned() } else { format!("{block}{eol}") };
    if body.trim().is_empty() { block } else { format!("{block}{eol}{}", body.trim_start_matches(['\n', '\r'])) }
}

pub fn run(ctx: &Ctx, cmd: PagesCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match cmd {
        PagesCmd::List { parent, trash } => {
            let pages = Pages::load(db)?;
            let list: Vec<PageOut> = if trash {
                pages.trash.iter().map(|p| pages.out(p)).collect()
            } else {
                let mut all = vec![];
                let tree = db.page_tree()?;
                match parent {
                    Some(r) => {
                        let parent = pages.resolve(&r, false)?;
                        all = find_node(&tree, parent.id)
                            .map(|n| n.children.iter().map(|c| c.page.clone()).collect())
                            .unwrap_or_default();
                    }
                    None => flatten(&tree, &mut all),
                }
                all.iter().map(|p| pages.out(p)).collect()
            };
            ctx.out.show(&list, |l| list_text(l))
        }
        PagesCmd::Tree { root } => {
            let pages = Pages::load(db)?;
            let tree = db.page_tree()?;
            let nodes: Vec<NodeOut> = match root {
                Some(r) => {
                    let p = pages.resolve(&r, false)?;
                    find_node(&tree, p.id).map(|n| vec![node_out(&pages, n)]).unwrap_or_default()
                }
                None => tree.iter().map(|n| node_out(&pages, n)).collect(),
            };
            ctx.out.show(&nodes, |n| {
                let mut s = String::new();
                tree_text(n, 0, &mut s);
                s
            })
        }
        PagesCmd::Show { page, meta } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let doc = doc_out(ctx, &pages, p.id)?;
            if !ctx.out.json {
                if meta {
                    println!("# {}  (id:{}, {})", doc.page.title, doc.page.id, doc.page.path);
                    if !doc.tags.is_empty() {
                        println!(
                            "{}: {}",
                            tr!("Tags", "Tags"),
                            doc.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")
                        );
                    }
                    println!();
                }
                print!("{}", doc.content);
                if !doc.content.ends_with('\n') && !doc.content.is_empty() {
                    println!();
                }
                return Ok(());
            }
            ctx.out.show(&doc, |_| String::new())
        }
        PagesCmd::Create { title, parent, body, icon } => {
            let content = read_body(&body, None)?;
            let parent_id = match parent {
                Some(r) => Some(Pages::load(db)?.resolve(&r, false)?.id),
                None => None,
            };
            let icon =
                icon.or_else(|| ctx.ws.settings.editor.default_icon.clone()).unwrap_or_else(|| "file-text".into());
            let id = ctx.ws.commit(|db| {
                let page = db.create_page(parent_id, &db.unique_title(&title)?, Some(&icon))?;
                if let Some(c) = content.as_deref().filter(|c| !c.is_empty()) {
                    db.save_page_content(page.id, c)?;
                }
                Ok((page.id, tree_changed(&[page.id])))
            })?;
            show_page(ctx, &out_of(ctx, id)?)
        }
        PagesCmd::Append { page, text, body } => {
            let add = required(read_body(&body, text.as_deref())?)?;
            let p = Pages::load(db)?.resolve(&page, false)?;
            ctx.ws.commit(|db| {
                let content = note_content(db, p.id)?;
                save(db, p.id, &capture::append_markdown(&content, add.trim_end()))?;
                Ok(((), page_changed(p.id)))
            })?;
            show_page(ctx, &out_of(ctx, p.id)?)
        }
        PagesCmd::Replace { page, body, whole } => {
            let text = read_body(&body, None)?.ok_or_else(missing_text)?;
            let p = Pages::load(db)?.resolve(&page, false)?;
            ctx.ws.commit(|db| {
                let old = if whole { db.page_doc(p.id)?.content } else { note_content(db, p.id)? };
                save(db, p.id, &replaced(&old, &text, whole))?;
                Ok(((), page_changed(p.id)))
            })?;
            show_page(ctx, &out_of(ctx, p.id)?)
        }
        PagesCmd::Props { page } => {
            let p = Pages::load(db)?.resolve(&page, false)?;
            let content = db.page_doc(p.id)?.content;
            let entries = properties::page_entries(&content);
            let map: serde_json::Map<String, serde_json::Value> =
                entries.iter().map(|e| (e.key.clone(), yaml_json(e.value.as_ref()))).collect();
            ctx.out.show(&map, |_| {
                entries
                    .iter()
                    .map(|e| {
                        format!("{}: {}\n", e.key, e.value.as_ref().map(properties::dump_flow).unwrap_or_default())
                    })
                    .collect()
            })
        }
        PagesCmd::Set { page, key, value } => set_property(ctx, &page, &key, Some(&value)),
        PagesCmd::Unset { page, key } => set_property(ctx, &page, &key, None),
        PagesCmd::Rename { page, title, keep_links } => {
            let p = Pages::load(db)?.resolve(&page, false)?;
            let title = arcalo_core::notes::clean_title(&title);
            let links = ctx.ws.commit(|db| {
                // As the app: a title another page has is refused ([[links]] must stay unambiguous).
                if let Some(other) = db.page_by_title(&title)?
                    && other.id != p.id
                {
                    return Err(Error::State(trf!(
                        "Eine Seite „{}“ existiert bereits",
                        "A page “{}” already exists",
                        other.title
                    )));
                }
                let mut touched: Vec<i64> = db.page_doc(p.id)?.backlinks.iter().map(|b| b.page_id).collect();
                let n = db.rename_page_linked(p.id, &title, !keep_links)?;
                touched.insert(0, p.id);
                Ok((n, tree_changed(&touched)))
            })?;
            #[derive(Serialize)]
            struct Renamed {
                page: PageOut,
                links_updated: usize,
            }
            let r = Renamed { page: out_of(ctx, p.id)?, links_updated: links };
            ctx.out.show(&r, |r| {
                let (id, path, n) = (r.page.id, &r.page.path, r.links_updated);
                let links = match n {
                    0 => String::new(),
                    1 => tr!(" (Links in einer Seite angepasst)", " (links updated in one page)").to_owned(),
                    n => trf!(" (Links in {n} Seiten angepasst)", " (links updated in {n} pages)"),
                };
                format!("id:{id}  {path}{links}")
            })
        }
        PagesCmd::Move { page, to, position } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let parent = match to.trim() {
                "" | "/" => None,
                r => Some(pages.resolve(r, false)?.id),
            };
            let siblings = pages.live.iter().filter(|s| s.parent_id == parent && s.id != p.id).count() as i64;
            ctx.ws.commit(|db| {
                db.move_page(p.id, parent, position.unwrap_or(siblings))?;
                Ok(((), tree_changed(&[p.id])))
            })?;
            show_page(ctx, &out_of(ctx, p.id)?)
        }
        PagesCmd::Duplicate { page, title } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let siblings: Vec<i64> = pages.live.iter().filter(|s| s.parent_id == p.parent_id).map(|s| s.id).collect();
            let at = siblings.iter().position(|s| *s == p.id).map_or(siblings.len(), |i| i + 1) as i64;
            let title = title.unwrap_or_else(|| {
                let t = &p.title;
                trf!("{t} (Kopie)", "{t} (copy)")
            });
            let id = ctx.ws.commit(|db| {
                let content = db.page_doc(p.id)?.content;
                let name = db.unique_title(&title)?;
                let copy = if p.kind.as_deref() == Some(arcalo_core::canvas::KIND) {
                    let c = db.create_canvas(p.parent_id, &name, chrono::Local::now().date_naive())?;
                    db.save_page(c.id, &content)?;
                    c
                } else {
                    let c = db.create_page(p.parent_id, &name, p.icon.as_deref())?;
                    db.save_page_content(c.id, &content)?;
                    c
                };
                db.move_page(copy.id, p.parent_id, at)?;
                Ok((copy.id, tree_changed(&[copy.id])))
            })?;
            show_page(ctx, &out_of(ctx, id)?)
        }
        PagesCmd::Delete { page } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let out = pages.out(&p);
            let n = ctx.ws.commit(|db| Ok((db.trash_page(p.id)?, tree_changed(&[p.id]))))?;
            #[derive(Serialize)]
            struct Trashed {
                trashed: usize,
                page: PageOut,
            }
            ctx.out.show(&Trashed { trashed: n, page: out }, |t| match t.trashed {
                1 => tr!("Seite in den Papierkorb gelegt", "Page moved to the trash").into(),
                n => trf!("{n} Seiten in den Papierkorb gelegt", "{n} pages moved to the trash"),
            })
        }
        PagesCmd::Restore { page } => {
            let p = Pages::load(db)?.resolve(&page, true)?;
            let restored = ctx.ws.commit(|db| {
                let r = db.restore_page(p.id)?;
                Ok((r.id, tree_changed(&[r.id])))
            })?;
            show_page(ctx, &out_of(ctx, restored)?)
        }
        PagesCmd::Purge { page, now } => {
            let pages = Pages::load(db)?;
            let (p, live) = match pages.resolve(&page, true) {
                Ok(p) => (p, false),
                Err(Failure::NotFound(_)) if now => (pages.resolve(&page, false)?, true),
                Err(f) => return Err(f),
            };
            let n = ctx.ws.commit(|db| {
                if live {
                    db.trash_page(p.id)?;
                }
                Ok((db.purge_page(p.id)?, tree_changed(&[p.id])))
            })?;
            purged(ctx, n)
        }
        PagesCmd::Versions { page } => {
            let p = Pages::load(db)?.resolve(&page, false)?;
            #[derive(Serialize)]
            struct VersionOut {
                id: i64,
                page_id: i64,
                created_at: chrono::DateTime<chrono::FixedOffset>,
                size: usize,
                preview: String,
            }
            let list: Vec<VersionOut> = db
                .list_versions(p.id)?
                .into_iter()
                .map(|v| VersionOut {
                    id: v.id,
                    page_id: v.page_id,
                    created_at: local(v.created_at),
                    size: v.size,
                    preview: v.preview,
                })
                .collect();
            ctx.out.show(&list, |l| {
                l.iter()
                    .map(|v| format!("{}  {}  {}\n", v.id, v.created_at.format("%Y-%m-%d %H:%M"), v.preview))
                    .collect()
            })
        }
        PagesCmd::Version { id } => {
            let content = db.version_content(id)?;
            if ctx.out.json {
                return ctx.out.show(&serde_json::json!({ "id": id, "content": content }), |_| String::new());
            }
            print!("{content}");
            Ok(())
        }
        PagesCmd::RestoreVersion { page, version } => {
            let p = Pages::load(db)?.resolve(&page, false)?;
            ctx.ws.commit(|db| {
                db.restore_version(p.id, version)?;
                Ok(((), page_changed(p.id)))
            })?;
            // Files the version embeds that were deleted since come back from the file trash.
            let content = db.page_doc(p.id)?.content;
            attachment_manager::bring_back_missing(&ctx.ws.loc.data_dir, &content)?;
            show_page(ctx, &out_of(ctx, p.id)?)
        }
        PagesCmd::Links { page } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let content = db.page_doc(p.id)?.content;
            #[derive(Serialize)]
            struct LinkOut {
                target: String,
                /// `page`, `missing` (no such page yet) or `file`.
                kind: &'static str,
                page: Option<PageOut>,
            }
            let mut seen = std::collections::HashSet::new();
            let mut list = vec![];
            for target in db.outgoing_links(p.id, &content)? {
                if !seen.insert(target.to_lowercase()) {
                    continue;
                }
                let found = db.page_by_title(&target)?;
                let kind = match &found {
                    Some(_) => "page",
                    None if attachment_manager::is_file_link(&target) => "file",
                    None => "missing",
                };
                list.push(LinkOut { page: found.map(|f| pages.out(&f)), target, kind });
            }
            ctx.out.show(&list, |l| {
                l.iter()
                    .map(|x| match &x.page {
                        Some(p) => format!("[[{}]]  id:{}  {}\n", x.target, p.id, p.path),
                        None => format!("[[{}]]  ({})\n", x.target, x.kind),
                    })
                    .collect()
            })
        }
        PagesCmd::Backlinks { page } => {
            let pages = Pages::load(db)?;
            let p = pages.resolve(&page, false)?;
            let doc = doc_out(ctx, &pages, p.id)?;
            #[derive(Serialize)]
            struct Back {
                #[serde(flatten)]
                page: PageOut,
                context: String,
            }
            let list: Vec<Back> = doc
                .backlinks
                .into_iter()
                .filter_map(|b| db.page(b.id).ok().map(|page| Back { page: pages.out(&page), context: b.context }))
                .collect();
            ctx.out.show(&list, |l| {
                l.iter().map(|b| format!("id:{}  {}  {}\n", b.page.id, b.page.path, b.context)).collect()
            })
        }
    }
}

fn set_property(ctx: &Ctx, page: &str, key: &str, value: Option<&str>) -> Outcome<()> {
    check_key(key)?;
    let p = Pages::load(&ctx.ws.db)?.resolve(page, false)?;
    ctx.ws.commit(|db| {
        let content = note_content(db, p.id)?;
        let next = properties::set_property(&content, key, value);
        if next != content {
            save(db, p.id, &next)?;
        }
        Ok(((), page_changed(p.id)))
    })?;
    show_page(ctx, &out_of(ctx, p.id)?)
}

fn purged(ctx: &Ctx, n: usize) -> Outcome<()> {
    ctx.out.show(&serde_json::json!({ "purged": n }), |_| match n {
        1 => tr!("Seite endgültig gelöscht", "Page deleted for good").into(),
        n => trf!("{n} Seiten endgültig gelöscht", "{n} pages deleted for good"),
    })
}

/// The daily note of `date`, created when missing (in the Journal folder, from the template, as
/// when the app opens it); whether it was created.
fn daily_page(db: &Database, date: NaiveDate) -> Result<(Page, bool)> {
    let key = date.format("%Y-%m-%d").to_string();
    let existed = db.list_pages()?.iter().any(|p| p.daily_date.as_deref() == Some(key.as_str()));
    Ok((db.daily_note(date)?, !existed))
}

pub fn daily(ctx: &Ctx, cmd: DailyCmd) -> Outcome<()> {
    match cmd {
        DailyCmd::Show { date } => {
            let date = day_or_today(date.as_deref())?;
            let id = daily_open(ctx, date)?;
            let pages = Pages::load(&ctx.ws.db)?;
            let doc = doc_out(ctx, &pages, id)?;
            if ctx.out.json {
                return ctx.out.show(&doc, |_| String::new());
            }
            print!("{}", doc.content);
            Ok(())
        }
        DailyCmd::Create { date } => {
            let date = day_or_today(date.as_deref())?;
            let id = daily_open(ctx, date)?;
            show_page(ctx, &out_of(ctx, id)?)
        }
        DailyCmd::Append { text, body, date, section } => {
            let add = required(read_body(&body, text.as_deref())?)?;
            let date = day_or_today(date.as_deref())?;
            let id = ctx.ws.commit(|db| {
                let (page, created) = daily_page(db, date)?;
                let content = note_content(db, page.id)?;
                let add = add.trim_end();
                let next = match &section {
                    Some(name) => capture::insert_in_section(&content, name.trim(), add),
                    None => capture::insert_in_notes(&content, add),
                }
                .unwrap_or_else(|| capture::append_markdown(&content, add));
                save(db, page.id, &next)?;
                let change = if created { tree_changed(&[page.id]) } else { page_changed(page.id) };
                Ok((page.id, change))
            })?;
            show_page(ctx, &out_of(ctx, id)?)
        }
    }
}

/// The daily note's id, created (and recorded for the app) when missing.
fn daily_open(ctx: &Ctx, date: NaiveDate) -> Outcome<i64> {
    ctx.ws.commit(|db| {
        let (page, created) = daily_page(db, date)?;
        Ok((page.id, if created { tree_changed(&[page.id]) } else { Change::default() }))
    })
}

pub fn tags(ctx: &Ctx, cmd: TagsCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match cmd {
        TagsCmd::List => {
            #[derive(Serialize)]
            struct TagOut {
                tag: String,
                pages: i64,
            }
            let list: Vec<TagOut> = db.tag_counts()?.into_iter().map(|(tag, pages)| TagOut { tag, pages }).collect();
            ctx.out.show(&list, |l| l.iter().map(|t| format!("#{}  {}\n", t.tag, t.pages)).collect())
        }
        TagsCmd::Pages { tag } => {
            let pages = Pages::load(db)?;
            let list: Vec<PageOut> =
                db.pages_with_tag(tag.trim().trim_start_matches('#'))?.iter().map(|p| pages.out(p)).collect();
            ctx.out.show(&list, |l| list_text(l))
        }
    }
}

pub fn trash(ctx: &Ctx, cmd: TrashCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match cmd {
        TrashCmd::List => {
            let pages = Pages::load(db)?;
            #[derive(Serialize)]
            struct TrashOut {
                #[serde(flatten)]
                page: PageOut,
                /// Subpages trashed with it.
                descendants: usize,
                parent_title: Option<String>,
            }
            let list: Vec<TrashOut> = db
                .list_trash()?
                .into_iter()
                .map(|e| TrashOut {
                    page: pages.out(&e.page),
                    descendants: e.descendants,
                    parent_title: e.parent_title,
                })
                .collect();
            ctx.out.show(&list, |l| {
                l.iter()
                    .map(|t| {
                        format!("id:{}  {}  {}\n", t.page.id, t.page.title, t.page.deleted_at.as_deref().unwrap_or(""))
                    })
                    .collect()
            })
        }
        TrashCmd::Empty => {
            let n = ctx.ws.commit(|db| Ok((db.empty_trash()?, Change { tree: true, ..Default::default() })))?;
            purged(ctx, n)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_the_text_keeps_the_properties() {
        let old = "---\nstatus: offen\n---\n\nAlt\n";
        assert_eq!(replaced(old, "Neu\n", false), "---\nstatus: offen\n---\n\nNeu\n");
        assert_eq!(replaced(old, "Neu\n", true), "Neu\n");
        assert_eq!(replaced(old, "---\na: b\n---\nNeu\n", false), "---\na: b\n---\nNeu\n");
        assert_eq!(replaced("Alt\n", "Neu\n", false), "Neu\n");
        assert_eq!(replaced("---\r\nx: 1\r\n---\r\nAlt", "Neu", false), "---\r\nx: 1\r\n---\r\n\r\nNeu");
        assert_eq!(replaced(old, "", false), "---\nstatus: offen\n---\n");
    }

    #[test]
    fn days_by_name_or_date() {
        let today = chrono::Local::now().date_naive();
        assert_eq!(day("today").unwrap(), today);
        assert_eq!(day("Morgen").unwrap(), today + Duration::days(1));
        assert_eq!(day("2026-02-28").unwrap(), NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert!(matches!(day("28.02.2026"), Err(Failure::Usage(_))));
    }
}
