use super::*;
use crate::ai::provider::AiProvider;

/// A tiny embedding model: one dimension per concept, so words of the same meaning land on
/// the same axis (as a real model would place them close together).
const CONCEPTS: [&[&str]; 6] = [
    &["angebot", "kostenvoranschlag", "offerte", "preis"],
    &["müller", "mueller"],
    &["urlaub", "ferien"],
    &["server", "datenbank"],
    &["kunde", "kunden"],
    &["gehalt", "gehälter", "gehaltsrunde"],
];

fn embed(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    let mut v: Vec<f32> = CONCEPTS.iter().map(|ws| ws.iter().filter(|w| lower.contains(*w)).count() as f32).collect();
    v.push(0.05);
    v
}

/// Embeds what is pending like the indexer does (all chunks for a local model).
fn index(db: &Database, local: bool, markers: &[String]) -> usize {
    let mut n = 0;
    loop {
        let batch = pending(db, local, markers, 16).unwrap();
        if batch.is_empty() {
            return n;
        }
        for (id, text) in &batch {
            rag::store_embedding(db, *id, &embed(text)).unwrap();
        }
        n += batch.len();
    }
}

fn page(db: &Database, title: &str, body: &str) -> i64 {
    let p = db.create_page(None, title, None).unwrap();
    db.save_page_content(p.id, body).unwrap();
    p.id
}

fn pages_of(hits: &[SearchHit]) -> Vec<(i64, &'static str)> {
    hits.iter()
        .filter_map(|h| {
            let kind = match h {
                SearchHit::Page { .. } => "page",
                SearchHit::Note { .. } => "note",
                SearchHit::Similar { .. } => "similar",
                SearchHit::TimeEntry { .. } => return None,
            };
            Some((h.page_id().unwrap(), kind))
        })
        .collect()
}

const KV_TEXT: &str = "Kostenvoranschlag und Preis für Kunde Müller über die Dachsanierung.";

fn workspace() -> (Database, i64, i64, i64) {
    let db = Database::open_in_memory().unwrap();
    let kv = page(&db, "Dachsanierung", KV_TEXT);
    let urlaub = page(&db, "Sommer", "Ferien im August an der Ostsee.");
    let server = page(&db, "Betrieb", "Die Datenbank läuft auf dem neuen Server.");
    (db, kv, urlaub, server)
}

#[test]
fn finds_a_page_by_meaning_with_its_passage() {
    let (db, kv, ..) = workspace();
    assert_eq!(index(&db, true, &[]), 3);
    let mut vi = VectorIndex::default();
    // No exact hit: neither word is on the page.
    assert!(search::search(&db, "Angebot Müller", 10).unwrap().is_empty());
    let hits = search(&db, &mut vi, "Angebot Müller", Some(&embed("Angebot Müller")), 10).unwrap();
    assert_eq!(pages_of(&hits), [(kv, "similar")], "{hits:#?}");
    let SearchHit::Similar { passage, similarity, title, .. } = &hits[0] else { unreachable!() };
    assert_eq!(title, "Dachsanierung");
    assert!(passage.contains("Preis für Kunde Müller"), "{passage}");
    assert!(*similarity > 0.8, "{similarity}");
    // Without a query embedding (offline, switched off): exact hits only.
    assert!(search(&db, &mut vi, "Angebot Müller", None, 10).unwrap().is_empty());
    // Nothing similar enough: no meaning hits at all.
    assert!(search(&db, &mut vi, "Gehalt", Some(&embed("Gehalt")), 10).unwrap().is_empty());
}

#[test]
fn strong_exact_hits_stay_first_and_pages_are_not_listed_twice() {
    let (db, kv, ..) = workspace();
    let offer = page(&db, "Angebot Schmidt", "Angebot für Schmidt, Preis folgt.");
    index(&db, true, &[]);
    let mut vi = VectorIndex::default();
    let hits = search(&db, &mut vi, "Angebot", Some(&embed("Angebot")), 10).unwrap();
    // The title hit and its passage first, then the page found by meaning, labelled.
    assert_eq!(pages_of(&hits), [(offer, "page"), (offer, "note"), (kv, "similar")], "{hits:#?}");
}

