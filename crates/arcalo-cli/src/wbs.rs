//! Projects, Netzpläne and Vorgänge (the WBS), budgets and the critical path.

use arcalo_core::external::Change;
use arcalo_core::model::{Netzplan, Vorgang};
use arcalo_core::tracking::{self, BudgetStatus};
use arcalo_core::{Database, Error, Result, netzplan, tr, trf};
use serde::Serialize;

use crate::output::{Failure, Outcome};
use crate::{Ctx, ProjectCmd};

fn wbs_changed() -> Change {
    Change { wbs: true, ..Default::default() }
}

#[derive(Serialize)]
struct VorgangOut {
    id: i64,
    nr: String,
    description: String,
    duration_days: f64,
    planned_hours: f64,
    remaining_hours: Option<f64>,
    /// Numbers of the direct predecessors.
    predecessors: Vec<String>,
}

#[derive(Serialize)]
struct NetzplanOut {
    id: i64,
    nr: String,
    wbs_element: String,
    description: String,
    planned_hours: f64,
    vorgaenge: Vec<VorgangOut>,
}

#[derive(Serialize)]
struct ProjectOut {
    id: i64,
    code: String,
    name: String,
    netzplaene: Vec<NetzplanOut>,
}

fn vorgaenge_out(list: &[Vorgang]) -> Vec<VorgangOut> {
    let nr = |id: i64| list.iter().find(|v| v.id == id).map(|v| v.vorgang_nr.clone()).unwrap_or_default();
    list.iter()
        .map(|v| VorgangOut {
            id: v.id,
            nr: v.vorgang_nr.clone(),
            description: v.description.clone(),
            duration_days: v.duration_days,
            planned_hours: v.planned_hours,
            remaining_hours: v.remaining_hours,
            predecessors: v.predecessors.iter().map(|p| nr(*p)).collect(),
        })
        .collect()
}

fn netzplan_out(db: &Database, n: &Netzplan) -> Result<NetzplanOut> {
    Ok(NetzplanOut {
        id: n.id,
        nr: n.netzplan_nr.clone(),
        wbs_element: n.wbs_element.clone(),
        description: n.description.clone(),
        planned_hours: n.planned_hours,
        vorgaenge: vorgaenge_out(&db.list_vorgaenge(n.id)?),
    })
}

/// `NP-8801/1020`: the Netzplan and its Vorgang.
fn vorgang_by_ref(db: &Database, reference: &str) -> Outcome<(Netzplan, Vorgang)> {
    let (np, nr) = reference.split_once('/').ok_or_else(|| {
        Failure::Usage(trf!(
            "Vorgang als Netzplan/Vorgang angeben (NP-8801/1020): {reference}",
            "Name the activity as network/activity (NP-8801/1020): {reference}"
        ))
    })?;
    let n = db.netzplan_by_ref(np.trim())?;
    let v = db.list_vorgaenge(n.id)?.into_iter().find(|v| v.vorgang_nr.eq_ignore_ascii_case(nr.trim()));
    let v = v.ok_or_else(|| Error::not_found("vorgang", reference.to_owned()))?;
    Ok((n, v))
}

fn non_empty(value: &str, what: &str) -> Outcome<String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(Failure::Usage(trf!("{what} fehlt", "{what} is missing")));
    }
    Ok(v.to_owned())
}

fn done(ctx: &Ctx, text: String) -> Outcome<()> {
    ctx.out
        .show(&serde_json::json!({ "ok": true, "message": text }), |v| v["message"].as_str().unwrap_or("").to_owned())
}

