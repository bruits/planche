//! Edits to a board, each one undoable. The history keeps every touched element as it was
//! before and after, never a way to recompute it, so that undoing gives back the same bytes.
//! It lives in memory only.

use std::collections::{BTreeMap, BTreeSet};
use std::mem;

use crate::{Board, Element, ElementId, ElementKind, Error, Point, Result, ZIndex};

/// Where an element moves among the elements of its group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restack {
    Forward,
    Backward,
    Front,
    Back,
}

/// A board, and the history of the edits made through it. Every edit, undo, and redo returns
/// the elements it touched, whose files alone change.
#[derive(Debug, Default)]
pub struct Editor {
    board: Board,
    /// As the board was when opened or last saved.
    saved: Board,
    undo: Vec<Step>,
    redo: Vec<Step>,
    gesture: Option<Step>,
}

type Step = BTreeMap<ElementId, Change>;

#[derive(Debug, Clone, PartialEq)]
struct Change {
    before: Option<Element>,
    after: Option<Element>,
}

impl Editor {
    pub fn new(board: Board) -> Self {
        Self {
            saved: board.clone(),
            board,
            ..Self::default()
        }
    }

    pub fn board(&self) -> &Board {
        &self.board
    }

    /// Whether the board is as it was when opened or last saved, however it got back there.
    pub fn is_saved(&self) -> bool {
        self.board == self.saved
    }

    /// `board` is the board as written, so that edits made while it was being written stay
    /// unsaved.
    pub fn mark_saved(&mut self, board: &Board) {
        self.saved.clone_from(board);
    }

    /// On top of the elements of `group`, or of the top level.
    pub fn add(
        &mut self,
        id: ElementId,
        group: Option<ElementId>,
        kind: ElementKind,
    ) -> Result<Vec<ElementId>> {
        if self.board.elements.contains_key(&id) {
            return Err(Error::TakenId(id));
        }
        if let Some(group) = group {
            self.existing_group(group)?;
        }
        check_valid(id, &kind)?;
        let siblings = self.siblings(group, &BTreeSet::new());
        let mut keys = place(&siblings, siblings.len(), &[id]);
        let (_, z) = keys.remove(0);
        let mut step = self.rekey(keys);
        let after = Element { group, z, kind };
        step.insert(
            id,
            Change {
                before: None,
                after: Some(after),
            },
        );
        self.record(step)
    }

    /// With the elements of the removed groups, and the groups that the removal empties.
    pub fn remove(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let mut removed = self.with_descendants(ids)?;
        loop {
            let emptied: BTreeSet<ElementId> = removed
                .iter()
                .filter_map(|id| self.board.elements[id].group)
                .filter(|group| !removed.contains(group))
                .filter(|group| self.board.members(*group).all(|id| removed.contains(&id)))
                .collect();
            if emptied.is_empty() {
                break;
            }
            removed.extend(emptied);
        }
        let step = removed
            .into_iter()
            .map(|id| (id, self.change(id, |_| None)))
            .collect();
        self.record(step)
    }

    /// Replaces an element's kind with another of the same kind.
    pub fn update(&mut self, id: ElementId, kind: ElementKind) -> Result<Vec<ElementId>> {
        if mem::discriminant(&self.get(id)?.kind) != mem::discriminant(&kind) {
            return Err(Error::KindChanged(id));
        }
        check_valid(id, &kind)?;
        let step = Step::from([(
            id,
            self.change(id, |element| Some(Element { kind, ..element })),
        )]);
        self.record(step)
    }