#[test]
fn fusion_ranks_by_reciprocal_rank() {
    let note =
        |p: i64| SearchHit::Note { page_id: p, title: format!("P{p}"), icon: None, snippet: String::new(), score: 1.0 };
    let m = |p: i64, sim: f32| Meaning {
        page_id: p,
        block_id: p * 10,
        title: format!("P{p}"),
        icon: None,
        passage: String::new(),
        similarity: sim,
    };
    let exact: Vec<SearchHit> = (1..=6).map(note).collect();
    // Page 5 is a weak exact hit that is also the best meaning hit: it moves up to the strong
    // ones. Page 9 is the second meaning hit only (1/62): ahead of the weak exact hits 4 (1/64)
    // and 6 (1/66), labelled.
    let fused = fuse(exact, vec![m(5, 0.9), m(9, 0.8)], 10);
    let order: Vec<(i64, &str)> = pages_of(&fused);
    assert_eq!(order, [(1, "note"), (2, "note"), (3, "note"), (5, "note"), (9, "similar"), (4, "note"), (6, "note")]);
    let scores: Vec<f64> = fused.iter().map(SearchHit::score).collect();
    assert!(scores[3] > scores[4] && scores[4] > scores[5] && scores[5] > scores[6], "{scores:?}");
    // At the same rank the exact hit goes first.
    let fused = fuse(vec![note(1)], vec![m(9, 0.9)], 10);
    assert_eq!(pages_of(&fused), [(1, "note"), (9, "similar")]);
    // The limit counts every hit.
    assert_eq!(fuse((1..=6).map(note).collect(), vec![m(9, 0.8)], 3).len(), 3);
    // Only meaning hits: in their order.
    assert_eq!(pages_of(&fuse(vec![], vec![m(7, 0.9), m(8, 0.7)], 5)), [(7, "similar"), (8, "similar")]);
}

#[test]
fn private_pages_never_reach_a_cloud_model() {
    let (db, ..) = workspace();
    let secret = page(&db, "Gehälter", "Gehaltsrunde 2026 mit Kunde Müller.\n\n#privat");
    let tagged = page(&db, "Notiz", "---\ntags: [privat]\n---\nAngebot für Müller intern.");
    let markers = vec!["#privat".to_string()];
    let page_of = |id: i64| -> i64 {
        db.conn().query_row("SELECT page_id FROM notes_blocks WHERE id = ?1", [id], |r| r.get(0)).unwrap()
    };
    let cloud: Vec<i64> = pending(&db, false, &markers, 50).unwrap().iter().map(|(id, _)| page_of(*id)).collect();
    assert!(!cloud.contains(&secret) && !cloud.contains(&tagged), "{cloud:?}");
    let before = progress(&db, false, &markers).unwrap();
    assert_eq!((before.done, before.private_skipped), (2, 2), "{before:?}");
    index(&db, false, &markers);
    let after = progress(&db, false, &markers).unwrap();
    assert_eq!((after.done, after.total, after.private_skipped), (after.total, 5, 2), "{after:?}");
    // A local model takes them, and then nothing is skipped.
    let local = progress(&db, true, &markers).unwrap();
    assert_eq!((local.done, local.private_skipped), (3, 0));
    index(&db, true, &markers);
    assert_eq!(progress(&db, true, &markers).unwrap().done, 5);
    // The query: a private one is not sent to the cloud.
    assert!(!query_may_embed("Gehalt #privat", false, &markers));
    assert!(query_may_embed("Gehalt #privat", true, &markers));
    assert!(query_may_embed("Angebot Müller", false, &markers));
}