pub fn project(ctx: &Ctx, action: ProjectCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match action {
        ProjectCmd::List => {
            let list = db
                .list_projects()?
                .into_iter()
                .map(|p| {
                    let netzplaene =
                        db.list_netzplaene(Some(p.id))?.iter().map(|n| netzplan_out(db, n)).collect::<Result<_>>()?;
                    Ok(ProjectOut { id: p.id, code: p.project_code, name: p.name, netzplaene })
                })
                .collect::<Result<Vec<_>>>()?;
            ctx.out.show(&list, |l| {
                let mut s = String::new();
                for p in l {
                    s.push_str(&format!("{}  {}\n", p.code, p.name));
                    for n in &p.netzplaene {
                        s.push_str(&format!(
                            "  {}  {}  {} ({:.1}h)\n",
                            n.nr, n.wbs_element, n.description, n.planned_hours
                        ));
                        for v in &n.vorgaenge {
                            s.push_str(&format!(
                                "    {}  {} ({:.1}d, {:.1}h)\n",
                                v.nr, v.description, v.duration_days, v.planned_hours
                            ));
                        }
                    }
                }
                s
            })
        }
        ProjectCmd::Add { code, name } => {
            let p = ctx.ws.commit(|db| Ok((db.create_project(&code, &name)?, wbs_changed())))?;
            let (c, id) = (&p.project_code, p.id);
            done(ctx, trf!("Projekt {c} angelegt (#{id})", "Project {c} created (#{id})"))
        }
        ProjectCmd::Edit { code, name } => {
            let name = non_empty(&name, tr!("Name", "Name"))?;
            let p = db.project_by_code(&code)?;
            ctx.ws.commit(|db| Ok((db.update_project(p.id, &name)?, wbs_changed())))?;
            done(ctx, trf!("Projekt {code} geändert", "Project {code} changed"))
        }
        ProjectCmd::Delete { code } => {
            let p = db.project_by_code(&code)?;
            ctx.ws.commit(|db| Ok((db.delete_project(p.id)?, wbs_changed())))?;
            done(ctx, trf!("Projekt {code} gelöscht", "Project {code} deleted"))
        }
        ProjectCmd::AddNetzplan { project, netzplan_nr, wbs_element, description, hours } => {
            let p = db.project_by_code(&project)?;
            let n = ctx.ws.commit(|db| {
                Ok((db.create_netzplan(p.id, &netzplan_nr, &wbs_element, &description, hours)?, wbs_changed()))
            })?;
            let (nr, id) = (&n.netzplan_nr, n.id);
            done(ctx, trf!("Netzplan {nr} angelegt (#{id})", "Network {nr} created (#{id})"))
        }
        ProjectCmd::EditNetzplan { netzplan, wbs_element, description, hours } => {
            let n = db.netzplan_by_ref(&netzplan)?;
            let wbs = wbs_element.unwrap_or(n.wbs_element.clone());
            let description = description.unwrap_or(n.description.clone());
            let hours = hours.unwrap_or(n.planned_hours).max(0.0);
            ctx.ws.commit(|db| Ok((db.update_netzplan(n.id, &wbs, &description, hours)?, wbs_changed())))?;
            let nr = &n.netzplan_nr;
            done(ctx, trf!("Netzplan {nr} geändert", "Network {nr} changed"))
        }
        ProjectCmd::DeleteNetzplan { netzplan } => {
            let n = db.netzplan_by_ref(&netzplan)?;
            ctx.ws.commit(|db| Ok((db.delete_netzplan(n.id)?, wbs_changed())))?;
            let nr = &n.netzplan_nr;
            done(ctx, trf!("Netzplan {nr} gelöscht", "Network {nr} deleted"))
        }
        ProjectCmd::AddVorgang { netzplan, vorgang_nr, description, days, hours, after } => {
            let n = db.netzplan_by_ref(&netzplan)?;
            let existing = db.list_vorgaenge(n.id)?;
            let preds: Vec<i64> = after
                .iter()
                .map(|a| {
                    existing
                        .iter()
                        .find(|v| &v.vorgang_nr == a)
                        .map(|v| v.id)
                        .ok_or_else(|| Error::not_found("vorgang", a.clone()))
                })
                .collect::<Result<_>>()?;
            let v = ctx.ws.commit(|db| {
                // A new Vorgang has no successors, so linking it cannot create a cycle.
                let v = db.create_vorgang(n.id, &vorgang_nr, &description, days, hours)?;
                for p in &preds {
                    db.link_vorgaenge(*p, v.id)?;
                }
                Ok((v, wbs_changed()))
            })?;
            let (np, nr) = (&n.netzplan_nr, &v.vorgang_nr);
            done(ctx, trf!("Vorgang {np}/{nr} angelegt", "Activity {np}/{nr} created"))
        }
        ProjectCmd::EditVorgang { vorgang, description, days, hours, remaining } => {
            let (_, v) = vorgang_by_ref(db, &vorgang)?;
            let remaining = match remaining.as_deref().map(str::trim) {
                None => v.remaining_hours,
                Some("none" | "keine" | "") => None,
                Some(r) => Some(
                    arcalo_core::properties::parse_number(r)
                        .ok_or_else(|| Failure::Usage(trf!("Keine Zahl: {r}", "Not a number: {r}")))?,
                ),
            };
            let description = description.unwrap_or(v.description.clone());
            let (days, hours) = (days.unwrap_or(v.duration_days).max(0.0), hours.unwrap_or(v.planned_hours).max(0.0));
            ctx.ws.commit(|db| Ok((db.update_vorgang(v.id, &description, days, hours, remaining)?, wbs_changed())))?;
            done(ctx, trf!("Vorgang {vorgang} geändert", "Activity {vorgang} changed"))
        }
        ProjectCmd::DeleteVorgang { vorgang } => {
            let (_, v) = vorgang_by_ref(db, &vorgang)?;
            ctx.ws.commit(|db| Ok((db.delete_vorgang(v.id)?, wbs_changed())))?;
            done(ctx, trf!("Vorgang {vorgang} gelöscht", "Activity {vorgang} deleted"))
        }
    }
}