    /// With the elements of the moved groups.
    pub fn translate(&mut self, ids: &[ElementId], dx: f64, dy: f64) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| match kind {
            ElementKind::Image { frame, .. }
            | ElementKind::Note { frame, .. }
            | ElementKind::Sticky { frame, .. }
            | ElementKind::Shape { frame, .. } => {
                frame.x += dx;
                frame.y += dy;
            }
            ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => {
                for point in [from, to] {
                    point.x += dx;
                    point.y += dy;
                }
            }
            ElementKind::Comment { at, .. } => {
                at.x += dx;
                at.y += dy;
            }
            ElementKind::Group => {}
        })
    }

    /// With the elements of the scaled groups, around `origin`. The scale is the same both
    /// ways, so rotations hold.
    pub fn scale(
        &mut self,
        ids: &[ElementId],
        origin: Point,
        factor: f64,
    ) -> Result<Vec<ElementId>> {
        if !(factor.is_finite() && factor > 0.0) {
            return Err(Error::NotAScale);
        }
        // Its arithmetic would not give the same floats back.
        if factor == 1.0 {
            return self.with_descendants(ids).map(|_| Vec::new());
        }
        let scaled = |point: &mut Point| {
            point.x = origin.x + (point.x - origin.x) * factor;
            point.y = origin.y + (point.y - origin.y) * factor;
        };
        self.reshape(ids, |kind| {
            if let ElementKind::Note { text, .. }
            | ElementKind::Sticky { text, .. }
            | ElementKind::Shape { text, .. } = kind
            {
                text.font_size *= factor;
            }
            match kind {
                ElementKind::Image { frame, .. }
                | ElementKind::Note { frame, .. }
                | ElementKind::Sticky { frame, .. }
                | ElementKind::Shape { frame, .. } => {
                    let mut centre = frame.centre();
                    scaled(&mut centre);
                    frame.width *= factor;
                    frame.height *= factor;
                    frame.x = centre.x - frame.width / 2.0;
                    frame.y = centre.y - frame.height / 2.0;
                }
                ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => {
                    scaled(from);
                    scaled(to);
                }
                ElementKind::Comment { at, .. } => scaled(at),
                ElementKind::Group => {}
            }
        })
    }

    /// With the elements of the turned groups, clockwise around `pivot`.
    pub fn rotate(
        &mut self,
        ids: &[ElementId],
        pivot: Point,
        degrees: f64,
    ) -> Result<Vec<ElementId>> {
        if degrees == 0.0 {
            return self.with_descendants(ids).map(|_| Vec::new());
        }
        self.reshape(ids, |kind| match kind {
            ElementKind::Image {
                frame, rotation, ..
            }
            | ElementKind::Note {
                frame, rotation, ..
            }
            | ElementKind::Sticky {
                frame, rotation, ..
            }
            | ElementKind::Shape {
                frame, rotation, ..
            } => {
                let centre = frame.centre().turned(pivot, degrees);
                frame.x = centre.x - frame.width / 2.0;
                frame.y = centre.y - frame.height / 2.0;
                // An angle has a single spelling, so that equal boards write the same bytes.
                // Rounding can bring a tiny negative angle up to 360.
                let turned = (*rotation + degrees).rem_euclid(360.0);
                *rotation = if turned < 360.0 { turned } else { 0.0 };
            }
            ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => {
                *from = from.turned(pivot, degrees);
                *to = to.turned(pivot, degrees);
            }
            ElementKind::Comment { at, .. } => *at = at.turned(pivot, degrees),
            ElementKind::Group => {}
        })
    }

    /// Flips each image among the elements, with those of the flipped groups, in its place.
    pub fn flip(&mut self, ids: &[ElementId], horizontally: bool) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| {
            if let ElementKind::Image { edits, .. } = kind {
                let flipped = if horizontally {
                    &mut edits.flip_horizontal
                } else {
                    &mut edits.flip_vertical
                };
                *flipped = !*flipped;
            }
        })
    }

    /// Moves the elements among their siblings and keeps their order, forward or backward past
    /// the nearest sibling that stays, or to an end.
    pub fn restack(&mut self, ids: &[ElementId], to: Restack) -> Result<Vec<ElementId>> {
        let mut moving: BTreeMap<Option<ElementId>, BTreeSet<ElementId>> = BTreeMap::new();
        for id in ids {
            moving.entry(self.get(*id)?.group).or_default().insert(*id);
        }
        let mut step = Step::new();
        for (parent, moving) in moving {
            let before: Vec<ElementId> = self
                .siblings(parent, &BTreeSet::new())
                .into_iter()
                .map(|(_, id)| id)
                .collect();
            let mut order = before.clone();
            match to {
                Restack::Front => order.sort_by_key(|id| moving.contains(id)),
                Restack::Back => order.sort_by_key(|id| !moving.contains(id)),
                Restack::Forward => {
                    for at in (0..order.len().saturating_sub(1)).rev() {
                        if moving.contains(&order[at]) && !moving.contains(&order[at + 1]) {
                            order.swap(at, at + 1);
                        }
                    }
                }
                Restack::Backward => {
                    for at in 1..order.len() {
                        if moving.contains(&order[at]) && !moving.contains(&order[at - 1]) {
                            order.swap(at, at - 1);
                        }
                    }
                }
            }
            if order == before {
                continue;
            }
            // Each run of moving elements goes right above the siblings that stay below it.
            let mut staying = self.siblings(parent, &moving);
            let mut runs: Vec<(usize, Vec<ElementId>)> = Vec::new();
            let mut below = 0;
            for id in order {
                if !moving.contains(&id) {
                    below += 1;
                    continue;
                }
                match runs.last_mut() {
                    Some((at, run)) if *at == below => run.push(id),
                    _ => runs.push((below, vec![id])),
                }
            }
            let z = |id: &ElementId| self.board.elements[id].z.clone();
            // Those kept in place join the siblings that stay, below the runs further up.
            let mut kept = 0;
            for (at, mut run) in runs {
                let at = at + kept;
                // The ends of a run whose keys already fit where it goes keep them, so that
                // only what moves is rewritten.
                let fits = |id: &ElementId, low: Option<&ZIndex>, high: Option<&ZIndex>| {
                    let key = z(id);
                    low.is_none_or(|low| *low < key) && high.is_none_or(|high| key < *high)
                };
                let below = at.checked_sub(1).map(|at| staying[at].0.clone());
                let mut above = staying.get(at).map(|(key, _)| key.clone());
                let mut top = Vec::new();
                while let Some(&last) = run.last()
                    && fits(&last, below.as_ref(), above.as_ref())
                {
                    above = Some(z(&last));
                    top.insert(0, run.pop().expect("a last one"));
                }
                let mut bottom = Vec::new();
                let mut low = below;
                while let Some(&first) = run.first()
                    && fits(&first, low.as_ref(), above.as_ref())
                {
                    low = Some(z(&first));
                    bottom.push(run.remove(0));
                }
                let at = at + bottom.len();
                staying.splice(
                    at - bottom.len()..at - bottom.len(),
                    bottom.iter().map(|id| (z(id), *id)),
                );
                staying.splice(at..at, top.iter().map(|id| (z(id), *id)));
                kept += bottom.len() + top.len();
                let keys = place(&staying, at, &run);
                // A run can lift siblings that tie below it, which the next run must see.
                for (id, z) in &keys {
                    if let Some(sibling) = staying.iter_mut().find(|(_, sibling)| sibling == id) {
                        sibling.0 = z.clone();
                    }
                }
                step.extend(self.rekey(keys));
            }
        }
        self.record(step)
    }

    /// Puts `members`, two or more elements of the same group, into a new group, which takes
    /// the place of the topmost member.
    pub fn group(&mut self, group: ElementId, members: &[ElementId]) -> Result<Vec<ElementId>> {
        if self.board.elements.contains_key(&group) {
            return Err(Error::TakenId(group));
        }
        let members: BTreeSet<ElementId> = members.iter().copied().collect();
        let parents = members
            .iter()
            .map(|id| Ok(self.get(*id)?.group))
            .collect::<Result<BTreeSet<_>>>()?;
        if members.len() < 2 || parents.len() > 1 {
            return Err(Error::CannotGroup);
        }
        let parent = *parents.first().expect("members have a group or none");
        let all = self.siblings(parent, &BTreeSet::new());
        let top = all.iter().rposition(|(_, id)| members.contains(id));
        let at = all[..top.expect("members are siblings")]
            .iter()
            .filter(|(_, id)| !members.contains(id))
            .count();
        let mut keys = place(&self.siblings(parent, &members), at, &[group]);
        let (_, z) = keys.remove(0);
        let mut step = self.rekey(keys);
        let after = Element {
            group: parent,
            z,
            kind: ElementKind::Group,
        };
        step.insert(
            group,
            Change {
                before: None,
                after: Some(after),
            },
        );
        // Their z-indices still hold, since the group holds nothing else.
        for id in members {
            step.insert(
                id,
                self.change(id, |element| {
                    Some(Element {
                        group: Some(group),
                        ..element
                    })
                }),
            );
        }
        self.record(step)
    }

    /// Moves a group's elements into its own group, in its place, and removes it.
    pub fn ungroup(&mut self, group: ElementId) -> Result<Vec<ElementId>> {
        let parent = self.existing_group(group)?.group;
        let members: Vec<ElementId> = self
            .siblings(Some(group), &BTreeSet::new())
            .into_iter()
            .map(|(_, id)| id)
            .collect();
        let all = self.siblings(parent, &BTreeSet::new());
        let at = all
            .iter()
            .position(|(_, id)| *id == group)
            .expect("a sibling");
        let siblings = self.siblings(parent, &BTreeSet::from([group]));
        let mut keys = place(&siblings, at, &members);
        let lifted = keys.split_off(members.len());
        let mut step = self.rekey(lifted);
        for (id, z) in keys {
            let change = self.change(id, |element| {
                Some(Element {
                    group: parent,
                    z,
                    ..element
                })
            });
            step.insert(id, change);
        }
        step.insert(group, self.change(group, |_| None));
        self.record(step)
    }

    /// Edits between this and [`Editor::end_gesture`] undo as one, and cannot be undone halfway.
    pub fn begin_gesture(&mut self) {
        self.gesture.get_or_insert_default();
    }

    /// Takes the open gesture's edits back and keeps it open.
    pub fn rewind_gesture(&mut self) -> Vec<ElementId> {
        let Some(gesture) = &mut self.gesture else {
            return Vec::new();
        };
        let step = mem::take(gesture);
        for (id, change) in &step {
            set(&mut self.board, *id, change.before.clone());
        }
        step.into_keys().collect()
    }

    pub fn end_gesture(&mut self) {
        if let Some(mut gesture) = self.gesture.take() {
            gesture.retain(|_, change| change.before != change.after);
            if !gesture.is_empty() {
                self.undo.push(gesture);
                self.redo.clear();
            }
        }
    }

    pub fn undo(&mut self) -> Vec<ElementId> {
        let Some(step) = self.undo.pop_if(|_| self.gesture.is_none()) else {
            return Vec::new();
        };
        for (id, change) in &step {
            debug_assert_eq!(self.board.elements.get(id), change.after.as_ref());
            set(&mut self.board, *id, change.before.clone());
        }
        let touched = step.keys().copied().collect();
        self.redo.push(step);
        touched
    }

    pub fn redo(&mut self) -> Vec<ElementId> {
        let Some(step) = self.redo.pop_if(|_| self.gesture.is_none()) else {
            return Vec::new();
        };
        for (id, change) in &step {
            debug_assert_eq!(self.board.elements.get(id), change.before.as_ref());
            set(&mut self.board, *id, change.after.clone());
        }
        let touched = step.keys().copied().collect();
        self.undo.push(step);
        touched
    }

    pub fn can_undo(&self) -> bool {
        self.gesture.is_none() && !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        self.gesture.is_none() && !self.redo.is_empty()
    }

    fn record(&mut self, mut step: Step) -> Result<Vec<ElementId>> {
        step.retain(|_, change| change.before != change.after);
        for (id, change) in &step {
            set(&mut self.board, *id, change.after.clone());
        }
        let touched = step.keys().copied().collect();
        match &mut self.gesture {
            Some(gesture) => {
                for (id, change) in step {
                    gesture
                        .entry(id)
                        .and_modify(|merged| merged.after.clone_from(&change.after))
                        .or_insert(change);
                }
            }
            None if step.is_empty() => {}
            None => {
                self.undo.push(step);
                self.redo.clear();
            }
        }
        Ok(touched)
    }

    fn reshape(
        &mut self,
        ids: &[ElementId],
        edit: impl Fn(&mut ElementKind),
    ) -> Result<Vec<ElementId>> {
        let mut step = Step::new();
        for id in self.with_descendants(ids)? {
            let change = self.change(id, |mut element| {
                edit(&mut element.kind);
                Some(element)
            });
            check_valid(id, &change.after.as_ref().expect("reshaped").kind)?;
            step.insert(id, change);
        }
        self.record(step)
    }

    fn get(&self, id: ElementId) -> Result<&Element> {
        self.board
            .elements
            .get(&id)
            .ok_or(Error::UnknownElement(id))
    }

    fn existing_group(&self, id: ElementId) -> Result<&Element> {
        let element = self.get(id)?;
        match element.kind {
            ElementKind::Group => Ok(element),
            _ => Err(Error::NotAGroup(id)),
        }
    }

    /// The element must exist.
    fn change(&self, id: ElementId, edit: impl FnOnce(Element) -> Option<Element>) -> Change {
        let before = self.board.elements[&id].clone();
        Change {
            after: edit(before.clone()),
            before: Some(before),
        }
    }

    /// The elements of `group`, or of the top level, from back to front, but for `excluded`.
    fn siblings(
        &self,
        group: Option<ElementId>,
        excluded: &BTreeSet<ElementId>,
    ) -> Vec<(ZIndex, ElementId)> {
        let mut siblings: Vec<(ZIndex, ElementId)> = self
            .board
            .elements
            .iter()
            .filter(|(id, element)| element.group == group && !excluded.contains(id))
            .map(|(id, element)| (element.z.clone(), *id))
            .collect();
        siblings.sort_unstable();
        siblings
    }

    fn with_descendants(&self, ids: &[ElementId]) -> Result<BTreeSet<ElementId>> {
        for id in ids {
            self.get(*id)?;
        }
        Ok(self.board.with_descendants(ids))
    }

    fn rekey(&self, keys: Vec<(ElementId, ZIndex)>) -> Step {
        keys.into_iter()
            .map(|(id, z)| {
                (
                    id,
                    self.change(id, |element| Some(Element { z, ..element })),
                )
            })
            .collect()
    }
}