#[test]
fn the_index_follows_saves_trash_renames_and_the_model() {
    let (db, kv, urlaub, _) = workspace();
    index(&db, true, &[]);
    let mut vi = VectorIndex::default();
    let q = embed("Urlaub");
    let find = |vi: &mut VectorIndex| pages_of(&search(&db, vi, "Urlaub", Some(&q), 10).unwrap());
    assert_eq!(find(&mut vi), [(urlaub, "similar")]);
    assert_eq!(vi.len(), 3);

    // An edit adds one chunk to embed (the unchanged ones keep theirs) and wakes the indexer.
    let generation = rag::chunk_generation();
    db.save_page_content(kv, &format!("{KV_TEXT}\n\n# Urlaub\n\nFerien danach.")).unwrap();
    assert!(rag::chunk_generation() > generation);
    let todo = pending(&db, true, &[], 10).unwrap();
    assert_eq!(todo.len(), 1, "{todo:?}");
    assert_eq!(index(&db, true, &[]), 1);
    let found = find(&mut vi);
    // The page now has the word itself: an exact hit, not listed again by meaning.
    assert_eq!(found, [(kv, "note"), (urlaub, "similar")]);
    assert_eq!(vi.len(), 4, "only the new chunk was read");

    // Renamed: still found; in the trash: gone; restored: back.
    db.rename_page(urlaub, "Sommerplanung").unwrap();
    assert!(find(&mut vi).contains(&(urlaub, "similar")));
    db.trash_page(urlaub).unwrap();
    assert!(!find(&mut vi).iter().any(|(p, _)| *p == urlaub));
    db.restore_page(urlaub).unwrap();
    assert!(find(&mut vi).iter().any(|(p, _)| *p == urlaub));

    // Another model: the vectors go, and everything is pending again.
    assert!(!ensure_index_model(&db, "ollama/nomic-embed-text").unwrap(), "first marker keeps the vectors");
    assert!(!ensure_index_model(&db, "ollama/nomic-embed-text").unwrap());
    assert!(index_matches(&db, "ollama/nomic-embed-text").unwrap());
    assert!(!index_matches(&db, "ollama/mxbai-embed-large").unwrap());
    assert!(ensure_index_model(&db, "ollama/mxbai-embed-large").unwrap());
    assert_eq!(progress(&db, true, &[]).unwrap().done, 0);
    assert_eq!(find(&mut vi), [(kv, "note")], "exact hits only");
    assert_eq!(vi.len(), 0);
    index(&db, true, &[]);
    rebuild(&db).unwrap();
    assert_eq!(pending(&db, true, &[], 50).unwrap().len(), 4);
}

#[test]
fn quantized_similarity_is_close_to_cosine() {
    let mut vi = VectorIndex::default();
    let a: Vec<f32> = (0..384).map(|i| ((i * 37 % 101) as f32 - 50.0) / 50.0).collect();
    let b: Vec<f32> = (0..384).map(|i| ((i * 53 % 97) as f32 - 48.0) / 48.0 + a[i] * 0.5).collect();
    vi.put(1, 1, &a);
    vi.put(2, 2, &b);
    vi.put(3, 3, &[1.0; 3]);
    assert_eq!(vi.len(), 2, "another dimension is left out");
    let top = vi.top_rows(&a, 5);
    assert_eq!(top[0].0, 0);
    assert!((top[0].1 - 1.0).abs() < 0.01, "{top:?}");
    assert!((top[1].1 - rag::cosine(&a, &b)).abs() < 0.01, "{top:?}");
    assert!(vi.top_rows(&[1.0; 3], 5).is_empty());
    assert_eq!(dot(&[1, 2, 3, 4, 5, 6, 7, 8, 9], &[1; 9]), 45);
}

#[test]
fn passages_are_one_short_line() {
    assert_eq!(passage("# Angebot\n\nKostenvoranschlag   für\nMüller."), "Kostenvoranschlag für Müller.");
    assert_eq!(passage("Nur Text"), "Nur Text");
    let long = format!("Anfang {}", "Wort ".repeat(100));
    let p = passage(&long);
    assert!(p.ends_with('…') && p.chars().count() <= PASSAGE_CHARS + 1, "{p}");
}