pub fn budget(ctx: &Ctx, netzplan: &str) -> Outcome<()> {
    let n = ctx.ws.db.netzplan_by_ref(netzplan)?;
    let rows: Vec<BudgetStatus> = tracking::budget_status(&ctx.ws.db, n.id, &ctx.ws.settings.thresholds)?;
    ctx.out.show(&rows, |rows| {
        let mut s = format!(
            "{:<16} {:>8} {:>8} {:>8} {:>8} {:>6}  status\n",
            "element",
            "plan",
            tr!("gebucht", "booked"),
            "ETC",
            "EAC",
            "%"
        );
        for r in rows {
            s.push_str(&format!(
                "{:<16} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>5.0}%  {}\n",
                r.label,
                r.planned_hours,
                r.booked_hours,
                r.etc_hours,
                r.eac_hours,
                r.consumed * 100.0,
                crate::time::level_name(r.level)
            ));
        }
        s
    })
}

pub fn schedule(ctx: &Ctx, nr: &str) -> Outcome<()> {
    let n = ctx.ws.db.netzplan_by_ref(nr)?;
    let s = netzplan::schedule(&ctx.ws.db.list_vorgaenge(n.id)?)?;
    ctx.out.show(&s, |s| {
        let mut out = format!(
            "{:<8} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5}  vorgang\n",
            "nr", "D", "FAZ", "FEZ", "SAZ", "SEZ", "GP", "FP"
        );
        for x in &s.nodes {
            out.push_str(&format!(
                "{:<8} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5} {:>5}  {}{}\n",
                x.vorgang_nr,
                x.duration,
                x.faz,
                x.fez,
                x.saz,
                x.sez,
                x.gp,
                x.fp,
                x.description,
                if x.critical { tr!("  ◆ kritisch", "  ◆ critical") } else { "" }
            ));
        }
        let path: Vec<_> = s
            .critical_path
            .iter()
            .filter_map(|id| s.nodes.iter().find(|x| x.vorgang_id == *id).map(|x| x.vorgang_nr.as_str()))
            .collect();
        let (d, p) = (s.duration, path.join(" → "));
        out.push_str(&trf!(
            "\nProjektdauer: {d} Tage, kritischer Pfad: {p}",
            "\nProject duration: {d} days, critical path: {p}"
        ));
        out
    })
}
