//! Critical path method (CPM) for a Netzplan, the German Vorgangsknoten-Netzplan.
//!
//! For every Vorgang this computes FAZ/FEZ (earliest start/finish), SAZ/SEZ
//! (latest start/finish), GP (Gesamtpuffer, total float) and FP (freier
//! Puffer, free float). Vorgänge with zero total float form the critical path.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::Vorgang;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub vorgang_id: i64,
    pub vorgang_nr: String,
    pub description: String,
    pub duration: f64,
    pub predecessors: Vec<i64>,
    /// Frühester Anfangszeitpunkt.
    pub faz: f64,
    /// Frühester Endzeitpunkt.
    pub fez: f64,
    /// Spätester Anfangszeitpunkt.
    pub saz: f64,
    /// Spätester Endzeitpunkt.
    pub sez: f64,
    /// Gesamtpuffer (total float).
    pub gp: f64,
    /// Freier Puffer (free float).
    pub fp: f64,
    pub critical: bool,
    /// Column for drawing: length of the longest predecessor chain.
    pub rank: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Schedule {
    /// Nodes in topological order.
    pub nodes: Vec<Node>,
    /// Project duration (in the unit of `duration_days`).
    pub duration: f64,
    /// Vorgang IDs along one critical path, start to end.
    pub critical_path: Vec<i64>,
}

const EPS: f64 = 1e-9;

pub fn schedule(vorgaenge: &[Vorgang]) -> Result<Schedule> {
    let index: HashMap<i64, usize> = vorgaenge.iter().enumerate().map(|(i, v)| (v.id, i)).collect();
    let n = vorgaenge.len();
    let mut succ: Vec<Vec<usize>> = vec![vec![]; n];
    let mut indeg = vec![0usize; n];
    for (i, v) in vorgaenge.iter().enumerate() {
        for p in &v.predecessors {
            let &pi = index.get(p).ok_or_else(|| {
                Error::State(format!("Vorgang {} hängt von einem unbekannten Vorgang (#{p}) ab", v.vorgang_nr))
            })?;
            succ[pi].push(i);
            indeg[i] += 1;
        }
    }

    // Kahn's algorithm; ties resolved by input order for stable output.
    let mut order = Vec::with_capacity(n);
    let mut ready: Vec<usize> = (0..n).filter(|&i| indeg[i] == 0).rev().collect();
    while let Some(i) = ready.pop() {
        order.push(i);
        for &s in succ[i].iter().rev() {
            indeg[s] -= 1;
            if indeg[s] == 0 {
                ready.push(s);
            }
        }
    }
    if order.len() != n {
        let cyclic: Vec<_> = (0..n).filter(|&i| indeg[i] > 0).map(|i| vorgaenge[i].vorgang_nr.as_str()).collect();
        return Err(Error::State(format!("Der Netzplan enthält einen Zyklus über {}", cyclic.join(", "))));
    }

    // Forward pass.
    let mut faz = vec![0.0f64; n];
    let mut fez = vec![0.0f64; n];
    let mut rank = vec![0usize; n];
    for &i in &order {
        for p in &vorgaenge[i].predecessors {
            let pi = index[p];
            faz[i] = faz[i].max(fez[pi]);
            rank[i] = rank[i].max(rank[pi] + 1);
        }
        fez[i] = faz[i] + vorgaenge[i].duration_days;
    }
    let duration = fez.iter().copied().fold(0.0, f64::max);

    // Backward pass.
    let mut sez = vec![duration; n];
    let mut saz = vec![0.0f64; n];
    for &i in order.iter().rev() {
        for &s in &succ[i] {
            sez[i] = sez[i].min(saz[s]);
        }
        saz[i] = sez[i] - vorgaenge[i].duration_days;
    }

    let nodes: Vec<Node> = order
        .iter()
        .map(|&i| {
            let v = &vorgaenge[i];
            let gp = saz[i] - faz[i];
            let fp = succ[i].iter().map(|&s| faz[s]).fold(duration, f64::min) - fez[i];
            Node {
                vorgang_id: v.id,
                vorgang_nr: v.vorgang_nr.clone(),
                description: v.description.clone(),
                duration: v.duration_days,
                predecessors: v.predecessors.clone(),
                faz: faz[i],
                fez: fez[i],
                saz: saz[i],
                sez: sez[i],
                gp: clean(gp),
                fp: clean(fp),
                critical: gp.abs() < EPS,
                rank: rank[i],
            }
        })
        .collect();

    // Walk one critical chain: start at a critical source, follow critical
    // successors whose FAZ equals our FEZ.
    let mut critical_path = vec![];
    let mut cur =
        order.iter().copied().find(|&i| vorgaenge[i].predecessors.is_empty() && (saz[i] - faz[i]).abs() < EPS);
    while let Some(i) = cur {
        critical_path.push(vorgaenge[i].id);
        cur = succ[i].iter().copied().find(|&s| (saz[s] - faz[s]).abs() < EPS && (faz[s] - fez[i]).abs() < EPS);
    }

    Ok(Schedule { nodes, duration, critical_path })
}

fn clean(x: f64) -> f64 {
    if x.abs() < EPS { 0.0 } else { x }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(id: i64, nr: &str, d: f64, preds: &[i64]) -> Vorgang {
        Vorgang {
            id,
            netzplan_id: 1,
            vorgang_nr: nr.into(),
            description: String::new(),
            duration_days: d,
            planned_hours: 0.0,
            remaining_hours: None,
            predecessors: preds.to_vec(),
        }
    }

    #[test]
    fn textbook_network() {
        // A(3) → B(2) → D(4)
        // A(3) → C(5) → D(4)
        //        C(5) → E(1)
        let plan = [
            v(1, "A", 3.0, &[]),
            v(2, "B", 2.0, &[1]),
            v(3, "C", 5.0, &[1]),
            v(4, "D", 4.0, &[2, 3]),
            v(5, "E", 1.0, &[3]),
        ];
        let s = schedule(&plan).unwrap();
        assert_eq!(s.duration, 12.0);
        assert_eq!(s.critical_path, vec![1, 3, 4]);
        let node = |nr: &str| s.nodes.iter().find(|n| n.vorgang_nr == nr).unwrap();
        let b = node("B");
        assert_eq!((b.faz, b.fez, b.saz, b.sez, b.gp, b.fp), (3.0, 5.0, 6.0, 8.0, 3.0, 3.0));
        let e = node("E");
        assert_eq!((e.faz, e.gp, e.fp), (8.0, 3.0, 3.0));
        assert_eq!(node("D").rank, 2);
        assert!(node("C").critical && !node("B").critical);
    }

    #[test]
    fn detects_cycles_and_dangling_links() {
        assert!(schedule(&[v(1, "A", 1.0, &[2]), v(2, "B", 1.0, &[1])]).is_err());
        assert!(schedule(&[v(1, "A", 1.0, &[99])]).is_err());
        assert_eq!(schedule(&[]).unwrap().duration, 0.0);
    }
}