/// Keys that stack `ids`, in order, right above the first `at` of `siblings`, which are
/// sorted. The siblings above that share the key right below get new keys too, since no key
/// fits between two equal ones.
fn place(
    siblings: &[(ZIndex, ElementId)],
    at: usize,
    ids: &[ElementId],
) -> Vec<(ElementId, ZIndex)> {
    if ids.is_empty() {
        return Vec::new();
    }
    let below = at.checked_sub(1).map(|at| &siblings[at].0);
    let tied = siblings[at..]
        .iter()
        .take_while(|(z, _)| Some(z) == below)
        .count();
    let above = siblings.get(at + tied).map(|(z, _)| z);
    let lifted = siblings[at..at + tied].iter().map(|(_, id)| *id);
    let mut previous = below.cloned();
    ids.iter()
        .copied()
        .chain(lifted)
        .map(|id| {
            let z = ZIndex::between(previous.as_ref(), above).expect("below is under above");
            previous = Some(z.clone());
            (id, z)
        })
        .collect()
}

fn check_valid(id: ElementId, kind: &ElementKind) -> Result<()> {
    if kind.is_valid() {
        Ok(())
    } else {
        Err(Error::Invalid(id))
    }
}

fn set(board: &mut Board, id: ElementId, element: Option<Element>) {
    match element {
        Some(element) => board.elements.insert(id, element),
        None => board.elements.remove(&id),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{arrow, board, element, id};
    use crate::{Rect, Text};

    fn note(x: f64) -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            rotation: 0.0,
            text: Text {
                content: String::new(),
                font_size: 2.0,
            },
        }
    }

    fn ids<const N: usize>(bits: [u128; N]) -> Vec<ElementId> {
        bits.map(id).to_vec()
    }

    fn editor() -> Editor {
        Editor::new(board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", note(0.0))),
            (3, element(Some(1), "a1", note(10.0))),
            (4, element(None, "a1", note(20.0))),
            (5, element(None, "a2", arrow())),
        ]))
    }

    fn order(editor: &Editor) -> Vec<ElementId> {
        editor.board().draw_order()
    }

    fn assert_sound(editor: &Editor) {
        let mut board = editor.board().clone();
        board.repair();
        assert_eq!(&board, editor.board());
    }

    #[test]
    fn an_element_is_added_on_top_of_its_group() {
        let mut editor = editor();
        editor.add(id(6), None, note(0.0)).unwrap();
        editor.add(id(7), Some(id(1)), arrow()).unwrap();
        assert_eq!(order(&editor), ids([1, 2, 3, 7, 4, 5, 6]));
    }

    #[test]
    fn a_refused_edit_changes_nothing() {
        let mut editor = editor();
        editor.begin_gesture();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        let before = editor.board().clone();
        let refused = [
            editor.add(id(4), None, arrow()),
            editor.add(id(6), Some(id(9)), arrow()),
            editor.add(id(6), Some(id(4)), arrow()),
            editor.add(id(6), None, note(f64::NAN)),
            editor.translate(&[id(4)], f64::INFINITY, 0.0),
            editor.update(id(4), arrow()),
            editor.remove(&[id(9)]),
            editor.restack(&[id(9)], Restack::Front),
            editor.scale(&[id(4)], Point { x: 0.0, y: 0.0 }, 0.0),
            editor.group(id(6), &[id(4)]),
            editor.group(id(6), &[id(2), id(4)]),
            editor.group(id(1), &[id(4), id(5)]),
            editor.ungroup(id(4)),
        ];
        let errors = refused.map(|result| result.unwrap_err());
        assert_eq!(
            errors,
            [
                Error::TakenId(id(4)),
                Error::UnknownElement(id(9)),
                Error::NotAGroup(id(4)),
                Error::Invalid(id(6)),
                Error::Invalid(id(4)),
                Error::KindChanged(id(4)),
                Error::UnknownElement(id(9)),
                Error::UnknownElement(id(9)),
                Error::NotAScale,
                Error::CannotGroup,
                Error::CannotGroup,
                Error::TakenId(id(1)),
                Error::NotAGroup(id(4)),
            ]
        );
        assert_eq!(editor.board(), &before);
        editor.end_gesture();
        assert_eq!(editor.undo(), ids([4]));
        assert!(editor.undo().is_empty());
    }

    #[test]
    fn removing_a_group_removes_its_elements() {
        let mut editor = editor();
        editor.add(id(6), Some(id(1)), ElementKind::Group).unwrap();
        editor.add(id(7), Some(id(6)), arrow()).unwrap();
        let before = editor.board().clone();
        editor.remove(&[id(1)]).unwrap();
        assert_eq!(order(&editor), ids([4, 5]));
        assert_sound(&editor);
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_group_emptied_by_a_removal_goes_too() {
        let mut editor = editor();
        editor.remove(&[id(2)]).unwrap();
        assert_eq!(order(&editor), ids([1, 3, 4, 5]));
        editor.remove(&[id(3)]).unwrap();
        assert_eq!(order(&editor), ids([4, 5]));
        assert_eq!(editor.undo(), ids([1, 3]));
    }

    #[test]
    fn emptied_groups_go_all_the_way_up() {
        let mut editor = editor();
        editor.group(id(6), &[id(1), id(4)]).unwrap();
        editor.remove(&[id(2), id(3), id(4)]).unwrap();
        assert_eq!(order(&editor), ids([5]));
        assert_eq!(editor.undo(), ids([1, 2, 3, 4, 6]));
    }

    #[test]
    fn restacking_moves_one_step_or_to_an_end() {
        let mut editor = editor();
        for (element, to, expected) in [
            (4, Restack::Forward, [1, 2, 3, 5, 4]),
            (4, Restack::Back, [4, 1, 2, 3, 5]),
            (4, Restack::Forward, [1, 2, 3, 4, 5]),
            (1, Restack::Front, [4, 5, 1, 2, 3]),
            (1, Restack::Backward, [4, 1, 2, 3, 5]),
            (3, Restack::Back, [4, 1, 3, 2, 5]),
        ] {
            editor.restack(&[id(element)], to).unwrap();
            assert_eq!(order(&editor), ids(expected), "{element} {to:?}");
        }
    }

    #[test]
    fn restacking_several_keeps_their_order() {
        let arrows = |keys: [&str; 5]| {
            board(
                (1..=5)
                    .zip(keys)
                    .map(|(bits, key)| (bits, element(None, key, arrow()))),
            )
        };
        for (moving, to, expected) in [
            (&[1, 2][..], Restack::Forward, [3, 1, 2, 4, 5]),
            (&[2, 4], Restack::Backward, [2, 1, 4, 3, 5]),
            (&[1, 3], Restack::Front, [2, 4, 5, 1, 3]),
            (&[3, 5], Restack::Back, [3, 5, 1, 2, 4]),
        ] {
            let mut editor = Editor::new(arrows(["a0", "a1", "a2", "a3", "a4"]));
            let moving: Vec<ElementId> = moving.iter().copied().map(id).collect();
            editor.restack(&moving, to).unwrap();
            assert_eq!(order(&editor), ids(expected), "{moving:?} {to:?}");
        }
        // Blocked by one another at the top, neither moves.
        let mut editor = Editor::new(arrows(["a0", "a1", "a2", "a3", "a4"]));
        assert!(
            editor
                .restack(&ids([4, 5]), Restack::Forward)
                .unwrap()
                .is_empty()
        );
        // A merge can leave keys tied, which each run lifts past.
        let mut editor = Editor::new(arrows(["a0"; 5]));
        editor.restack(&ids([1, 3]), Restack::Forward).unwrap();
        assert_eq!(order(&editor), ids([2, 1, 4, 3, 5]));
        assert_sound(&editor);
    }

    #[test]
    fn restacking_several_rewrites_only_those_that_move() {
        let arrows = || {
            board(
                (1..=5)
                    .zip(["a0", "a1", "a2", "a3", "a4"])
                    .map(|(bits, key)| (bits, element(None, key, arrow()))),
            )
        };
        for (moving, to, expected, touched) in [
            ([3, 5], Restack::Front, [1, 2, 4, 3, 5], [3]),
            ([1, 3], Restack::Back, [1, 3, 2, 4, 5], [3]),
            ([2, 5], Restack::Forward, [1, 3, 2, 4, 5], [2]),
        ] {
            let mut editor = Editor::new(arrows());
            assert_eq!(editor.restack(&ids(moving), to).unwrap(), ids(touched));
            assert_eq!(order(&editor), ids(expected), "{moving:?} {to:?}");
        }
    }

    #[test]
    fn restacking_at_an_end_records_nothing() {
        let mut editor = editor();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        for (element, to) in [
            (5, Restack::Forward),
            (5, Restack::Front),
            (1, Restack::Backward),
            (1, Restack::Back),
            (2, Restack::Back),
            (3, Restack::Front),
        ] {
            assert!(editor.restack(&[id(element)], to).unwrap().is_empty());
        }
        assert_eq!(editor.undo(), ids([4]));
    }

    #[test]
    fn an_edit_that_changes_nothing_records_nothing() {
        let mut editor = editor();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        let same = editor.board().elements[&id(4)].kind.clone();
        assert!(editor.update(id(4), same).unwrap().is_empty());
        assert!(editor.translate(&[id(5)], 0.0, 0.0).unwrap().is_empty());
        assert_eq!(editor.undo(), ids([4]));
    }

    #[test]
    fn restacking_among_equal_z_indices_lifts_the_siblings_above() {
        // A merge of concurrent edits can leave siblings with equal keys, drawn by id.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", arrow())),
            (2, element(None, "a1", arrow())),
            (3, element(None, "a1", arrow())),
            (4, element(None, "a1", arrow())),
            (5, element(None, "a2", arrow())),
        ]));
        editor.restack(&[id(1)], Restack::Forward).unwrap();
        assert_eq!(order(&editor), ids([2, 1, 3, 4, 5]));
        assert_eq!(editor.undo(), ids([1, 3, 4]));
    }

    #[test]
    fn scaling_keeps_the_origin_in_place_and_rotations_as_they_are_and_scales_text() {
        let mut editor = Editor::new(board([(1, element(None, "a0", note(0.0)))]));
        editor
            .rotate(&ids([1]), Point { x: 0.0, y: 0.0 }, 30.0)
            .unwrap();
        let corners = editor.board().outline(id(1)).unwrap();
        editor.scale(&ids([1]), corners[2], 3.0).unwrap();
        let scaled = editor.board().outline(id(1)).unwrap();
        assert!((scaled[2].x - corners[2].x).abs() < 1e-9);
        assert!((scaled[2].y - corners[2].y).abs() < 1e-9);
        let ElementKind::Note {
            frame,
            rotation,
            text,
        } = &editor.board().elements[&id(1)].kind
        else {
            unreachable!()
        };
        assert_eq!((frame.width, frame.height, *rotation), (30.0, 30.0, 30.0));
        assert_eq!(text.font_size, 6.0);
    }

    #[test]
    fn rotating_turns_positions_around_the_pivot_and_keeps_one_spelling() {
        let mut editor = editor();
        editor
            .rotate(&ids([4, 5]), Point { x: 20.0, y: 0.0 }, 90.0)
            .unwrap();
        let elements = &editor.board().elements;
        let ElementKind::Note {
            frame, rotation, ..
        } = &elements[&id(4)].kind
        else {
            unreachable!()
        };
        // Its centre, (25, 5), turns to (15, 5).
        assert!((frame.x - 10.0).abs() < 1e-9 && frame.y.abs() < 1e-9);
        assert_eq!(*rotation, 90.0);
        editor
            .rotate(&ids([4]), Point { x: 0.0, y: 0.0 }, 300.0)
            .unwrap();
        let ElementKind::Note { rotation, .. } = &editor.board().elements[&id(4)].kind else {
            unreachable!()
        };
        assert_eq!(*rotation, 30.0);
        editor
            .rotate(&ids([4]), Point { x: 0.0, y: 0.0 }, -30.000_000_000_000_004)
            .unwrap();
        let ElementKind::Note { rotation, .. } = &editor.board().elements[&id(4)].kind else {
            unreachable!()
        };
        assert!((0.0..360.0).contains(rotation), "{rotation}");
    }

    #[test]
    fn flipping_turns_over_only_the_images() {
        let image = ElementKind::Image {
            asset: crate::AssetId::of(b""),
            natural_size: crate::Size {
                width: 1,
                height: 1,
            },
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            rotation: 0.0,
            edits: crate::ImageEdits::default(),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", image)),
            (3, element(Some(1), "a1", note(0.0))),
        ]));
        assert_eq!(editor.flip(&ids([1]), false).unwrap(), ids([2]));
        let ElementKind::Image { edits, .. } = &editor.board().elements[&id(2)].kind else {
            unreachable!()
        };
        assert!(edits.flip_vertical && !edits.flip_horizontal);
        editor.flip(&ids([1]), false).unwrap();
        assert!(editor.is_saved());
    }

    #[test]
    fn grouping_takes_the_place_of_the_topmost_member() {
        let mut editor = editor();
        editor.group(id(6), &[id(1), id(5)]).unwrap();
        assert_eq!(order(&editor), ids([4, 6, 1, 2, 3, 5]));
        assert_sound(&editor);
        assert_eq!(editor.undo(), ids([1, 5, 6]));
    }

    #[test]
    fn grouping_and_ungrouping_work_inside_a_group() {
        let mut editor = editor();
        editor.group(id(6), &[id(2), id(3)]).unwrap();
        assert_eq!(order(&editor), ids([1, 6, 2, 3, 4, 5]));
        assert_eq!(editor.board().elements[&id(6)].group, Some(id(1)));
        editor.ungroup(id(6)).unwrap();
        assert_eq!(order(&editor), ids([1, 2, 3, 4, 5]));
        assert_eq!(editor.board().elements[&id(2)].group, Some(id(1)));
        assert_sound(&editor);
    }

    #[test]
    fn ungrouping_an_empty_group_touches_nothing_else() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", arrow())),
            (2, element(None, "a0", ElementKind::Group)),
            (3, element(None, "a0", arrow())),
        ]));
        assert_eq!(editor.ungroup(id(2)).unwrap(), ids([2]));
    }

    #[test]
    fn ungrouping_puts_the_members_in_the_place_of_the_group() {
        let mut editor = editor();
        editor.ungroup(id(1)).unwrap();
        assert_eq!(order(&editor), ids([2, 3, 4, 5]));
        assert_sound(&editor);
        assert_eq!(editor.undo(), ids([1, 2, 3]));
    }

    #[test]
    fn ungrouping_several_groups_in_one_gesture_undoes_as_one() {
        let mut editor = editor();
        editor.group(id(6), &[id(4), id(5)]).unwrap();
        let grouped = editor.board().clone();

        editor.begin_gesture();
        editor.ungroup(id(1)).unwrap();
        editor.ungroup(id(6)).unwrap();
        editor.end_gesture();
        let ungrouped = editor.board().clone();
        assert_eq!(order(&editor), ids([2, 3, 4, 5]));

        assert_eq!(editor.undo(), ids([1, 2, 3, 4, 5, 6]));
        assert_eq!(editor.board(), &grouped);
        editor.redo();
        assert_eq!(editor.board(), &ungrouped);
    }

    #[test]
    fn moving_a_group_moves_its_elements() {
        let mut editor = editor();
        editor.translate(&[id(1), id(5)], 5.0, -5.0).unwrap();
        let elements = &editor.board().elements;
        let ElementKind::Note { frame, .. } = &elements[&id(3)].kind else {
            unreachable!()
        };
        assert_eq!((frame.x, frame.y), (15.0, -5.0));
        let ElementKind::Arrow { from, to } = &elements[&id(5)].kind else {
            unreachable!()
        };
        assert_eq!((from.x, from.y, to.x, to.y), (5.0, -5.0, 5.0, -5.0));
        assert_eq!(editor.undo(), ids([2, 3, 5]));
    }

    #[test]
    fn undo_and_redo_walk_the_history() {
        let mut editor = editor();
        let start = editor.board().clone();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        let moved = editor.board().clone();
        editor.update(id(4), note(99.0)).unwrap();
        let updated = editor.board().clone();

        assert_eq!(editor.undo(), ids([4]));
        assert_eq!(editor.board(), &moved);
        assert_eq!(editor.redo(), ids([4]));
        assert_eq!(editor.board(), &updated);
        editor.undo();
        editor.undo();
        assert_eq!(editor.board(), &start);
        assert!(editor.undo().is_empty());

        editor.redo();
        editor.remove(&[id(5)]).unwrap();
        assert!(editor.redo().is_empty());
    }

    #[test]
    fn undo_and_redo_tell_whether_they_would_change_anything() {
        let mut editor = editor();
        assert!(!editor.can_undo());
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        assert!(editor.can_undo());
        assert!(!editor.can_redo());

        editor.undo();
        assert!(!editor.can_undo());
        assert!(editor.can_redo());

        editor.begin_gesture();
        assert!(!editor.can_redo());
        editor.end_gesture();
        assert!(editor.can_redo());
    }

    #[test]
    fn a_board_is_saved_until_it_changes_and_again_once_back() {
        let mut editor = editor();
        assert!(editor.is_saved());
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        assert!(!editor.is_saved());
        editor.undo();
        assert!(editor.is_saved());
        editor.redo();
        let written = editor.board().clone();
        editor.mark_saved(&written);
        assert!(editor.is_saved());
        editor.undo();
        assert!(!editor.is_saved());
    }

    #[test]
    fn an_edit_made_while_saving_stays_unsaved() {
        let mut editor = editor();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        let written = editor.board().clone();
        editor.translate(&[id(5)], 1.0, 0.0).unwrap();
        editor.mark_saved(&written);
        assert!(!editor.is_saved());
        editor.undo();
        assert!(editor.is_saved());
    }

    #[test]
    fn a_gesture_undoes_as_one() {
        let mut editor = editor();
        let start = editor.board().clone();
        editor.begin_gesture();
        for _ in 0..100 {
            editor.translate(&[id(1)], 0.1, 0.1).unwrap();
        }
        editor.end_gesture();
        assert_eq!(editor.undo(), ids([2, 3]));
        assert_eq!(editor.board(), &start);

        editor.begin_gesture();
        editor.translate(&[id(4)], 0.5, 0.0).unwrap();
        editor.translate(&[id(4)], -0.5, 0.0).unwrap();
        editor.end_gesture();
        assert!(editor.undo().is_empty());
    }

    #[test]
    fn a_rewound_gesture_edits_again_from_where_it_began() {
        let mut editor = editor();
        let start = editor.board().clone();
        assert!(editor.rewind_gesture().is_empty());
        editor.begin_gesture();
        editor
            .scale(&ids([4]), Point { x: 0.0, y: 0.0 }, 1.7)
            .unwrap();
        assert_eq!(editor.rewind_gesture(), ids([4]));
        assert_eq!(editor.board(), &start);
        editor
            .scale(&ids([4]), Point { x: 0.0, y: 0.0 }, 1.0)
            .unwrap();
        editor.end_gesture();
        assert!(editor.undo().is_empty());
        assert!(editor.is_saved());
    }

    #[test]
    fn a_gesture_cannot_be_undone_halfway() {
        let mut editor = editor();
        editor.translate(&[id(5)], 1.0, 0.0).unwrap();
        editor.translate(&[id(3)], 1.0, 0.0).unwrap();
        editor.undo();
        editor.begin_gesture();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        let halfway = editor.board().clone();
        assert!(editor.undo().is_empty());
        assert!(editor.redo().is_empty());
        assert_eq!(editor.board(), &halfway);
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        editor.end_gesture();

        assert!(editor.redo().is_empty());
        assert_eq!(editor.undo(), ids([4]));
        assert_eq!(editor.undo(), ids([5]));
    }

    #[test]
    fn a_gesture_that_changes_nothing_keeps_what_can_be_redone() {
        let mut editor = editor();
        editor.translate(&[id(4)], 5.0, 0.0).unwrap();
        editor.undo();
        editor.begin_gesture();
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        editor.translate(&[id(4)], -1.0, 0.0).unwrap();
        editor.end_gesture();
        assert_eq!(editor.redo(), ids([4]));
    }

    #[test]
    fn restacking_moves_each_parents_elements_among_their_own_siblings() {
        let mut editor = editor();
        editor.restack(&ids([4, 2]), Restack::Front).unwrap();
        assert_eq!(order(&editor), ids([1, 3, 2, 5, 4]));
        editor.restack(&ids([5, 2]), Restack::Back).unwrap();
        assert_eq!(order(&editor), ids([5, 1, 2, 3, 4]));
        // One parent's elements are already there, the other's still move.
        assert_eq!(
            editor.restack(&ids([3, 1]), Restack::Front).unwrap(),
            ids([1])
        );
        assert_eq!(order(&editor), ids([5, 4, 1, 2, 3]));
        assert_sound(&editor);
    }

    #[test]
    fn scaling_and_rotating_move_both_ends_of_an_arrow_or_a_line() {
        let (from, to) = (Point { x: 10.0, y: 0.0 }, Point { x: 20.0, y: 0.0 });
        let ends = |editor: &Editor| match editor.board().elements[&id(1)].kind {
            ElementKind::Arrow { from, to } | ElementKind::Line { from, to } => {
                [from.x, from.y, to.x, to.y]
            }
            _ => unreachable!(),
        };
        for kind in [
            ElementKind::Arrow { from, to },
            ElementKind::Line { from, to },
        ] {
            let mut editor = Editor::new(board([(1, element(None, "a0", kind))]));
            editor
                .scale(&ids([1]), Point { x: 10.0, y: 0.0 }, 2.0)
                .unwrap();
            assert_eq!(ends(&editor), [10.0, 0.0, 30.0, 0.0]);
            editor
                .rotate(&ids([1]), Point { x: 0.0, y: 0.0 }, 90.0)
                .unwrap();
            let expected = [0.0, 10.0, 0.0, 30.0];
            for (end, expected) in ends(&editor).into_iter().zip(expected) {
                assert!((end - expected).abs() < 1e-9, "{end} {expected}");
            }
        }
    }

    #[test]
    fn a_comment_moves_scales_and_turns_with_its_pin() {
        let comment = ElementKind::Comment {
            at: Point { x: 10.0, y: 0.0 },
            text: "Too dark".to_owned(),
        };
        let mut editor = Editor::new(board([(1, element(None, "a0", comment))]));
        let at = |editor: &Editor| match &editor.board().elements[&id(1)].kind {
            ElementKind::Comment { at, .. } => (at.x, at.y),
            _ => unreachable!(),
        };
        editor.translate(&ids([1]), 5.0, 5.0).unwrap();
        assert_eq!(at(&editor), (15.0, 5.0));
        editor
            .scale(&ids([1]), Point { x: 5.0, y: 5.0 }, 2.0)
            .unwrap();
        assert_eq!(at(&editor), (25.0, 5.0));
        editor
            .rotate(&ids([1]), Point { x: 5.0, y: 5.0 }, 90.0)
            .unwrap();
        let (x, y) = at(&editor);
        assert!((x - 5.0).abs() < 1e-9 && (y - 25.0).abs() < 1e-9, "{x} {y}");
    }

    #[test]
    fn scaling_or_rotating_by_nothing_still_refuses_unknown_elements() {
        let mut editor = editor();
        let origin = Point { x: 0.0, y: 0.0 };
        assert_eq!(
            editor.scale(&ids([9]), origin, 1.0),
            Err(Error::UnknownElement(id(9)))
        );
        assert_eq!(
            editor.rotate(&ids([9]), origin, 0.0),
            Err(Error::UnknownElement(id(9)))
        );
    }

    #[test]
    fn a_font_size_that_is_not_positive_is_refused() {
        let sized = |font_size| ElementKind::Note {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            rotation: 0.0,
            text: Text {
                content: "a".to_owned(),
                font_size,
            },
        };
        for font_size in [0.0, -0.0, -2.0] {
            let mut editor = editor();
            assert!(
                editor.add(id(6), None, sized(font_size)).is_err(),
                "{font_size}"
            );
            assert!(
                editor.update(id(4), sized(font_size)).is_err(),
                "{font_size}"
            );
        }
        // Scaling by tiny factors underflows to zero.
        let mut editor = editor();
        let origin = Point { x: 0.0, y: 0.0 };
        let underflowed = editor
            .scale(&[id(4)], origin, f64::MIN_POSITIVE)
            .and_then(|_| editor.scale(&[id(4)], origin, f64::MIN_POSITIVE));
        assert!(
            underflowed.is_err(),
            "{:?}",
            editor.board().elements[&id(4)].kind
        );
    }
}