#[test]
fn settings_decide_local_first() {
    let mut s = Settings::default();
    assert_eq!(plan(&s).inactive, Some(Inactive::NoModel));
    assert!(!plan(&s).switch_on);
    // An embedding model in the cloud (the LiteLLM provider): off until switched on.
    s.embedding_model = Some("firma-embed".into());
    let p = plan(&s);
    assert_eq!((p.switch_on, p.automatic, p.local, p.inactive), (false, true, false, Some(Inactive::SwitchedOff)));
    s.search.semantic = Some(true);
    assert!(plan(&s).active());
    assert_eq!(plan(&s).index_key().as_deref(), Some("litellm/firma-embed"));
    s.privacy.local_only = true;
    assert_eq!(plan(&s).inactive, Some(Inactive::LocalOnly));
    // A local Ollama: on by itself, also with „Nur lokal“.
    s.search.semantic = None;
    s.providers.push(AiProvider::ollama("ollama", "http://localhost:11434"));
    s.embedding_provider = "ollama".into();
    s.embedding_model = Some("nomic-embed-text".into());
    let p = plan(&s);
    assert!(p.switch_on && p.local && p.active(), "{p:?}");
    // „KI verwenden“ off: no embeddings at all, also with a local model; on again, as before.
    s.ai.enabled = false;
    assert_eq!(plan(&s).inactive, Some(Inactive::AiOff));
    s.ai.enabled = true;
    assert!(plan(&s).active());
    s.search.semantic = Some(false);
    assert_eq!(plan(&s).inactive, Some(Inactive::SwitchedOff));
    s.search.semantic = None;
    s.providers.last_mut().unwrap().enabled = false;
    assert_eq!(plan(&s).inactive, Some(Inactive::ProviderOff));
}

#[test]
fn pending_chunks_come_from_the_queue_index() {
    let (db, ..) = workspace();
    let plan: Vec<String> = db
        .conn()
        .prepare(
            "EXPLAIN QUERY PLAN SELECT b.id, b.content_markdown FROM notes_blocks b JOIN pages p ON p.id = b.page_id
             WHERE b.vector_embedding IS NULL AND trim(b.content_markdown) <> '' AND p.deleted_at IS NULL
             ORDER BY b.id LIMIT 32",
        )
        .unwrap()
        .query_map([], |r| r.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(plan.iter().any(|l| l.contains("idx_notes_blocks_unembedded")), "{plan:?}");
}

#[test]
fn edited_and_deleted_chunks_leave_the_index() {
    let db = Database::open_in_memory().unwrap();
    let a = page(&db, "Urlaubsplanung", "Ferien im August.");
    let b = page(&db, "Urlaub Team", "Urlaub der Kollegen.");
    index(&db, true, &[]);
    let mut vi = VectorIndex::default();
    let q = embed("Urlaub");
    let find = |vi: &mut VectorIndex| {
        let mut p: Vec<i64> =
            search(&db, vi, "Sommerpause", Some(&q), 10).unwrap().iter().filter_map(|h| h.page_id()).collect();
        p.sort();
        p
    };
    assert_eq!(find(&mut vi), [a, b]);
    // Forty edits, each embedded: the old vectors go, the other page is still found.
    for i in 0..40 {
        let (id, text) = if i % 2 == 0 {
            (a, format!("Ferien im August, Fassung {i}."))
        } else {
            (b, format!("Urlaub der Kollegen, Fassung {i}."))
        };
        db.save_page_content(id, &text).unwrap();
        index(&db, true, &[]);
        vi.sync(&db).unwrap();
    }
    let live: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM notes_blocks WHERE vector_embedding IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(vi.len() as i64, live);
    assert_eq!(find(&mut vi), [a, b]);
    // Deleted for good (with its subtree): its vectors go too.
    db.delete_page(b).unwrap();
    vi.sync(&db).unwrap();
    assert_eq!(vi.len(), 1);
    assert_eq!(find(&mut vi), [a]);
}
