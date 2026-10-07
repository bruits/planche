//! Edits to a board, each one undoable. The history keeps every touched element, and the
//! background, as it was before and after, never a way to recompute it, so that undoing gives
//! back the same bytes.
//! It lives in memory only.

use std::collections::{BTreeMap, BTreeSet};
use std::iter;
use std::mem;

use serde::Deserialize;

use crate::align::{Alignment, Axis, alignment, distribution};
use crate::arrange::{Order, Side, arrangement, normalization};
use crate::crop::cropped;
use crate::grid::settled;
use crate::stick::{Landing, Motion, lands_on};
use crate::{
    AssetId, Background, Board, Copied, CropShape, Element, ElementId, ElementKind, Error,
    ImageEdits, Point, Rect, Result, Speed, Trim, ZIndex, angle, with_emptied,
};

/// Where an element moves among the elements of its group.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Restack {
    Forward,
    Backward,
    Front,
    Back,
}

/// A flip, a scale, a turn, and a move at once, in that order, which sets down what sticks whole
/// among the elements as the user's moves do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Transform {
    /// Of the images among the elements, each in its place, `horizontal` swapping left and right.
    #[cfg_attr(feature = "ts", ts(optional))]
    pub flip: Option<Axis>,
    #[cfg_attr(feature = "ts", ts(optional))]
    pub scale: Option<Scaling>,
    /// Clockwise, in degrees.
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rotate: Option<f64>,
    /// What the elements scale and turn around, the middle of their extent unless given.
    #[cfg_attr(feature = "ts", ts(optional))]
    pub about: Option<Point>,
    #[cfg_attr(feature = "ts", ts(optional))]
    pub place: Option<Placement>,
    /// Puts back on the grid's lines what the move or the scale left a hair off them.
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub settle: bool,
    /// Unless given, what moved, scaled, or turned lands where it is, and the rest stays.
    #[cfg_attr(feature = "ts", ts(optional))]
    pub sticking: Option<Sticking>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Scaling {
    By(f64),
    /// As wide as their extent is then.
    ToWidth(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Placement {
    By(Point),
    /// The top-left corner of their extent there, once flipped, scaled, and turned.
    To(Point),
}

/// What becomes of the notes, sticky notes, shapes, strokes, and comments set down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Sticking {
    /// Onto what they lie on whole, as [`Editor::land`] does.
    Land,
    /// From what they stick to, as [`Editor::unstick`] does.
    Free,
}

/// A board, and the history of the edits made through it. Every edit, undo, and redo returns
/// the elements it touched, whose files alone change, but for the manifest when the background
/// does.
#[derive(Debug, Default)]
pub struct Editor {
    board: Board,
    /// As the board was when opened or last saved.
    saved: Board,
    undo: Vec<Step>,
    redo: Vec<Step>,
    gesture: Option<Step>,
}

#[derive(Debug, Default)]
struct Step {
    elements: Changes,
    background: Option<Change<Background>>,
}

type Changes = BTreeMap<ElementId, Change<Option<Element>>>;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Change<T> {
    before: T,
    after: T,
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
        let kind = self.played_alike(kind.canonical());
        check_valid(id, &kind)?;
        self.check_targets(id, &kind)?;
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

    /// On top of the elements of `group`, or of the top level, stacked as they were, each under
    /// the id `ids` gives it. What a copy made elsewhere would break, it mends as
    /// [`Board::repair`] does.
    pub fn paste(
        &mut self,
        copied: &Copied,
        ids: &BTreeMap<ElementId, ElementId>,
        group: Option<ElementId>,
    ) -> Result<Vec<ElementId>> {
        if let Some(group) = group {
            self.existing_group(group)?;
        }
        let mut renamed = BTreeMap::new();
        let mut taken = BTreeSet::new();
        for old in copied.elements.keys() {
            let id = *ids.get(old).ok_or(Error::Unnamed(*old))?;
            if self.board.elements.contains_key(&id) || !taken.insert(id) {
                return Err(Error::TakenId(id));
            }
            renamed.insert(*old, id);
        }
        let mut pasted = Board::default();
        for (old, element) in &copied.elements {
            let id = renamed[old];
            let mut kind = self.played_alike(element.kind.clone().canonical());
            check_valid(id, &kind)?;
            for target in kind.targets_mut() {
                *target = target.and_then(|target| renamed.get(&target).copied());
            }
            let group = element.group.and_then(|group| renamed.get(&group).copied());
            let z = element.z.clone();
            pasted.elements.insert(id, Element { group, z, kind });
        }
        pasted.repair();
        let outermost: Vec<ElementId> = pasted
            .draw_order()
            .into_iter()
            .filter(|id| pasted.elements[id].group.is_none())
            .collect();
        let siblings = self.siblings(group, &BTreeSet::new());
        let mut keys = place(&siblings, siblings.len(), &outermost);
        let lifted = keys.split_off(outermost.len());
        let mut step = self.rekey(lifted);
        for (id, z) in keys {
            let element = pasted.elements.get_mut(&id).expect("pasted");
            element.group = group;
            element.z = z;
        }
        for (id, element) in pasted.elements {
            let after = Some(element);
            step.insert(
                id,
                Change {
                    before: None,
                    after,
                },
            );
        }
        self.record(step)
    }

    /// With the elements of the removed groups, and the groups that the removal empties. What
    /// sticks to them comes free where it is.
    pub fn remove(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let removed = with_emptied(&self.board.elements, self.with_descendants(ids)?);
        let mut step: Changes = removed
            .iter()
            .map(|id| (*id, self.change(*id, |_| None)))
            .collect();
        for (id, element) in &self.board.elements {
            if removed.contains(id)
                || !element
                    .kind
                    .targets()
                    .any(|target| removed.contains(&target))
            {
                continue;
            }
            let mut kind = element.kind.clone();
            for target in kind.targets_mut() {
                target.take_if(|target| removed.contains(target));
            }
            step.insert(
                *id,
                self.change(*id, |element| Some(Element { kind, ..element })),
            );
        }
        self.record(step)
    }

    /// Replaces an element's kind with another of the same kind. What sticks to it follows it.
    pub fn update(&mut self, id: ElementId, kind: ElementKind) -> Result<Vec<ElementId>> {
        if mem::discriminant(&self.get(id)?.kind) != mem::discriminant(&kind) {
            return Err(Error::KindChanged(id));
        }
        let kind = kind.canonical();
        check_valid(id, &kind)?;
        self.check_targets(id, &kind)?;
        let mut step = Changes::from([(
            id,
            self.change(id, |element| Some(Element { kind, ..element })),
        )]);
        self.follow(&mut step);
        self.record(step)
    }

    /// Replaces an element's kind with another of the same kind, as moving a side of its frame
    /// does. What sticks to it keeps to the same parts of its frame, and what sticks whole keeps
    /// its size.
    pub fn stretch(&mut self, id: ElementId, kind: ElementKind) -> Result<Vec<ElementId>> {
        let before = &self.get(id)?.kind;
        if mem::discriminant(before) != mem::discriminant(&kind) {
            return Err(Error::KindChanged(id));
        }
        let kind = kind.canonical();
        check_valid(id, &kind)?;
        self.check_targets(id, &kind)?;
        let moved = Motion::stretch(before, &kind).map(|motion| (id, motion));
        let mut step = Changes::from([(
            id,
            self.change(id, |element| Some(Element { kind, ..element })),
        )]);
        let unmoved = changed(&step);
        self.carry(&mut step, moved.into_iter().collect(), &unmoved);
        self.record(step)
    }

    /// Sticks each note, sticky note, shape, stroke, and comment among the elements, with those of
    /// the groups among them, to what it lies on whole, or frees it when it lies on nothing.
    pub fn land(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let landing: Vec<ElementId> = self
            .with_descendants(ids)?
            .into_iter()
            .filter(|id| self.board.elements[id].kind.sticks_whole())
            .collect();
        if landing.is_empty() {
            return Ok(Vec::new());
        }
        let mut surfaces = Landing::new(&self.board);
        let targets = landing
            .into_iter()
            .map(|id| (id, surfaces.land(id)))
            .collect();
        self.stick_whole(targets)
    }

    /// Frees each note, sticky note, shape, stroke, and comment among the elements, with those of
    /// the groups among them, from what it sticks to.
    pub fn unstick(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let stuck = self
            .with_descendants(ids)?
            .into_iter()
            .filter(|id| self.board.elements[id].kind.target().is_some())
            .map(|id| (id, None));
        self.stick_whole(stuck.collect())
    }

    /// With the elements of the moved groups.
    pub fn translate(&mut self, ids: &[ElementId], dx: f64, dy: f64) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| shift(kind, dx, dy))
    }

    /// With the elements of the groups among them, as one edit, refused as a whole when any part
    /// of it is.
    pub fn transform(
        &mut self,
        ids: &[ElementId],
        transform: &Transform,
    ) -> Result<Vec<ElementId>> {
        let Transform {
            flip,
            scale,
            rotate,
            about,
            place,
            settle,
            sticking,
        } = *transform;
        // Before measuring them, which leaves unknown ones out.
        for id in ids {
            self.get(*id)?;
        }
        let room = |board: &Board| board.extent(ids).ok_or(Error::NoRoom);
        let factor = match scale {
            Some(Scaling::By(factor)) => Some(factor),
            Some(Scaling::ToWidth(width)) => Some(width / room(&self.board)?.width),
            None => None,
        };
        let turn = rotate.filter(|degrees| *degrees != 0.0);
        let pivot = match about {
            _ if factor.is_none() && turn.is_none() => None,
            Some(about) => Some(about),
            None => Some(room(&self.board)?.centre()),
        };
        let moved = factor.is_some() || turn.is_some() || place.is_some();
        let sticking = sticking.or(moved.then_some(Sticking::Land));
        self.composed(|editor| {
            if let Some(flip) = flip {
                editor.flip(ids, flip == Axis::Horizontal)?;
            }
            if let (Some(factor), Some(pivot)) = (factor, pivot) {
                editor.scale(ids, pivot, factor)?;
            }
            if let (Some(degrees), Some(pivot)) = (turn, pivot) {
                editor.rotate(ids, pivot, degrees)?;
            }
            let by = match place {
                Some(Placement::By(by)) => Some(by),
                Some(Placement::To(to)) => {
                    let now = room(&editor.board)?;
                    Some(Point {
                        x: to.x - now.x,
                        y: to.y - now.y,
                    })
                }
                None => None,
            };
            if let Some(by) = by {
                editor.translate(ids, by.x, by.y)?;
            }
            if settle {
                editor.settle_on_grid(ids)?;
            }
            match sticking {
                Some(Sticking::Land) => editor.land(ids)?,
                Some(Sticking::Free) => editor.unstick(ids)?,
                None => Vec::new(),
            };
            Ok(())
        })
    }

    /// Packs the images among the elements into rows, each keeping its size and turn. The other
    /// elements stay, but for what sticks to the images, which follows them.
    pub fn arrange(&mut self, ids: &[ElementId], order: &Order) -> Result<Vec<ElementId>> {
        for id in ids {
            self.get(*id)?;
        }
        let moved = arrangement(&self.board, ids, order)
            .into_iter()
            .map(|(id, by)| {
                let mut kind = self.board.elements[&id].kind.clone();
                shift(&mut kind, by.x, by.y);
                (id, kind)
            })
            .collect();
        self.replace(moved)
    }

    /// Scales the images among the elements around their own centres, so that each covers as
    /// much of `side` as they do on average. The other elements stay, but for what sticks to the
    /// images, which follows them.
    pub fn normalize(&mut self, ids: &[ElementId], side: Side) -> Result<Vec<ElementId>> {
        for id in ids {
            self.get(*id)?;
        }
        self.replace(normalization(&self.board, ids, side))
    }

    /// Lines the elements among `ids` up on a side or the middle of their extent, each whole with
    /// what its groups hold, and sets them down where they land. One stuck to what another of them
    /// moves follows it instead.
    pub fn align(&mut self, ids: &[ElementId], to: Alignment) -> Result<Vec<ElementId>> {
        let movers = self.movers(ids)?;
        self.move_each(alignment(&self.board, &movers, to))
    }

    /// As [`Editor::align`] does, with the gaps between three or more elements made alike.
    pub fn distribute(&mut self, ids: &[ElementId], axis: Axis) -> Result<Vec<ElementId>> {
        let movers = self.movers(ids)?;
        self.move_each(distribution(&self.board, &movers, axis))
    }

    /// Shows only `area` of the image, in its pixels as displayed.
    pub fn crop(&mut self, id: ElementId, area: Rect) -> Result<Vec<ElementId>> {
        let kind = &self.get(id)?.kind;
        let ElementKind::Image { natural_size, .. } = kind else {
            return Err(Error::NotAnImage(id));
        };
        let cropped = cropped(kind, Some(area)).ok_or(Error::OutsideImage {
            id,
            width: natural_size.width,
            height: natural_size.height,
        })?;
        self.replace(vec![(id, cropped)])
    }

    /// Shows the whole of each image among the elements, with those of the groups among them,
    /// as a rectangle.
    pub fn reset_crop(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| {
            if let Some(whole) = cropped(kind, None) {
                *kind = whole;
            }
            if let ElementKind::Image { edits, .. } = kind {
                edits.crop_shape = CropShape::Rectangle;
            }
        })
    }

    /// Shows each image among the elements, with those of the groups among them, as `shape`
    /// within its crop.
    pub fn set_crop_shape(
        &mut self,
        ids: &[ElementId],
        shape: CropShape,
    ) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| {
            if let ElementKind::Image { edits, .. } = kind {
                edits.crop_shape = shape;
            }
        })
    }

    /// Plays `trim` of each image among the elements, with those of the groups among them, the
    /// whole of it when `None`, and as much of every other image of their assets, as an asset
    /// plays one way wherever it shows.
    pub fn set_trim(&mut self, ids: &[ElementId], trim: Option<Trim>) -> Result<Vec<ElementId>> {
        let alike = self.same_assets(ids)?;
        self.reshape(&alike, |kind| {
            if let ElementKind::Image { edits, .. } = kind {
                edits.trim = trim;
            }
        })
    }

    /// As [`Editor::set_trim`] does, for how fast they play.
    pub fn set_speed(&mut self, ids: &[ElementId], speed: Speed) -> Result<Vec<ElementId>> {
        let alike = self.same_assets(ids)?;
        self.reshape(&alike, |kind| {
            if let ElementKind::Image { edits, .. } = kind {
                edits.speed = speed;
            }
        })
    }

    /// Greys each image among the elements, with those of the groups among them, or not.
    pub fn set_greyscale(&mut self, ids: &[ElementId], greyscale: bool) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| {
            if let ElementKind::Image { edits, .. } = kind {
                edits.greyscale = greyscale;
            }
        })
    }

    /// Turns each element, with those of the groups among them, upright around its own centre.
    /// What sticks to them follows, and among them then turns upright in its turn, so that each
    /// keeps to its pixel, but for a stroke, drawn as it lies on what it sticks to, which only
    /// follows when that ends up turned.
    pub fn straighten(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let mut pending = self.with_descendants(ids)?;
        // Turning one would turn all its elements at once, those it holds back included.
        pending.retain(|id| !matches!(self.board.elements[id].kind, ElementKind::Group));
        let straightened = pending.clone();
        let turns = |id: &ElementId| {
            held_by(&self.board, *id)
                .find(|target| straightened.contains(target))
                .is_some_and(|target| {
                    matches!(
                        &self.board.elements[&target].kind,
                        ElementKind::Image { rotation, .. }
                            | ElementKind::Note { rotation, .. }
                            | ElementKind::Sticky { rotation, .. }
                            | ElementKind::Shape { rotation, .. }
                            if *rotation != 0.0
                    )
                })
        };
        pending.retain(|id| {
            !matches!(self.board.elements[id].kind, ElementKind::Stroke { .. }) || !turns(id)
        });
        // Each element turns around its own centre, which following would take as a turn of all
        // alike, so what sticks to another turns after it, on a scratch editor.
        let mut turning = Editor::new(self.board.clone());
        let mut touched = BTreeSet::new();
        while !pending.is_empty() {
            let board = &turning.board;
            let carried =
                |id: &ElementId| held_by(board, *id).any(|target| pending.contains(&target));
            let (later, now): (BTreeSet<ElementId>, BTreeSet<ElementId>) =
                pending.iter().partition(|id| carried(id));
            pending = later;
            let now: Vec<ElementId> = now.into_iter().collect();
            touched.extend(turning.reshape(&now, |kind| {
                if let ElementKind::Image { rotation, .. }
                | ElementKind::Note { rotation, .. }
                | ElementKind::Sticky { rotation, .. }
                | ElementKind::Shape { rotation, .. }
                | ElementKind::Stroke { rotation, .. } = kind
                {
                    *rotation = 0.0;
                }
            })?);
        }
        let step = touched
            .into_iter()
            .map(|id| (id, self.change(id, |_| turning.board.elements.remove(&id))))
            .collect();
        self.record(step)
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
                | ElementKind::Shape { frame, .. }
                | ElementKind::Stroke { frame, .. } => {
                    let mut centre = frame.centre();
                    scaled(&mut centre);
                    frame.width *= factor;
                    frame.height *= factor;
                    frame.x = centre.x - frame.width / 2.0;
                    frame.y = centre.y - frame.height / 2.0;
                }
                ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
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
            }
            | ElementKind::Stroke {
                frame, rotation, ..
            } => {
                let centre = frame.centre().turned(pivot, degrees);
                frame.x = centre.x - frame.width / 2.0;
                frame.y = centre.y - frame.height / 2.0;
                *rotation = angle(*rotation + degrees);
            }
            ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
                *from = from.turned(pivot, degrees);
                *to = to.turned(pivot, degrees);
            }
            ElementKind::Comment { at, .. } => *at = at.turned(pivot, degrees),
            ElementKind::Group => {}
        })
    }

    /// Puts back on the grid's lines the coordinates that float arithmetic left a hair off them,
    /// so that they write as they read. With the elements of the groups among them.
    pub fn settle_on_grid(&mut self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        self.reshape(ids, |kind| match kind {
            ElementKind::Image { frame, .. }
            | ElementKind::Note { frame, .. }
            | ElementKind::Sticky { frame, .. }
            | ElementKind::Shape { frame, .. }
            | ElementKind::Stroke { frame, .. } => {
                for value in [
                    &mut frame.x,
                    &mut frame.y,
                    &mut frame.width,
                    &mut frame.height,
                ] {
                    *value = settled(*value);
                }
            }
            ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
                for point in [from, to] {
                    point.x = settled(point.x);
                    point.y = settled(point.y);
                }
            }
            ElementKind::Comment { at, .. } => {
                at.x = settled(at.x);
                at.y = settled(at.y);
            }
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
        let mut step = Changes::new();
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

    pub fn set_background(&mut self, background: Background) {
        let change = Change {
            before: self.board.background,
            after: background,
        };
        self.commit(Step {
            background: Some(change),
            ..Step::default()
        });
    }

    /// Edits between this and [`Editor::end_gesture`] undo as one, and cannot be undone halfway,
    /// whoever makes them, so that others must wait for its end. Gestures do not nest.
    pub fn begin_gesture(&mut self) {
        self.gesture.get_or_insert_default();
    }

    /// Takes the open gesture's edits back and keeps it open.
    pub fn rewind_gesture(&mut self) -> Vec<ElementId> {
        let Some(gesture) = &mut self.gesture else {
            return Vec::new();
        };
        mem::take(gesture).put(&mut self.board, false)
    }

    pub fn end_gesture(&mut self) {
        if let Some(mut gesture) = self.gesture.take() {
            gesture.prune();
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
        let touched = step.put(&mut self.board, false);
        self.redo.push(step);
        touched
    }

    pub fn redo(&mut self) -> Vec<ElementId> {
        let Some(step) = self.redo.pop_if(|_| self.gesture.is_none()) else {
            return Vec::new();
        };
        let touched = step.put(&mut self.board, true);
        self.undo.push(step);
        touched
    }

    pub fn can_undo(&self) -> bool {
        self.gesture.is_none() && !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        self.gesture.is_none() && !self.redo.is_empty()
    }

    /// The assets of the images its history holds, as they were before or after an edit, which
    /// undo, redo, or rewinding the open gesture may bring back.
    pub fn history_assets(&self) -> BTreeSet<AssetId> {
        self.undo
            .iter()
            .chain(&self.redo)
            .chain(&self.gesture)
            .flat_map(|step| step.elements.values())
            .flat_map(|change| [&change.before, &change.after])
            .flatten()
            .filter_map(|element| element.kind.asset())
            .collect()
    }

    fn record(&mut self, elements: Changes) -> Result<Vec<ElementId>> {
        Ok(self.commit(Step {
            elements,
            background: None,
        }))
    }

    fn commit(&mut self, mut step: Step) -> Vec<ElementId> {
        step.prune();
        let touched = step.put(&mut self.board, true);
        match &mut self.gesture {
            Some(gesture) => gesture.merge(step),
            None if step.is_empty() => {}
            None => {
                self.undo.push(step);
                self.redo.clear();
            }
        }
        touched
    }

    /// The edits `edits` makes, as one step, or as part of the open gesture, all taken back when
    /// one of them is refused.
    fn composed(&mut self, edits: impl FnOnce(&mut Self) -> Result<()>) -> Result<Vec<ElementId>> {
        let outer = self.gesture.replace(Step::default());
        let done = edits(self);
        let mut step = mem::replace(&mut self.gesture, outer).expect("composing");
        if let Err(error) = done {
            step.put(&mut self.board, false);
            return Err(error);
        }
        step.prune();
        let touched = step.elements.keys().copied().collect();
        match &mut self.gesture {
            Some(gesture) => gesture.merge(step),
            None if step.is_empty() => {}
            None => {
                self.undo.push(step);
                self.redo.clear();
            }
        }
        Ok(touched)
    }

    /// Each element as `kinds` has it, in one step that what sticks to them follows.
    fn replace(&mut self, kinds: Vec<(ElementId, ElementKind)>) -> Result<Vec<ElementId>> {
        let mut step = Changes::new();
        for (id, kind) in kinds {
            check_valid(id, &kind)?;
            step.insert(
                id,
                self.change(id, |element| Some(Element { kind, ..element })),
            );
        }
        self.follow(&mut step);
        self.record(step)
    }

    /// The outermost of `ids`, but for those stuck to what another of them holds, which follow it,
    /// as a group does all of whose elements are.
    fn movers(&self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let chosen = self.with_descendants(ids)?;
        let outermost: Vec<ElementId> = chosen
            .iter()
            .copied()
            .filter(|id| {
                self.board.elements[id]
                    .group
                    .is_none_or(|group| !chosen.contains(&group))
            })
            .collect();
        let holders: BTreeMap<ElementId, ElementId> = outermost
            .iter()
            .flat_map(|unit| {
                let held = self.board.with_descendants(&[*unit]);
                held.into_iter().map(move |id| (id, *unit))
            })
            .collect();
        let rides = |unit: &ElementId| {
            self.board.with_descendants(&[*unit]).iter().all(|id| {
                let kind = &self.board.elements[id].kind;
                matches!(kind, ElementKind::Group)
                    || kind
                        .targets()
                        .any(|target| holders.get(&target).is_some_and(|holder| holder != unit))
            })
        };
        Ok(outermost.into_iter().filter(|unit| !rides(unit)).collect())
    }

    /// Each element by its own amount, with what its groups hold, set down where it lands, as one
    /// edit.
    fn move_each(&mut self, moves: Vec<(ElementId, Point)>) -> Result<Vec<ElementId>> {
        let still = |by: &Point| by.x == 0.0 && by.y == 0.0;
        if moves.iter().all(|(_, by)| still(by)) {
            return Ok(Vec::new());
        }
        let moving: Vec<ElementId> = moves
            .iter()
            .filter(|(_, by)| !still(by))
            .map(|(id, _)| *id)
            .collect();
        let by: BTreeMap<ElementId, Point> = moves
            .into_iter()
            .flat_map(|(unit, by)| {
                let held = self.board.with_descendants(&[unit]);
                held.into_iter().map(move |id| (id, by))
            })
            .collect();
        // What stays sets down again only where what it sticks to went from under it.
        let resting: Vec<(ElementId, ElementId, ElementKind)> = by
            .iter()
            .filter(|(_, by)| still(by))
            .filter_map(|(id, _)| {
                let target = self.board.elements[id].kind.target()?;
                Some((*id, target, self.board.elements.get(&target)?.kind.clone()))
            })
            .collect();
        let ids: Vec<ElementId> = by.keys().copied().collect();
        self.composed(|editor| {
            // What each unit holds goes with it, by nothing too, so that no other unit carries it.
            let held = by.keys().copied().collect();
            editor.reshape_each(
                &ids,
                |id, kind| shift(kind, by[&id].x, by[&id].y),
                |id, target| by.get(&id) == by.get(&target),
                &held,
            )?;
            let left = resting.into_iter().filter(|(_, target, was)| {
                let now = editor.board.elements.get(target);
                now.is_none_or(|element| element.kind != *was)
            });
            let landing: Vec<ElementId> =
                moving.into_iter().chain(left.map(|(id, ..)| id)).collect();
            editor.land(&landing)?;
            Ok(())
        })
    }

    fn same_assets(&self, ids: &[ElementId]) -> Result<Vec<ElementId>> {
        let assets: BTreeSet<&AssetId> = self
            .with_descendants(ids)?
            .into_iter()
            .filter_map(|id| match &self.board.elements[&id].kind {
                ElementKind::Image { asset, .. } => Some(asset),
                _ => None,
            })
            .collect();
        Ok(self
            .board
            .elements
            .iter()
            .filter(|(_, element)| {
                matches!(&element.kind, ElementKind::Image { asset, .. } if assets.contains(asset))
            })
            .map(|(id, _)| *id)
            .collect())
    }

    /// With the trim and speed every image of its asset shares.
    fn played_alike(&self, mut kind: ElementKind) -> ElementKind {
        if let ElementKind::Image { asset, edits, .. } = &mut kind
            && let Some(alike) = self.played(asset)
        {
            edits.trim = alike.trim;
            edits.speed = alike.speed;
        }
        kind
    }

    fn played(&self, asset: &AssetId) -> Option<ImageEdits> {
        let edits = |kind: &ElementKind| match kind {
            ElementKind::Image {
                asset: other,
                edits,
                ..
            } if other == asset => Some(*edits),
            _ => None,
        };
        // Most assets show once, which spares ordering the whole board for each image added.
        self.board
            .elements
            .values()
            .find_map(|element| edits(&element.kind))?;
        self.board
            .draw_order()
            .into_iter()
            .find_map(|id| edits(&self.board.elements[&id].kind))
    }

    fn reshape(
        &mut self,
        ids: &[ElementId],
        edit: impl Fn(&mut ElementKind),
    ) -> Result<Vec<ElementId>> {
        self.reshape_each(ids, |_, kind| edit(kind), |_, _| true, &BTreeSet::new())
    }

    /// As [`Editor::reshape`] does, with `alike` as [`Editor::free_ends_moved_off`] takes it, and
    /// `placed` kept where the edit leaves them, though it changes nothing of theirs.
    fn reshape_each(
        &mut self,
        ids: &[ElementId],
        edit: impl Fn(ElementId, &mut ElementKind),
        alike: impl Fn(ElementId, ElementId) -> bool,
        placed: &BTreeSet<ElementId>,
    ) -> Result<Vec<ElementId>> {
        let mut step = Changes::new();
        for id in self.with_descendants(ids)? {
            let change = self.change(id, |mut element| {
                edit(id, &mut element.kind);
                Some(element)
            });
            check_valid(id, &change.after.as_ref().expect("reshaped").kind)?;
            step.insert(id, change);
        }
        let mut reshaped = changed(&step);
        reshaped.extend(placed);
        let moved = motions(&step).collect();
        self.carry(&mut step, moved, &reshaped);
        self.free_ends_moved_off(&mut step, &reshaped, alike);
        self.record(step)
    }

    /// Leaves out what the step changes itself, which moved alike, and follows what sticks to
    /// those that follow, and so on.
    fn follow(&self, step: &mut Changes) {
        let unmoved = changed(step);
        self.carry(step, motions(step).collect(), &unmoved);
    }

    /// As `follow` does, with what the step changes moving as `moved` has it, and `unmoved` left
    /// as the step has it.
    fn carry(
        &self,
        step: &mut Changes,
        mut moved: BTreeMap<ElementId, Motion>,
        unmoved: &BTreeSet<ElementId>,
    ) {
        let mut seen: BTreeSet<ElementId> = moved.keys().copied().collect();
        while !moved.is_empty() {
            let mut next = BTreeMap::new();
            for (id, element) in &self.board.elements {
                if unmoved.contains(id) {
                    continue;
                }
                let current = step
                    .get(id)
                    .and_then(|change| change.after.as_ref())
                    .unwrap_or(element);
                let Some(kind) = carried(&current.kind, &moved) else {
                    continue;
                };
                if let Some(motion) = Motion::of(&element.kind, &kind)
                    && seen.insert(*id)
                {
                    next.insert(*id, motion);
                }
                step.insert(
                    *id,
                    self.change(*id, |element| Some(Element { kind, ..element })),
                );
            }
            moved = next;
        }
    }

    /// `alike` tells whether an element and the target of one of its ends moved by the same
    /// amount, which keeps the end on it.
    fn free_ends_moved_off(
        &self,
        step: &mut Changes,
        reshaped: &BTreeSet<ElementId>,
        alike: impl Fn(ElementId, ElementId) -> bool,
    ) {
        let moved: BTreeSet<ElementId> = motions(step).map(|(id, _)| id).collect();
        let freed: Vec<(ElementId, usize)> = step
            .iter()
            .filter(|(id, _)| reshaped.contains(id))
            .flat_map(|(id, change)| {
                let ends = change.after.as_ref().and_then(|after| after.kind.ends());
                ends.into_iter()
                    .flatten()
                    .enumerate()
                    .filter_map(|(at, (point, target))| {
                        let target = target?;
                        let lies = step
                            .get(&target)
                            .and_then(|change| change.after.as_ref())
                            .or_else(|| self.board.elements.get(&target));
                        let stays = (moved.contains(&target) && alike(*id, target))
                            || lies.is_some_and(|element| lands_on(&element.kind, point));
                        (!stays).then_some((*id, at))
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        for (id, at) in freed {
            let ends = step
                .get_mut(&id)
                .and_then(|change| change.after.as_mut())
                .and_then(|after| after.kind.ends_mut());
            if let Some(ends) = ends {
                *ends[at].1 = None;
            }
        }
    }

    fn stick_whole(
        &mut self,
        targets: Vec<(ElementId, Option<ElementId>)>,
    ) -> Result<Vec<ElementId>> {
        let step = targets
            .into_iter()
            .map(|(id, target)| {
                let change = self.change(id, |mut element| {
                    if let Some(stuck) = element.kind.target_mut() {
                        *stuck = target;
                    }
                    Some(element)
                });
                (id, change)
            })
            .collect();
        self.record(step)
    }

    fn check_targets(&self, id: ElementId, kind: &ElementKind) -> Result<()> {
        for target in kind.targets() {
            if !self.get(target)?.kind.is_target() {
                return Err(Error::NotATarget(target));
            }
        }
        if let Some(target) = kind.target()
            && self.board.stuck_to(id).contains(&target)
        {
            return Err(Error::StuckToItself(id));
        }
        Ok(())
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
    fn change(
        &self,
        id: ElementId,
        edit: impl FnOnce(Element) -> Option<Element>,
    ) -> Change<Option<Element>> {
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

    fn rekey(&self, keys: Vec<(ElementId, ZIndex)>) -> Changes {
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

impl Step {
    fn is_empty(&self) -> bool {
        self.elements.is_empty() && self.background.is_none()
    }

    fn prune(&mut self) {
        self.elements
            .retain(|_, change| change.before != change.after);
        self.background
            .take_if(|change| change.before == change.after);
    }

    /// With a later step of the same gesture, which starts where this one ends.
    fn merge(&mut self, later: Step) {
        for (id, change) in later.elements {
            self.elements
                .entry(id)
                .and_modify(|merged| merged.after.clone_from(&change.after))
                .or_insert(change);
        }
        if let Some(change) = later.background {
            self.background.get_or_insert(change).after = change.after;
        }
    }

    /// Puts the board as the step leaves it, or as it found it, and returns the elements it
    /// touched.
    fn put(&self, board: &mut Board, forward: bool) -> Vec<ElementId> {
        for (id, change) in &self.elements {
            let (from, to) = if forward {
                (&change.before, &change.after)
            } else {
                (&change.after, &change.before)
            };
            debug_assert_eq!(board.elements.get(id), from.as_ref());
            set(board, *id, to.clone());
        }
        if let Some(Change { before, after }) = self.background {
            let (from, to) = if forward {
                (before, after)
            } else {
                (after, before)
            };
            debug_assert_eq!(board.background, from);
            board.background = to;
        }
        self.elements.keys().copied().collect()
    }
}

fn changed(step: &Changes) -> BTreeSet<ElementId> {
    step.iter()
        .filter(|(_, change)| change.before != change.after)
        .map(|(id, _)| *id)
        .collect()
}

fn motions(step: &Changes) -> impl Iterator<Item = (ElementId, Motion)> + '_ {
    step.iter().filter_map(|(id, change)| {
        let (before, after) = (change.before.as_ref()?, change.after.as_ref()?);
        Some((*id, Motion::of(&before.kind, &after.kind)?))
    })
}

/// `None` when nothing of it sticks to the moved elements. What cannot follow comes free, as it
/// would no longer be on what it sticks to.
fn carried(kind: &ElementKind, moved: &BTreeMap<ElementId, Motion>) -> Option<ElementKind> {
    if !kind.targets().any(|target| moved.contains_key(&target)) {
        return None;
    }
    let mut kind = kind.clone();
    for (point, target) in kind.ends_mut().into_iter().flatten() {
        if let Some(motion) = target.and_then(|target| moved.get(&target)) {
            match motion.point(*point) {
                Some(followed) => *point = followed,
                None => *target = None,
            }
        }
    }
    if let Some(motion) = kind.target().and_then(|target| moved.get(&target)) {
        match motion.element(&kind) {
            Some(followed) => kind = followed,
            None => {
                if let Some(target) = kind.target_mut() {
                    *target = None;
                }
            }
        }
    }
    Some(kind)
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

fn shift(kind: &mut ElementKind, dx: f64, dy: f64) {
    match kind {
        ElementKind::Image { frame, .. }
        | ElementKind::Note { frame, .. }
        | ElementKind::Sticky { frame, .. }
        | ElementKind::Shape { frame, .. }
        | ElementKind::Stroke { frame, .. } => {
            frame.x += dx;
            frame.y += dy;
        }
        ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
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
    }
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

/// What the element sticks to whole, then what that sticks to, and so on.
fn held_by(board: &Board, id: ElementId) -> impl Iterator<Item = ElementId> + '_ {
    iter::successors(board.elements[&id].kind.target(), |target| {
        board.elements.get(target)?.kind.target()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stick::Surface;
    use crate::tests::{arrow, board, element, id, stroke};
    use crate::{Colour, Dash, Fill, Heads, Rect, Text, Tip, Weight};

    fn note(x: f64) -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
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

    fn renamed(copied: &Copied, first: u128) -> BTreeMap<ElementId, ElementId> {
        copied
            .elements
            .keys()
            .copied()
            .zip(ids_from(first))
            .collect()
    }

    fn ids_from(first: u128) -> impl Iterator<Item = ElementId> {
        (first..).map(id)
    }

    #[test]
    fn a_paste_stacks_new_elements_on_top_of_its_group_linked_as_their_copies_were() {
        let mut editor = editor();
        editor
            .update(id(5), stuck((0.0, 0.0), Some(2), (20.0, 0.0), Some(4)))
            .unwrap();
        let before = editor.board().clone();
        let copied = editor.board().copy(&ids([5, 1]));
        let touched = editor.paste(&copied, &renamed(&copied, 10), None).unwrap();
        assert_eq!(touched, ids([10, 11, 12, 13]));
        assert_eq!(order(&editor), ids([1, 2, 3, 4, 5, 10, 11, 12, 13]));
        let pasted = |bits| &editor.board().elements[&id(bits)];
        assert_eq!(
            [10, 11, 12, 13].map(|bits| pasted(bits).group),
            [None, Some(id(10)), Some(id(10)), None]
        );
        assert_eq!(
            pasted(13).kind,
            stuck((0.0, 0.0), Some(11), (20.0, 0.0), None)
        );
        assert_sound(&editor);
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_paste_stacks_elements_that_shared_a_key_as_they_were_whatever_their_new_ids() {
        let mut tied = editor().board().clone();
        tied.elements.get_mut(&id(3)).unwrap().z = tied.elements[&id(2)].z.clone();
        let mut editor = Editor::new(tied);
        let copied = editor.board().copy(&ids([1]));
        let renamed = [(1, 10), (2, 12), (3, 11)].map(|(old, new)| (id(old), id(new)));
        editor
            .paste(&copied, &BTreeMap::from(renamed), None)
            .unwrap();
        assert_eq!(order(&editor)[5..], ids([10, 12, 11]));
    }

    #[test]
    fn a_paste_into_a_group_lands_on_top_of_its_elements() {
        let mut editor = editor();
        let mut kind = note(20.0);
        *kind.target_mut().unwrap() = Some(id(2));
        editor.update(id(4), kind).unwrap();
        let copied = editor.board().copy(&ids([4]));
        editor
            .paste(&copied, &renamed(&copied, 6), Some(id(1)))
            .unwrap();
        assert_eq!(order(&editor), ids([1, 2, 3, 6, 4, 5]));
        assert_eq!(editor.board().elements[&id(6)].group, Some(id(1)));
        assert_eq!(editor.board().elements[&id(6)].kind.target(), None);
    }

    #[test]
    fn a_paste_mends_what_a_copy_made_elsewhere_breaks() {
        let mut editor = editor();
        let arrow = stuck((0.0, 0.0), Some(3), (0.0, 0.0), Some(1));
        let mut circular = note(0.0);
        *circular.target_mut().unwrap() = Some(id(6));
        let mut back = note(0.0);
        *back.target_mut().unwrap() = Some(id(5));
        let copied = Copied {
            elements: board([
                (1, element(Some(2), "a0", ElementKind::Group)),
                (2, element(Some(1), "a0", ElementKind::Group)),
                (3, element(Some(9), "a1", note(0.0))),
                (4, element(None, "a2", arrow)),
                (5, element(None, "a3", circular)),
                (6, element(None, "a4", back)),
            ])
            .elements,
        };
        editor.paste(&copied, &renamed(&copied, 11), None).unwrap();
        assert_sound(&editor);
        let pasted = |bits| &editor.board().elements[&id(bits)];
        assert_eq!(pasted(13).group, None);
        assert_eq!(
            pasted(14).kind.ends().unwrap().map(|(_, target)| target),
            [Some(id(13)), None]
        );
        assert_eq!(
            [15, 16].map(|bits| pasted(bits).kind.target()),
            [None, Some(id(15))]
        );
    }

    #[test]
    fn a_refused_paste_changes_nothing() {
        let mut editor = editor();
        let copied = editor.board().copy(&ids([1, 4]));
        let before = editor.board().clone();
        let mut twice = renamed(&copied, 10);
        twice.insert(id(4), id(10));
        let mut broken = copied.clone();
        broken.elements.get_mut(&id(4)).unwrap().kind = note(f64::NAN);
        let refused = [
            editor.paste(&copied, &renamed(&copied, 4), None),
            editor.paste(&copied, &twice, None),
            editor.paste(
                &copied,
                &ids([1, 2, 3]).into_iter().zip(ids_from(10)).collect(),
                None,
            ),
            editor.paste(&broken, &renamed(&broken, 10), None),
            editor.paste(&copied, &renamed(&copied, 10), Some(id(4))),
        ];
        assert_eq!(
            refused.map(|result| result.unwrap_err()),
            [
                Error::TakenId(id(4)),
                Error::TakenId(id(10)),
                Error::Unnamed(id(4)),
                Error::Invalid(id(13)),
                Error::NotAGroup(id(4)),
            ]
        );
        assert_eq!(editor.board(), &before);
        assert!(!editor.can_undo());
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
            ..
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
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
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
    fn greying_sets_each_image_alike_whatever_it_was() {
        let image = |greyscale| ElementKind::Image {
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
            edits: crate::ImageEdits {
                greyscale,
                ..crate::ImageEdits::default()
            },
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image(true))),
            (2, element(None, "a1", image(false))),
        ]));

        assert_eq!(editor.set_greyscale(&ids([1, 2]), true), Ok(ids([2])));
        assert_eq!(editor.set_greyscale(&ids([1, 2]), true), Ok(Vec::new()));
        assert_eq!(editor.set_greyscale(&ids([1, 2]), false), Ok(ids([1, 2])));
    }

    fn played(bytes: &[u8], edits: crate::ImageEdits) -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(bytes),
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
            edits,
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn edits_of(editor: &Editor, element: u128) -> crate::ImageEdits {
        match &editor.board().elements[&id(element)].kind {
            ElementKind::Image { edits, .. } => *edits,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_asset_plays_one_way_wherever_it_shows() {
        let still = crate::ImageEdits::default();
        let mut editor = Editor::new(board([
            (1, element(None, "a0", played(b"moving", still))),
            (2, element(None, "a1", ElementKind::Group)),
            (3, element(Some(2), "a0", played(b"moving", still))),
            (4, element(None, "a2", played(b"other", still))),
        ]));
        let trim = Some(crate::Trim {
            start: 0.5,
            end: 2.0,
        });
        let fast = crate::Speed::new(2.0).unwrap();

        assert_eq!(editor.set_trim(&ids([1]), trim), Ok(ids([1, 3])));
        assert_eq!(editor.set_speed(&ids([2]), fast), Ok(ids([1, 3])));
        assert_eq!(edits_of(&editor, 3).trim, trim);
        assert_eq!(edits_of(&editor, 1).speed, fast);
        assert_eq!(edits_of(&editor, 4), still);
        editor.undo();
        assert_eq!(edits_of(&editor, 1).speed, crate::Speed::NORMAL);
        assert_eq!(edits_of(&editor, 3).trim, trim);
    }

    #[test]
    fn an_image_added_or_pasted_plays_as_the_others_of_its_asset() {
        let trim = Some(crate::Trim {
            start: 0.5,
            end: 2.0,
        });
        let speed = crate::Speed::new(0.5).unwrap();
        let playing = crate::ImageEdits {
            trim,
            speed,
            ..crate::ImageEdits::default()
        };
        let mut editor = Editor::new(board([(
            1,
            element(None, "a0", played(b"moving", playing)),
        )]));

        let mut added = crate::ImageEdits {
            greyscale: true,
            ..crate::ImageEdits::default()
        };
        editor.add(id(2), None, played(b"moving", added)).unwrap();
        editor.add(id(3), None, played(b"other", added)).unwrap();
        assert_eq!(
            edits_of(&editor, 2),
            crate::ImageEdits {
                greyscale: true,
                ..playing
            }
        );
        assert_eq!(edits_of(&editor, 3), added);

        added.speed = crate::Speed::new(4.0).unwrap();
        let copied = Copied {
            elements: BTreeMap::from([(id(9), element(None, "a0", played(b"moving", added)))]),
        };
        editor.paste(&copied, &renamed(&copied, 4), None).unwrap();
        assert_eq!(edits_of(&editor, 4).speed, speed);
        assert_eq!(edits_of(&editor, 4).trim, trim);
    }

    #[test]
    fn straightening_turns_each_element_upright_in_its_place_and_leaves_ends_alone() {
        let turned = |mut kind: ElementKind| {
            if let ElementKind::Note { rotation, .. } = &mut kind {
                *rotation = 30.0;
            }
            kind
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", turned(note(0.0)))),
            (3, element(None, "a1", turned(note(20.0)))),
            (4, element(None, "a2", arrow())),
        ]));

        assert_eq!(editor.straighten(&ids([1, 3, 4])), Ok(ids([2, 3])));
        assert_eq!(editor.board().elements[&id(2)].kind, note(0.0));
        assert_eq!(editor.board().elements[&id(3)].kind, note(20.0));
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
        let ElementKind::Arrow { from, to, .. } = &elements[&id(5)].kind else {
            unreachable!()
        };
        assert_eq!((from.x, from.y, to.x, to.y), (5.0, -5.0, 5.0, -5.0));
        assert_eq!(editor.undo(), ids([2, 3, 5]));
    }

    #[test]
    fn moving_nested_groups_and_a_member_among_them_moves_each_element_once() {
        let mut editor = editor();
        editor.group(id(6), &[id(1), id(4)]).unwrap();
        let x = |editor: &Editor, bits| match &editor.board().elements[&id(bits)].kind {
            ElementKind::Note { frame, .. } => frame.x,
            _ => unreachable!(),
        };
        // The outer group, one of the elements it holds further down, and another on its own.
        assert_eq!(
            editor.translate(&ids([6, 2, 5]), 5.0, 0.0).unwrap(),
            ids([2, 3, 4, 5])
        );
        assert_eq!([2, 3, 4].map(|bits| x(&editor, bits)), [5.0, 15.0, 25.0]);
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
    fn the_history_holds_the_assets_that_undo_and_redo_may_bring_back() {
        let image = |bytes: &[u8]| {
            let mut kind = picture(0.0, 0.0);
            if let ElementKind::Image { asset, .. } = &mut kind {
                *asset = AssetId::of(bytes);
            }
            kind
        };
        let [shown, added] = [b"shown", b"added"].map(|bytes| AssetId::of(bytes));
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image(b"shown"))),
            (2, element(None, "a1", note(0.0))),
        ]));
        assert!(editor.history_assets().is_empty());

        editor.remove(&ids([1])).unwrap();
        assert_eq!(editor.history_assets(), BTreeSet::from([shown]));

        editor.begin_gesture();
        editor.add(id(3), None, image(b"added")).unwrap();
        assert_eq!(editor.history_assets(), BTreeSet::from([shown, added]));
        editor.end_gesture();
        editor.undo();
        assert_eq!(editor.history_assets(), BTreeSet::from([shown, added]));

        editor.translate(&ids([2]), 1.0, 0.0).unwrap();
        assert_eq!(editor.history_assets(), BTreeSet::from([shown]));
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
    fn removals_in_one_gesture_undo_as_one_or_rewind_to_nothing() {
        let mut editor = editor();
        editor
            .update(id(5), stuck((5.0, 5.0), Some(3), (25.0, 5.0), Some(4)))
            .unwrap();
        let before = editor.board().clone();
        let remove_one_by_one = |editor: &mut Editor| {
            editor.begin_gesture();
            for element in [2, 3, 4] {
                editor.remove(&[id(element)]).unwrap();
            }
        };

        remove_one_by_one(&mut editor);
        editor.end_gesture();
        assert_eq!(order(&editor), ids([5]));
        assert_sound(&editor);
        assert_eq!(editor.undo(), ids([1, 2, 3, 4, 5]));
        assert_eq!(editor.board(), &before);

        remove_one_by_one(&mut editor);
        assert_eq!(editor.rewind_gesture(), ids([1, 2, 3, 4, 5]));
        editor.end_gesture();
        assert_eq!(editor.board(), &before);
        assert_eq!(editor.redo(), ids([1, 2, 3, 4, 5]));
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
    fn the_background_undoes_like_any_edit() {
        let mut editor = editor();
        editor.set_background(Background::Grid);
        assert_eq!(editor.board().background, Background::Grid);
        assert!(!editor.is_saved());
        assert!(editor.undo().is_empty());
        assert_eq!(editor.board().background, Background::Plain);
        assert!(editor.is_saved());
        assert!(editor.redo().is_empty());
        assert_eq!(editor.board().background, Background::Grid);
        assert!(editor.can_undo());

        // To the one it has already, it records nothing.
        editor.undo();
        editor.set_background(Background::Plain);
        assert!(editor.can_redo());
    }

    #[test]
    fn a_gesture_undoes_the_background_with_the_elements() {
        let mut editor = editor();
        let start = editor.board().clone();
        editor.begin_gesture();
        editor.set_background(Background::Grid);
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        editor.set_background(Background::Dots);
        assert_eq!(editor.rewind_gesture(), ids([4]));
        assert_eq!(editor.board(), &start);
        editor.set_background(Background::Dots);
        editor.translate(&[id(4)], 1.0, 0.0).unwrap();
        editor.end_gesture();
        assert_eq!(editor.undo(), ids([4]));
        assert_eq!(editor.board(), &start);

        // Back to where it began, it records nothing.
        editor.begin_gesture();
        editor.set_background(Background::Grid);
        editor.set_background(Background::Plain);
        editor.end_gesture();
        assert_eq!(editor.redo(), ids([4]));
    }

    #[test]
    fn what_moved_or_scaled_onto_the_grid_settles_exactly_on_it() {
        let frame = |editor: &Editor| match editor.board().elements[&id(1)].kind {
            ElementKind::Note { frame, .. } => frame,
            _ => unreachable!(),
        };
        let at = |x, width| {
            let mut kind = note(x);
            if let ElementKind::Note { frame, .. } = &mut kind {
                (frame.y, frame.width) = (17.3, width);
            }
            Editor::new(board([(1, element(None, "a0", kind))]))
        };
        // Moved onto the line at 900, it lands a hair short of it.
        let x = -242.154_545_454_545_43;
        let mut editor = at(x, 10.0);
        editor.translate(&ids([1]), 900.0 - x, 0.0).unwrap();
        assert_ne!(frame(&editor).x, 900.0);
        assert_eq!(editor.settle_on_grid(&ids([1])).unwrap(), ids([1]));
        assert_eq!((frame(&editor).x, frame(&editor).y), (900.0, 17.3));

        // Its right edge scaled from 60 onto the line at 180, it is a hair too wide.
        let mut editor = at(-40.0, 100.0);
        editor
            .scale(&ids([1]), Point { x: -40.0, y: 0.0 }, 2.2)
            .unwrap();
        assert_ne!(frame(&editor).width, 220.0);
        editor.settle_on_grid(&ids([1])).unwrap();
        assert_eq!((frame(&editor).x, frame(&editor).width), (-40.0, 220.0));

        assert!(editor.settle_on_grid(&ids([1])).unwrap().is_empty());
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
            ElementKind::Arrow { from, to, .. } | ElementKind::Line { from, to, .. } => {
                [from.x, from.y, to.x, to.y]
            }
            _ => unreachable!(),
        };
        for kind in [
            ElementKind::Arrow {
                from,
                to,
                from_target: None,
                to_target: None,
                colour: Colour::Ink,
                weight: Weight::Medium,
                dash: Dash::Solid,
                heads: Heads::End,
                opacity: Default::default(),
            },
            ElementKind::Line {
                from,
                to,
                from_target: None,
                to_target: None,
                colour: Colour::Ink,
                weight: Weight::Medium,
                dash: Dash::Solid,
                opacity: Default::default(),
            },
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
            target: None,
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
            text: Text::new("a".to_owned(), font_size),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
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

    fn stuck(from: (f64, f64), on: Option<u128>, to: (f64, f64), at: Option<u128>) -> ElementKind {
        ElementKind::Arrow {
            from: Point {
                x: from.0,
                y: from.1,
            },
            to: Point { x: to.0, y: to.1 },
            from_target: on.map(id),
            to_target: at.map(id),
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            heads: Heads::End,
            opacity: Default::default(),
        }
    }

    fn framed(x: f64, y: f64, width: f64, height: f64) -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x,
                y,
                width,
                height,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        }
    }

    fn ends(editor: &Editor, bits: u128) -> [(Point, Option<ElementId>); 2] {
        editor.board().elements[&id(bits)].kind.ends().unwrap()
    }

    fn assert_at(point: Point, x: f64, y: f64) {
        assert!(
            (point.x - x).abs() < 1e-9 && (point.y - y).abs() < 1e-9,
            "{point:?} is not ({x}, {y})"
        );
    }

    #[test]
    fn an_end_follows_what_it_sticks_to() {
        // `to` on the middle of the note's right side.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 50.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    stuck((200.0, 200.0), None, (100.0, 25.0), Some(1)),
                ),
            ),
        ]));
        let before = editor.board().clone();

        assert_eq!(editor.translate(&ids([1]), 10.0, 5.0).unwrap(), ids([1, 2]));
        let [(from, _), (to, target)] = ends(&editor, 2);
        assert_at(from, 200.0, 200.0);
        assert_at(to, 110.0, 30.0);
        assert_eq!(target, Some(id(1)));

        editor
            .scale(&ids([1]), Point { x: 10.0, y: 5.0 }, 2.0)
            .unwrap();
        assert_at(ends(&editor, 2)[1].0, 210.0, 55.0);
        // Around the note's centre, (110, 55), the right side's middle turns to the bottom.
        editor
            .rotate(&ids([1]), Point { x: 110.0, y: 55.0 }, 90.0)
            .unwrap();
        assert_at(ends(&editor, 2)[1].0, 110.0, 155.0);
        assert_sound(&editor);

        for _ in 0..3 {
            assert_eq!(editor.undo(), ids([1, 2]));
        }
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn an_end_stuck_to_an_image_keeps_to_the_same_pixel() {
        let image = |frame: Rect, crop: Option<Rect>, flipped: bool| ElementKind::Image {
            asset: crate::AssetId::of(b""),
            natural_size: crate::Size {
                width: 100,
                height: 100,
            },
            frame,
            rotation: 0.0,
            edits: crate::ImageEdits {
                crop,
                flip_horizontal: flipped,
                ..crate::ImageEdits::default()
            },
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        };
        let rect = |width, height| Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        };
        // Twice the picture's size, so that `to` shows its pixel (20, 30).
        let mut editor = Editor::new(board([
            (
                1,
                element(None, "a0", image(rect(200.0, 200.0), None, false)),
            ),
            (
                2,
                element(None, "a1", stuck((300.0, 0.0), None, (40.0, 60.0), Some(1))),
            ),
        ]));

        editor.flip(&ids([1]), true).unwrap();
        assert_at(ends(&editor, 2)[1].0, 160.0, 60.0);
        // Cropped to the picture's left half, flipped within it, at the same scale.
        editor
            .update(
                id(1),
                image(rect(100.0, 200.0), Some(rect(50.0, 100.0)), true),
            )
            .unwrap();
        assert_at(ends(&editor, 2)[1].0, 60.0, 60.0);
        editor
            .rotate(&ids([1]), Point { x: 50.0, y: 100.0 }, 90.0)
            .unwrap();
        assert_at(ends(&editor, 2)[1].0, 90.0, 110.0);
        assert_at(ends(&editor, 2)[0].0, 300.0, 0.0);
    }

    #[test]
    fn an_arrow_moved_with_what_it_sticks_to_moves_once() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 50.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    stuck((200.0, 200.0), None, (100.0, 25.0), Some(1)),
                ),
            ),
        ]));
        editor.translate(&ids([1, 2]), 10.0, 5.0).unwrap();
        let [(from, _), (to, target)] = ends(&editor, 2);
        assert_at(from, 210.0, 205.0);
        assert_at(to, 110.0, 30.0);
        assert_eq!(target, Some(id(1)));
    }

    #[test]
    fn an_arrow_flipped_with_the_image_it_sticks_to_still_follows_it() {
        // Twice the picture's size, so that `to` shows its pixel (20, 30).
        let image = ElementKind::Image {
            asset: crate::AssetId::of(b""),
            natural_size: crate::Size {
                width: 100,
                height: 100,
            },
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 200.0,
            },
            rotation: 0.0,
            edits: crate::ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image)),
            (
                2,
                element(None, "a1", stuck((300.0, 0.0), None, (40.0, 60.0), Some(1))),
            ),
        ]));
        let before = editor.board().clone();

        // Flipping leaves the arrow as it was, so it did not move alike.
        assert_eq!(editor.flip(&ids([1, 2]), true).unwrap(), ids([1, 2]));
        let [(from, _), (to, target)] = ends(&editor, 2);
        assert_at(from, 300.0, 0.0);
        assert_at(to, 160.0, 60.0);
        assert_eq!(target, Some(id(1)));
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn an_end_follows_what_a_drag_moves_then_settles_on_the_grid() {
        // Moved onto the line at 900, the note lands a hair short of it. `to` on the middle of
        // its left side.
        let x = -242.154_545_454_545_43;
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(x, 0.0, 100.0, 50.0))),
            (
                2,
                element(None, "a1", stuck((0.0, 300.0), None, (x, 25.0), Some(1))),
            ),
        ]));
        let before = editor.board().clone();

        // As each move of a drag does, from where the gesture began.
        editor.begin_gesture();
        let mut settled = Vec::new();
        for dx in [100.0, 900.0 - x] {
            editor.rewind_gesture();
            assert_eq!(editor.translate(&ids([1]), dx, 0.0).unwrap(), ids([1, 2]));
            settled = editor.settle_on_grid(&ids([1])).unwrap();
        }
        editor.end_gesture();
        assert_eq!(settled, ids([1, 2]));
        let ElementKind::Note { frame, .. } = editor.board().elements[&id(1)].kind else {
            unreachable!()
        };
        assert_eq!(frame.x, 900.0);
        let [(from, _), (to, target)] = ends(&editor, 2);
        assert_at(from, 0.0, 300.0);
        assert_eq!(to, Point { x: 900.0, y: 25.0 });
        assert_eq!(target, Some(id(1)));
        assert_sound(&editor);

        assert_eq!(editor.undo(), ids([1, 2]));
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn an_arrow_moved_alone_keeps_the_ends_that_still_land_on_what_they_stick_to() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 100.0))),
            (2, element(None, "a1", framed(300.0, 0.0, 100.0, 100.0))),
            // From within the first note to the second's left side.
            (
                3,
                element(
                    None,
                    "a2",
                    stuck((50.0, 50.0), Some(1), (300.0, 50.0), Some(2)),
                ),
            ),
        ]));
        let before = editor.board().clone();
        assert_eq!(editor.translate(&ids([3]), -10.0, 0.0).unwrap(), ids([3]));
        let [(from, from_target), (to, to_target)] = ends(&editor, 3);
        assert_at(from, 40.0, 50.0);
        assert_at(to, 290.0, 50.0);
        assert_eq!((from_target, to_target), (Some(id(1)), None));
        assert_sound(&editor);
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn an_end_follows_a_frame_that_text_grows_but_not_the_text_alone() {
        // `to` on the middle of the note's bottom side.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 50.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    stuck((200.0, 200.0), None, (50.0, 50.0), Some(1)),
                ),
            ),
        ]));
        let ElementKind::Note {
            frame, rotation, ..
        } = framed(0.0, 0.0, 100.0, 50.0)
        else {
            unreachable!()
        };
        let written = ElementKind::Note {
            frame,
            rotation,
            text: Text::new("Warm".to_owned(), 2.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        assert_eq!(editor.update(id(1), written).unwrap(), ids([1]));
        assert_eq!(
            editor.update(id(1), framed(0.0, 0.0, 100.0, 80.0)).unwrap(),
            ids([1, 2])
        );
        assert_at(ends(&editor, 2)[1].0, 50.0, 80.0);
    }

    #[test]
    fn an_end_follows_a_flat_frame_it_sticks_to() {
        // `to` on a note drawn flat, as a horizontal drag leaves it.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 100.0, 100.0, 0.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    stuck((200.0, 200.0), None, (30.0, 100.0), Some(1)),
                ),
            ),
        ]));
        let on = Point { x: 30.0, y: 100.0 };
        assert_eq!(
            editor.board().land_end(on, None, Some(3.0), None),
            crate::End {
                at: on,
                target: Some(id(1))
            }
        );

        assert_eq!(
            editor.translate(&ids([1]), 40.0, 40.0).unwrap(),
            ids([1, 2])
        );
        let [_, (to, target)] = ends(&editor, 2);
        assert_at(to, 70.0, 140.0);
        assert_eq!(target, Some(id(1)));
        // Around the note's centre, (90, 140), its line turns upright.
        editor
            .rotate(&ids([1]), Point { x: 90.0, y: 140.0 }, 90.0)
            .unwrap();
        assert_at(ends(&editor, 2)[1].0, 90.0, 120.0);
        editor
            .update(id(1), framed(40.0, 140.0, 100.0, 50.0))
            .unwrap();
        let [_, (to, target)] = ends(&editor, 2);
        assert_eq!(target, Some(id(1)));
        assert!(
            lands_on(&editor.board().elements[&id(1)].kind, to),
            "{to:?}"
        );
    }

    #[test]
    fn removing_what_an_end_sticks_to_frees_the_end_where_it_is() {
        let mut editor = editor();
        editor
            .update(id(5), stuck((5.0, 5.0), Some(3), (25.0, 5.0), Some(4)))
            .unwrap();
        let before = editor.board().clone();

        // With the note that stays, and within the group that goes.
        assert_eq!(editor.remove(&ids([1])).unwrap(), ids([1, 2, 3, 5]));
        let [(from, from_target), (_, to_target)] = ends(&editor, 5);
        assert_at(from, 5.0, 5.0);
        assert_eq!((from_target, to_target), (None, Some(id(4))));
        assert_sound(&editor);
        editor.undo();
        assert_eq!(editor.board(), &before);

        assert_eq!(editor.remove(&ids([4, 5])).unwrap(), ids([4, 5]));
    }

    #[test]
    fn an_end_sticks_only_to_an_element_that_takes_ends() {
        let mut editor = editor();
        let refused = [
            editor.add(id(6), None, stuck((0.0, 0.0), Some(9), (0.0, 0.0), None)),
            editor.add(id(6), None, stuck((0.0, 0.0), None, (0.0, 0.0), Some(1))),
            editor.update(id(5), stuck((0.0, 0.0), Some(5), (0.0, 0.0), None)),
        ];
        assert_eq!(
            refused.map(|result| result.unwrap_err()),
            [
                Error::UnknownElement(id(9)),
                Error::NotATarget(id(1)),
                Error::NotATarget(id(5)),
            ]
        );
        assert_eq!(
            editor.add(id(6), None, stuck((0.0, 0.0), Some(2), (0.0, 0.0), Some(4))),
            Ok(ids([6]))
        );
    }

    fn on(mut kind: ElementKind, bits: u128) -> ElementKind {
        *kind.target_mut().unwrap() = Some(id(bits));
        kind
    }

    fn picture(x: f64, y: f64) -> ElementKind {
        ElementKind::Image {
            asset: crate::AssetId::of(b""),
            natural_size: crate::Size {
                width: 100,
                height: 100,
            },
            frame: Rect {
                x,
                y,
                width: 200.0,
                height: 200.0,
            },
            rotation: 0.0,
            edits: crate::ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn turned(kind: ElementKind, degrees: f64) -> ElementKind {
        let ElementKind::Note {
            frame,
            text,
            target,
            ..
        } = kind
        else {
            unreachable!()
        };
        ElementKind::Note {
            frame,
            rotation: degrees,
            text,
            target,
            colour: Colour::Ink,
            opacity: Default::default(),
        }
    }

    fn placement(editor: &Editor, bits: u128) -> (Rect, f64, f64, Option<ElementId>) {
        let ElementKind::Note {
            frame,
            rotation,
            text,
            target,
            ..
        } = &editor.board().elements[&id(bits)].kind
        else {
            unreachable!()
        };
        (*frame, *rotation, text.font_size, *target)
    }

    fn assert_placed(
        editor: &Editor,
        bits: u128,
        target: u128,
        frame: [f64; 4],
        rotation: f64,
        font_size: f64,
    ) {
        let (at, turned, size, sticks_to) = placement(editor, bits);
        let placed = [at.x, at.y, at.width, at.height, turned, size];
        let expected = [frame[0], frame[1], frame[2], frame[3], rotation, font_size];
        assert!(
            placed
                .iter()
                .zip(expected)
                .all(|(a, b)| (a - b).abs() < 1e-9),
            "{placed:?} is not {expected:?}"
        );
        assert_eq!(sticks_to, Some(id(target)));
    }

    fn point(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    #[test]
    fn an_edit_writes_a_style_chosen_as_it_comes_as_nothing() {
        let aligned = |align| {
            let mut kind = framed(0.0, 0.0, 10.0, 10.0);
            if let ElementKind::Note { text, .. } = &mut kind {
                text.align = align;
            }
            kind
        };
        let left = aligned(Some(crate::Align::Left));
        let right = aligned(Some(crate::Align::Right));
        let before = board([(1, element(None, "a0", left.clone()))]);
        let mut editor = Editor::new(before.clone());
        // Written as it reads, until edited.
        assert_eq!(editor.board().elements[&id(1)].kind, left);
        editor.update(id(1), right.clone()).unwrap();
        assert_eq!(editor.board().elements[&id(1)].kind, right);
        editor.update(id(1), left.clone()).unwrap();
        assert_eq!(editor.board().elements[&id(1)].kind, aligned(None));
        editor.undo();
        editor.undo();
        assert_eq!(editor.board(), &before);
        editor.add(id(2), None, left.clone()).unwrap();
        assert_eq!(editor.board().elements[&id(2)].kind, aligned(None));
        editor.stretch(id(1), left).unwrap();
        assert_eq!(editor.board().elements[&id(1)].kind, aligned(None));
        // As it was, which records nothing.
        let mut editor = Editor::new(board([(1, element(None, "a0", aligned(None)))]));
        assert_eq!(
            editor.update(id(1), aligned(Some(crate::Align::Left))),
            Ok(Vec::new())
        );
        assert!(!editor.can_undo());
    }

    #[test]
    fn a_shape_turned_into_a_cross_fills_nothing() {
        let filled = ElementKind::Shape {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            rotation: 0.0,
            shape: crate::Shape::Rectangle,
            corners: Default::default(),
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            fill: Fill::Solid,
            opacity: Default::default(),
        };
        let mut editor = Editor::new(board([(1, element(None, "a0", filled.clone()))]));
        let mut cross = filled;
        if let ElementKind::Shape { shape, .. } = &mut cross {
            *shape = crate::Shape::Cross;
        }
        editor.update(id(1), cross).unwrap();
        let ElementKind::Shape { fill, .. } = editor.board().elements[&id(1)].kind else {
            unreachable!()
        };
        assert_eq!(fill, Fill::Hollow);
    }

    #[test]
    fn a_transform_makes_its_edits_one_after_another_and_undoes_as_one() {
        let before = board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 20.0, 10.0), 1)),
            ),
            (3, element(None, "a2", framed(300.0, 0.0, 10.0, 10.0))),
            (
                4,
                element(
                    None,
                    "a3",
                    stuck((0.0, 0.0), Some(1), (300.0, 5.0), Some(3)),
                ),
            ),
        ]);
        let ids = ids([1, 3]);
        let about = point(20.0, 0.0);
        let mut by_hand = Editor::new(before.clone());
        by_hand.scale(&ids, about, 0.5).unwrap();
        by_hand.rotate(&ids, about, 30.0).unwrap();
        by_hand.translate(&ids, 5.0, -5.0).unwrap();
        by_hand.settle_on_grid(&ids).unwrap();
        by_hand.land(&ids).unwrap();

        let mut editor = Editor::new(before.clone());
        let touched = editor
            .transform(
                &ids,
                &Transform {
                    scale: Some(Scaling::By(0.5)),
                    rotate: Some(30.0),
                    about: Some(about),
                    place: Some(Placement::By(point(5.0, -5.0))),
                    settle: true,
                    ..Transform::default()
                },
            )
            .unwrap();
        assert_eq!(editor.board(), by_hand.board());
        assert_eq!(touched, self::ids([1, 2, 3, 4]));
        assert_eq!(editor.undo(), self::ids([1, 2, 3, 4]));
        assert_eq!(editor.board(), &before);
        assert!(!editor.can_undo());
    }

    #[test]
    fn a_transform_measures_what_it_needs_from_the_extent_of_the_elements() {
        let comment = ElementKind::Comment {
            at: point(300.0, 100.0),
            text: "Here".to_owned(),
            target: None,
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (2, element(None, "a1", comment)),
        ]));
        // Half as wide, around the middle of the extent, then its top-left at (10, 20).
        editor
            .transform(
                &ids([1, 2]),
                &Transform {
                    scale: Some(Scaling::ToWidth(150.0)),
                    place: Some(Placement::To(point(10.0, 20.0))),
                    ..Transform::default()
                },
            )
            .unwrap();
        assert_eq!(
            editor.board().extent(&ids([1, 2])),
            Some(Rect {
                x: 10.0,
                y: 20.0,
                width: 150.0,
                height: 100.0
            })
        );
        assert_eq!(
            editor.board().bounds(&ids([1])),
            Some(Rect {
                x: 10.0,
                y: 20.0,
                width: 100.0,
                height: 100.0
            })
        );
    }

    #[test]
    fn a_transform_refuses_unknown_ids_before_measuring_them() {
        let mut editor = editor();
        let before = editor.board().clone();
        let turn = Transform {
            rotate: Some(90.0),
            ..Transform::default()
        };
        let wide = Transform {
            scale: Some(Scaling::ToWidth(10.0)),
            ..Transform::default()
        };
        let to = Transform {
            place: Some(Placement::To(point(0.0, 0.0))),
            ..Transform::default()
        };
        for transform in [&turn, &wide, &to, &Transform::default()] {
            assert_eq!(
                editor.transform(&ids([9]), transform),
                Err(Error::UnknownElement(id(9)))
            );
            assert_eq!(
                editor.transform(&ids([4, 9]), transform),
                Err(Error::UnknownElement(id(9)))
            );
        }
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_refused_transform_changes_nothing_even_within_a_gesture() {
        let mut editor = editor();
        editor.add(id(6), None, ElementKind::Group).unwrap();
        let before = editor.board().clone();
        editor.begin_gesture();
        editor.translate(&ids([4]), 1.0, 0.0).unwrap();
        let moved = editor.board().clone();
        let off = Transform {
            scale: Some(Scaling::By(2.0)),
            about: Some(point(0.0, 0.0)),
            place: Some(Placement::By(point(f64::INFINITY, 0.0))),
            ..Transform::default()
        };
        let turn = Transform {
            rotate: Some(90.0),
            ..Transform::default()
        };
        let flat = Transform {
            scale: Some(Scaling::ToWidth(0.0)),
            ..Transform::default()
        };
        assert_eq!(
            editor.transform(&ids([4]), &off),
            Err(Error::Invalid(id(4)))
        );
        assert_eq!(
            editor.transform(&ids([4, 9]), &turn),
            Err(Error::UnknownElement(id(9)))
        );
        assert_eq!(editor.transform(&ids([6]), &turn), Err(Error::NoRoom));
        assert_eq!(editor.transform(&ids([4]), &flat), Err(Error::NotAScale));
        assert_eq!(editor.board(), &moved);
        editor.end_gesture();
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_transform_sets_down_what_it_moves_unless_told_otherwise() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 20.0, 10.0), 1)),
            ),
            (3, element(None, "a2", framed(100.0, 100.0, 10.0, 10.0))),
        ]));
        let target = |editor: &Editor, bits| editor.board().elements[&id(bits)].kind.target();
        // A flip moves nothing, so sets nothing down.
        let flip = Transform {
            flip: Some(Axis::Horizontal),
            ..Transform::default()
        };
        editor.transform(&ids([1, 3]), &flip).unwrap();
        assert_eq!(target(&editor, 3), None);
        let nudge = Transform {
            place: Some(Placement::By(point(1.0, 1.0))),
            ..Transform::default()
        };
        editor.transform(&ids([3]), &nudge).unwrap();
        assert_eq!(target(&editor, 3), Some(id(1)));
        let freed = Transform {
            sticking: Some(Sticking::Free),
            ..nudge
        };
        editor.transform(&ids([2]), &freed).unwrap();
        assert_eq!(target(&editor, 2), None);
        let landed = Transform {
            sticking: Some(Sticking::Land),
            ..Transform::default()
        };
        assert_eq!(editor.transform(&ids([2]), &landed), Ok(ids([2])));
        assert_eq!(target(&editor, 2), Some(id(1)));
    }

    #[test]
    fn a_transform_that_changes_nothing_keeps_what_can_be_redone() {
        let mut editor = editor();
        editor.translate(&ids([4]), 1.0, 0.0).unwrap();
        editor.undo();
        let still = Transform {
            place: Some(Placement::By(point(0.0, 0.0))),
            ..Transform::default()
        };
        assert_eq!(editor.transform(&ids([4]), &still), Ok(Vec::new()));
        assert!(editor.can_redo());
    }

    #[test]
    fn a_note_stuck_whole_moves_scales_and_turns_with_what_it_sticks_to() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 20.0, 10.0), 1)),
            ),
        ]));
        let before = editor.board().clone();

        assert_eq!(editor.translate(&ids([1]), 10.0, 5.0).unwrap(), ids([1, 2]));
        // A move alone moves it exactly as much.
        assert_eq!(placement(&editor, 2).0.x, 50.0);
        assert_placed(&editor, 2, 1, [50.0, 45.0, 20.0, 10.0], 0.0, 2.0);
        editor
            .scale(&ids([1]), Point { x: 10.0, y: 5.0 }, 2.0)
            .unwrap();
        assert_placed(&editor, 2, 1, [90.0, 85.0, 40.0, 20.0], 0.0, 4.0);
        // Around the image's centre, (210, 205), its centre goes from (110, 95) to (320, 105).
        editor
            .rotate(&ids([1]), Point { x: 210.0, y: 205.0 }, 90.0)
            .unwrap();
        assert_placed(&editor, 2, 1, [300.0, 95.0, 40.0, 20.0], 90.0, 4.0);
        assert_sound(&editor);

        for _ in 0..3 {
            assert_eq!(editor.undo(), ids([1, 2]));
        }
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_note_stuck_to_a_flipped_image_mirrors_its_place_and_its_angle() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    on(turned(framed(40.0, 95.0, 20.0, 10.0), 30.0), 1),
                ),
            ),
        ]));
        editor.flip(&ids([1]), true).unwrap();
        assert_placed(&editor, 2, 1, [140.0, 95.0, 20.0, 10.0], 330.0, 2.0);
        editor.flip(&ids([1]), false).unwrap();
        assert_placed(&editor, 2, 1, [140.0, 95.0, 20.0, 10.0], 30.0, 2.0);
        editor.flip(&ids([1]), true).unwrap();
        editor.flip(&ids([1]), false).unwrap();
        assert_placed(&editor, 2, 1, [40.0, 95.0, 20.0, 10.0], 30.0, 2.0);
    }

    #[test]
    fn an_upright_note_stuck_to_an_image_stays_upright_through_every_flip() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 20.0, 20.0, 10.0), 1)),
            ),
        ]));
        editor.flip(&ids([1]), true).unwrap();
        assert_placed(&editor, 2, 1, [140.0, 20.0, 20.0, 10.0], 0.0, 2.0);
        editor.flip(&ids([1]), false).unwrap();
        assert_placed(&editor, 2, 1, [140.0, 170.0, 20.0, 10.0], 0.0, 2.0);
    }

    #[test]
    fn straightened_with_their_image_notes_keep_to_their_pixel_and_stand_upright() {
        let mut image = picture(0.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut image {
            *rotation = 30.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image)),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 20.0, 10.0), 1)),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    on(turned(framed(120.0, 120.0, 20.0, 10.0), 30.0), 1),
                ),
            ),
        ]));
        let pixel = |editor: &Editor, bits| {
            let centre = placement(editor, bits).0.centre();
            editor.board().pixel_at(id(1), centre).unwrap()
        };
        let pixels = [pixel(&editor, 2), pixel(&editor, 3)];

        editor.straighten(&ids([1, 2, 3])).unwrap();
        for (bits, before) in [2, 3].into_iter().zip(pixels) {
            assert_at(pixel(&editor, bits), before.x, before.y);
            assert_eq!(placement(&editor, bits).1, 0.0, "note {bits} is turned");
            assert_eq!(placement(&editor, bits).3, Some(id(1)));
        }
        assert_sound(&editor);
    }

    #[test]
    fn straightened_with_its_image_a_stroke_keeps_its_points_on_their_pixels() {
        let mut image = picture(0.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut image {
            *rotation = 30.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image)),
            (
                2,
                element(None, "a1", on(line((60.0, 80.0), (140.0, 120.0)), 1)),
            ),
        ]));
        let pixels = |editor: &Editor| {
            let ElementKind::Stroke {
                frame,
                rotation,
                points,
                ..
            } = &editor.board().elements[&id(2)].kind
            else {
                unreachable!()
            };
            crate::geometry::stroke_points(frame, *rotation, points)
                .into_iter()
                .map(|point| editor.board().pixel_at(id(1), point).unwrap())
                .collect::<Vec<_>>()
        };
        let before = pixels(&editor);

        editor.straighten(&ids([1, 2])).unwrap();
        for (after, before) in pixels(&editor).into_iter().zip(before) {
            assert_at(after, before.x, before.y);
        }
        assert_eq!(editor.board().elements[&id(2)].kind.target(), Some(id(1)));
        assert_sound(&editor);
    }

    #[test]
    fn a_stroke_straightens_upright_unless_what_it_sticks_to_turns_with_it() {
        let turned = |bits, x| {
            let mut stroke = on(line((x + 60.0, 80.0), (x + 140.0, 120.0)), bits);
            if let ElementKind::Stroke { rotation, .. } = &mut stroke {
                *rotation = 25.0;
            }
            stroke
        };
        let tilted = |x| {
            let mut image = picture(x, 0.0);
            if let ElementKind::Image { rotation, .. } = &mut image {
                *rotation = 30.0;
            }
            image
        };
        let upright = |x, bits| on(framed(x + 40.0, 40.0, 120.0, 120.0), bits);
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (2, element(None, "a1", turned(1, 0.0))),
            (3, element(None, "a2", turned(1, 0.0))),
            (4, element(None, "a3", tilted(300.0))),
            // Upright on the turned image, which it follows then stands back up.
            (5, element(None, "a4", upright(300.0, 4))),
            (6, element(None, "a5", turned(5, 300.0))),
            (7, element(None, "a6", tilted(600.0))),
            // Upright on the turned image, which it follows, left turned.
            (8, element(None, "a7", upright(600.0, 7))),
            (9, element(None, "a8", turned(8, 600.0))),
        ]));
        let rotation = |editor: &Editor, bits| {
            let ElementKind::Stroke { rotation, .. } = editor.board().elements[&id(bits)].kind
            else {
                unreachable!()
            };
            rotation
        };
        assert_eq!(editor.straighten(&ids([1, 2])).unwrap(), ids([2]));
        assert_eq!(editor.straighten(&ids([3])).unwrap(), ids([3]));
        editor.straighten(&ids([4, 5, 6])).unwrap();
        editor.straighten(&ids([7, 9])).unwrap();
        assert_eq!(
            [2, 3, 6, 9].map(|bits| rotation(&editor, bits)),
            [0.0, 0.0, 0.0, 355.0]
        );
        assert_sound(&editor);
    }

    #[test]
    fn a_stroke_stuck_to_a_note_scales_with_it() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 200.0, 100.0))),
            (
                2,
                element(None, "a1", on(line((40.0, 40.0), (60.0, 50.0)), 1)),
            ),
        ]));
        editor.scale(&ids([1]), point(0.0, 0.0), 2.0).unwrap();
        assert_stroke_placed(&editor, 2, 1, [80.0, 80.0, 40.0, 20.0], 0.0, AS_DRAWN);
    }

    #[test]
    fn straightened_down_a_chain_what_sticks_keeps_to_the_same_place_on_what_it_sticks_to() {
        let mut image = picture(0.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut image {
            *rotation = 30.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", image)),
            (
                2,
                element(
                    None,
                    "a1",
                    on(turned(framed(40.0, 40.0, 80.0, 60.0), 45.0), 1),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    on(turned(framed(60.0, 60.0, 20.0, 10.0), 10.0), 2),
                ),
            ),
            (
                4,
                element(
                    None,
                    "a3",
                    stuck((300.0, 300.0), None, (85.0, 75.0), Some(2)),
                ),
            ),
        ]));
        let on_note = |editor: &Editor, point: Point, whole: bool| {
            let note = Surface::of(&editor.board().elements[&id(2)].kind).unwrap();
            note.to_content(point, whole).unwrap()
        };
        let places = |editor: &Editor| {
            [
                editor
                    .board()
                    .pixel_at(id(1), placement(editor, 2).0.centre())
                    .unwrap(),
                on_note(editor, placement(editor, 3).0.centre(), true),
                on_note(editor, ends(editor, 4)[1].0, false),
            ]
        };
        let before = places(&editor);

        editor.straighten(&ids([1, 2, 3])).unwrap();

        for (after, before) in places(&editor).into_iter().zip(before) {
            assert_at(after, before.x, before.y);
        }
        for bits in [2, 3] {
            assert_eq!(placement(&editor, bits).1, 0.0);
        }
        assert_eq!(ends(&editor, 4)[1].1, Some(id(2)));
        assert_sound(&editor);
        editor.undo();
        assert_eq!(places(&editor), before);
    }

    #[test]
    fn straightened_as_a_group_a_note_keeps_to_its_pixel_on_the_image_beside_it() {
        let mut image = picture(0.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut image {
            *rotation = 30.0;
        }
        let mut editor = Editor::new(board([
            (9, element(None, "a0", ElementKind::Group)),
            (1, element(Some(9), "a0", image)),
            (
                2,
                element(
                    Some(9),
                    "a1",
                    on(turned(framed(120.0, 120.0, 20.0, 10.0), 30.0), 1),
                ),
            ),
        ]));
        let pixel = |editor: &Editor| {
            let centre = placement(editor, 2).0.centre();
            editor.board().pixel_at(id(1), centre).unwrap()
        };
        let before = pixel(&editor);

        editor.straighten(&ids([9])).unwrap();

        assert_at(pixel(&editor), before.x, before.y);
        assert_eq!(placement(&editor, 2).1, 0.0);
        assert_eq!(placement(&editor, 2).3, Some(id(1)));
        assert_sound(&editor);
    }

    #[test]
    fn what_sticks_to_what_follows_follows_too() {
        let comment = ElementKind::Comment {
            at: Point { x: 60.0, y: 60.0 },
            text: "Here".to_owned(),
            target: Some(id(2)),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 50.0, 50.0), 1)),
            ),
            (3, element(None, "a2", comment)),
            (
                4,
                element(None, "a3", stuck((300.0, 0.0), None, (90.0, 65.0), Some(2))),
            ),
        ]));
        assert_eq!(
            editor.translate(&ids([1]), 10.0, 5.0).unwrap(),
            ids([1, 2, 3, 4])
        );
        let ElementKind::Comment { at, .. } = editor.board().elements[&id(3)].kind else {
            unreachable!()
        };
        assert_eq!((at.x, at.y), (70.0, 65.0));
        assert_at(ends(&editor, 4)[1].0, 100.0, 70.0);
        assert_at(ends(&editor, 4)[0].0, 300.0, 0.0);
        assert_sound(&editor);

        editor.undo();
        editor.translate(&ids([1, 2]), 10.0, 5.0).unwrap();
        assert_placed(&editor, 2, 1, [50.0, 45.0, 50.0, 50.0], 0.0, 2.0);
        let ElementKind::Comment { at, .. } = editor.board().elements[&id(3)].kind else {
            unreachable!()
        };
        assert_eq!((at.x, at.y), (70.0, 65.0));
    }

    #[test]
    fn a_note_stuck_to_one_that_grows_to_fit_its_text_keeps_its_size_and_place() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 50.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 20.0, 20.0, 10.0), 1)),
            ),
        ]));
        editor
            .update(id(1), framed(0.0, 0.0, 100.0, 100.0))
            .unwrap();
        assert_placed(&editor, 2, 1, [40.0, 20.0, 20.0, 10.0], 0.0, 2.0);
    }

    #[test]
    fn what_sticks_whole_to_a_note_stays_on_its_line_as_its_text_grows() {
        // Pinned on the first of its lines, and set down on it whole there too.
        let comment = ElementKind::Comment {
            at: Point { x: 50.0, y: 6.0 },
            text: "Here".to_owned(),
            target: Some(id(1)),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 100.0, 12.0))),
            (2, element(None, "a1", comment)),
            (3, element(None, "a2", on(framed(10.0, 2.0, 20.0, 8.0), 1))),
        ]));
        // Grown down from one line to ten, as fitting its text does.
        editor
            .update(id(1), framed(0.0, 0.0, 100.0, 120.0))
            .unwrap();
        let ElementKind::Comment { at, .. } = editor.board().elements[&id(2)].kind else {
            unreachable!()
        };
        assert_at(at, 50.0, 6.0);
        assert_placed(&editor, 3, 1, [10.0, 2.0, 20.0, 8.0], 0.0, 2.0);
    }

    #[test]
    fn landing_sticks_to_the_topmost_surface_below_that_holds_it_whole() {
        let hollow = ElementKind::Shape {
            frame: Rect {
                x: 10.0,
                y: 10.0,
                width: 50.0,
                height: 50.0,
            },
            rotation: 0.0,
            shape: crate::Shape::Rectangle,
            corners: Default::default(),
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let comment = |x, y| ElementKind::Comment {
            at: Point { x, y },
            text: "Here".to_owned(),
            target: None,
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (2, element(None, "a1", hollow)),
            (3, element(None, "a2", framed(100.0, 100.0, 80.0, 80.0))),
            // Within what the hollow shape surrounds, on the note, and partly off both.
            (4, element(None, "a3", framed(20.0, 20.0, 10.0, 10.0))),
            (5, element(None, "a4", framed(110.0, 110.0, 20.0, 20.0))),
            (6, element(None, "a5", framed(190.0, 190.0, 20.0, 20.0))),
            (7, element(None, "a6", comment(150.0, 150.0))),
            // Where 4 lies, but drawn below everything, as "Zz" comes before "a0".
            (8, element(None, "Zz", framed(20.0, 20.0, 10.0, 10.0))),
            (9, element(None, "a7", ElementKind::Group)),
            (10, element(Some(9), "a0", framed(30.0, 150.0, 10.0, 10.0))),
            (11, element(None, "a8", comment(500.0, 500.0))),
        ]));
        assert_eq!(
            editor.land(&ids([4, 5, 6, 7, 8, 9, 11])).unwrap(),
            ids([4, 5, 7, 10])
        );
        let target = |editor: &Editor, bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!(
            [4, 5, 6, 7, 8, 10, 11].map(|bits| target(&editor, bits)),
            [Some(1), Some(3), None, Some(3), None, Some(1), None].map(|bits| bits.map(id))
        );

        editor.translate(&ids([5]), 200.0, 0.0).unwrap();
        assert_eq!(editor.land(&ids([5])).unwrap(), ids([5]));
        assert_eq!(target(&editor, 5), None);
        assert_eq!(editor.unstick(&ids([4, 9])).unwrap(), ids([4, 10]));
        assert_eq!(target(&editor, 4), None);
        assert_sound(&editor);
    }

    #[test]
    fn an_ellipse_lands_on_what_holds_its_curve_though_not_its_frame() {
        let ellipse = |x, y, width, height, rotation| ElementKind::Shape {
            frame: Rect {
                x,
                y,
                width,
                height,
            },
            rotation,
            shape: crate::Shape::Ellipse,
            corners: Default::default(),
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let mut aslant = picture(400.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut aslant {
            *rotation = 45.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            // Its curve reaches down to 194.7, its turned frame to 206.6.
            (
                2,
                element(None, "a1", ellipse(40.0, 130.0, 120.0, 40.0, 45.0)),
            ),
            // Ten lower, its curve pokes out at 204.7.
            (
                3,
                element(None, "a2", ellipse(40.0, 140.0, 120.0, 40.0, 45.0)),
            ),
            (4, element(None, "a3", aslant)),
            // Upright, 36.4 from the turned picture's lower sides, its frame's corner past them.
            (
                5,
                element(None, "a4", ellipse(470.0, 160.0, 60.0, 60.0, 0.0)),
            ),
        ]));
        editor.land(&ids([2, 3, 5])).unwrap();
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!(
            [2, 3, 5].map(target),
            [Some(1), None, Some(4)].map(|bits| bits.map(id))
        );
    }

    #[test]
    fn landing_on_an_image_shown_as_an_ellipse_takes_its_curve_to_hold_what_lands() {
        let mut shown = picture(0.0, 0.0);
        if let ElementKind::Image { edits, .. } = &mut shown {
            edits.crop_shape = CropShape::Ellipse;
        }
        let ellipse = |x, y, width, height| ElementKind::Shape {
            frame: Rect {
                x,
                y,
                width,
                height,
            },
            rotation: 0.0,
            shape: crate::Shape::Ellipse,
            corners: Default::default(),
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill: Fill::Hollow,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", shown)),
            (2, element(None, "a1", framed(90.0, 90.0, 20.0, 20.0))),
            // In a corner of the picture's frame, out of its curve.
            (3, element(None, "a2", framed(5.0, 5.0, 20.0, 20.0))),
            (4, element(None, "a3", ellipse(50.0, 50.0, 100.0, 100.0))),
            // Within the frame, its curve out of the picture's.
            (5, element(None, "a4", ellipse(0.0, 20.0, 200.0, 40.0))),
        ]));
        editor.land(&ids([2, 3, 4, 5])).unwrap();
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!(
            [2, 3, 4, 5].map(target),
            [Some(1), None, Some(1), None].map(|bits| bits.map(id))
        );
    }

    #[test]
    fn landing_sticks_to_a_filled_shape_but_through_a_filled_cross() {
        let shape = |shape, x, y, width, height, fill| ElementKind::Shape {
            frame: Rect {
                x,
                y,
                width,
                height,
            },
            rotation: 0.0,
            shape,
            corners: Default::default(),
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            fill,
            dash: Dash::Solid,
            opacity: Default::default(),
        };
        let comment = ElementKind::Comment {
            at: Point { x: 50.0, y: 50.0 },
            text: "Here".to_owned(),
            target: None,
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    shape(crate::Shape::Rectangle, 10.0, 10.0, 80.0, 80.0, Fill::Tint),
                ),
            ),
            (
                3,
                element(
                    None,
                    "a2",
                    shape(crate::Shape::Cross, 110.0, 110.0, 80.0, 80.0, Fill::Solid),
                ),
            ),
            (
                4,
                element(
                    None,
                    "a3",
                    shape(crate::Shape::Ellipse, 300.0, 0.0, 200.0, 100.0, Fill::Solid),
                ),
            ),
            (5, element(None, "a4", framed(20.0, 20.0, 10.0, 10.0))),
            // Between the cross's strokes.
            (6, element(None, "a5", framed(120.0, 140.0, 10.0, 10.0))),
            (
                7,
                element(
                    None,
                    "a6",
                    shape(crate::Shape::Ellipse, 380.0, 40.0, 40.0, 20.0, Fill::Hollow),
                ),
            ),
            (8, element(None, "a7", comment)),
        ]));
        editor.land(&ids([5, 6, 7, 8])).unwrap();
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!(
            [5, 6, 7, 8].map(target),
            [Some(2), Some(1), Some(4), Some(2)].map(|bits| bits.map(id))
        );
    }

    #[test]
    fn nothing_sticks_to_what_sticks_to_it() {
        // As big as each other, each lies whole on the other.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", framed(0.0, 0.0, 50.0, 50.0))),
            (2, element(None, "a1", on(framed(0.0, 0.0, 50.0, 50.0), 1))),
        ]));
        editor.restack(&ids([1]), Restack::Front).unwrap();
        assert!(editor.land(&ids([1])).unwrap().is_empty());
        assert_eq!(
            editor.update(id(1), on(framed(0.0, 0.0, 50.0, 50.0), 2)),
            Err(Error::StuckToItself(id(1)))
        );
        assert_eq!(
            editor.update(id(1), on(framed(0.0, 0.0, 50.0, 50.0), 1)),
            Err(Error::StuckToItself(id(1)))
        );
        let comment = ElementKind::Comment {
            at: Point { x: 0.0, y: 0.0 },
            text: String::new(),
            target: Some(id(2)),
        };
        editor.add(id(3), None, comment).unwrap();
        assert_eq!(
            editor.update(id(1), on(framed(0.0, 0.0, 50.0, 50.0), 3)),
            Err(Error::NotATarget(id(3)))
        );
    }

    #[test]
    fn landing_several_at_once_sticks_none_to_itself() {
        // As big as each other, each lies whole on those below it. 2 sticks to 1, drawn above.
        let mut editor = Editor::new(board([
            (2, element(None, "a0", on(framed(0.0, 0.0, 50.0, 50.0), 1))),
            (3, element(None, "a1", framed(0.0, 0.0, 50.0, 50.0))),
            (1, element(None, "a2", framed(0.0, 0.0, 50.0, 50.0))),
        ]));
        editor.land(&ids([3, 1])).unwrap();
        assert_sound(&editor);
        for bits in [1, 2, 3] {
            let kind = editor.board().elements[&id(bits)].kind.clone();
            assert!(editor.update(id(bits), kind).is_ok());
        }
    }

    #[test]
    fn landing_what_cannot_stick_whole_changes_nothing() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(10.0, 10.0, 20.0, 20.0), 1)),
            ),
            (3, element(None, "a2", arrow())),
            (4, element(None, "a3", ElementKind::Group)),
            (5, element(Some(4), "a0", picture(500.0, 0.0))),
        ]));
        let before = editor.board().clone();
        assert!(editor.land(&ids([1, 3, 4])).unwrap().is_empty());
        // Nor does unsticking the image free the note stuck to it.
        assert!(editor.unstick(&ids([1, 3, 4])).unwrap().is_empty());
        assert_eq!(editor.board(), &before);
        assert!(!editor.can_undo());
        assert_eq!(editor.unstick(&ids([2])).unwrap(), ids([2]));
    }

    #[test]
    fn landing_or_unsticking_an_unknown_element_is_refused() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (2, element(None, "a1", framed(10.0, 10.0, 20.0, 20.0))),
        ]));
        let before = editor.board().clone();
        assert_eq!(editor.land(&ids([2, 9])), Err(Error::UnknownElement(id(9))));
        assert_eq!(
            editor.unstick(&ids([9, 2])),
            Err(Error::UnknownElement(id(9)))
        );
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn what_lets_go_as_it_lands_can_be_landed_on() {
        // 1 sticks to 2, drawn above it.
        let mut editor = Editor::new(board([
            (1, element(None, "a0", on(framed(0.0, 0.0, 50.0, 50.0), 2))),
            (2, element(None, "a1", framed(0.0, 0.0, 50.0, 50.0))),
        ]));
        assert_eq!(editor.land(&ids([1, 2])).unwrap(), ids([1, 2]));
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!([1, 2].map(target), [None, Some(id(1))]);
        assert_sound(&editor);
    }

    #[test]
    fn removing_what_sticks_whole_frees_what_sticks_to_it() {
        let comment = ElementKind::Comment {
            at: Point { x: 60.0, y: 60.0 },
            text: "Here".to_owned(),
            target: Some(id(2)),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(framed(40.0, 40.0, 50.0, 50.0), 1)),
            ),
            (3, element(None, "a2", comment)),
        ]));
        let before = editor.board().clone();
        assert_eq!(editor.remove(&ids([1])).unwrap(), ids([1, 2]));
        assert_eq!(placement(&editor, 2).3, None);
        assert_eq!(editor.board().elements[&id(3)].kind.target(), Some(id(2)));
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn stretching_a_sticky_note_sideways_leaves_what_sticks_whole_its_size_and_on_it() {
        let sticky = |width| ElementKind::Sticky {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width,
                height: 200.0,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 20.0),
            target: None,
            paper: crate::Paper::default(),
            opacity: Default::default(),
        };
        let comment = ElementKind::Comment {
            at: Point { x: 150.0, y: 190.0 },
            text: "Here".to_owned(),
            target: Some(id(1)),
        };
        let mut editor = Editor::new(board([
            (1, element(None, "a0", sticky(200.0))),
            (
                2,
                element(None, "a1", on(framed(50.0, 150.0, 100.0, 25.0), 1)),
            ),
            (3, element(None, "a2", comment)),
            (
                4,
                element(
                    None,
                    "a3",
                    stuck((300.0, 0.0), None, (200.0, 100.0), Some(1)),
                ),
            ),
        ]));
        let before = editor.board().clone();
        // Its right side dragged out, its left one staying.
        editor.stretch(id(1), sticky(400.0)).unwrap();
        // The end on the middle of its right side stays there.
        assert_at(ends(&editor, 4)[1].0, 400.0, 100.0);
        let (frame, _, font_size, target) = placement(&editor, 2);
        assert_eq!(target, Some(id(1)));
        assert_eq!(
            (frame, font_size),
            (
                Rect {
                    x: 150.0,
                    y: 150.0,
                    width: 100.0,
                    height: 25.0
                },
                2.0
            )
        );
        let ElementKind::Comment { at, .. } = editor.board().elements[&id(3)].kind else {
            unreachable!()
        };
        assert_at(at, 300.0, 190.0);
        editor.undo();
        assert_eq!(editor.board(), &before);
    }

    fn line(from: (f64, f64), to: (f64, f64)) -> ElementKind {
        ElementKind::stroke(
            Tip::Highlighter,
            &[point(from.0, from.1), point(to.0, to.1)],
            0.0,
        )
    }

    fn assert_stroke_placed(
        editor: &Editor,
        bits: u128,
        target: u128,
        frame: [f64; 4],
        rotation: f64,
        drawn: [(f64, f64); 2],
    ) {
        let ElementKind::Stroke {
            frame: at,
            rotation: turned,
            points,
            target: sticks_to,
            ..
        } = &editor.board().elements[&id(bits)].kind
        else {
            unreachable!()
        };
        let placed = [at.x, at.y, at.width, at.height, *turned];
        let expected = [frame[0], frame[1], frame[2], frame[3], rotation];
        assert!(
            placed
                .iter()
                .zip(expected)
                .all(|(a, b)| (a - b).abs() < 1e-9),
            "{placed:?} is not {expected:?}"
        );
        assert_eq!(points, &drawn.map(|(x, y)| point(x, y)));
        assert_eq!(*sticks_to, Some(id(target)));
    }

    const AS_DRAWN: [(f64, f64); 2] = [(0.0, 0.0), (1.0, 1.0)];

    #[test]
    fn a_stroke_stuck_to_an_image_moves_scales_and_turns_with_it_as_drawn() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(line((40.0, 40.0), (60.0, 50.0)), 1)),
            ),
        ]));
        let before = editor.board().clone();

        assert_eq!(editor.translate(&ids([1]), 10.0, 5.0).unwrap(), ids([1, 2]));
        assert_stroke_placed(&editor, 2, 1, [50.0, 45.0, 20.0, 10.0], 0.0, AS_DRAWN);
        editor
            .scale(&ids([1]), Point { x: 10.0, y: 5.0 }, 2.0)
            .unwrap();
        assert_stroke_placed(&editor, 2, 1, [90.0, 85.0, 40.0, 20.0], 0.0, AS_DRAWN);
        editor
            .rotate(&ids([1]), Point { x: 210.0, y: 205.0 }, 90.0)
            .unwrap();
        assert_stroke_placed(&editor, 2, 1, [300.0, 95.0, 40.0, 20.0], 90.0, AS_DRAWN);
        assert_eq!(
            editor.board().elements[&id(2)].kind.stroke_width(),
            Tip::Highlighter.width(Weight::Medium)
        );
        assert_sound(&editor);

        for _ in 0..3 {
            assert_eq!(editor.undo(), ids([1, 2]));
        }
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn a_stroke_stuck_to_a_flipped_image_mirrors_with_it() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(None, "a1", on(line((40.0, 40.0), (60.0, 50.0)), 1)),
            ),
        ]));
        editor.flip(&ids([1]), true).unwrap();
        let across = [(1.0, 0.0), (0.0, 1.0)];
        assert_stroke_placed(&editor, 2, 1, [140.0, 40.0, 20.0, 10.0], 0.0, across);
        editor.flip(&ids([1]), false).unwrap();
        let both = [(1.0, 1.0), (0.0, 0.0)];
        assert_stroke_placed(&editor, 2, 1, [140.0, 150.0, 20.0, 10.0], 0.0, both);
        assert_eq!(editor.remove(&ids([1])).unwrap(), ids([1, 2]));
        assert_eq!(editor.board().elements[&id(2)].kind.target(), None);
    }

    #[test]
    fn a_stroke_stuck_to_a_flipping_image_keeps_each_point_on_its_pixel() {
        let shown = |degrees, shape| {
            let mut image = picture(0.0, 0.0);
            if let ElementKind::Image {
                rotation, edits, ..
            } = &mut image
            {
                *rotation = degrees;
                edits.crop_shape = shape;
            }
            image
        };
        let mut turned = line((40.0, 40.0), (70.0, 30.0));
        if let ElementKind::Stroke { rotation, .. } = &mut turned {
            *rotation = 30.0;
        }
        // Within the upper left quarter of the circle.
        let arc: Vec<Point> = (0..=9)
            .map(|step| {
                let angle = (180.0 + 10.0 * f64::from(step)).to_radians();
                point(100.0 + 95.0 * angle.cos(), 100.0 + 95.0 * angle.sin())
            })
            .collect();
        for (image, stroke) in [
            // Along an edge of the turned image.
            (
                shown(45.0, CropShape::Rectangle),
                line((110.0, -20.0), (220.0, 90.0)),
            ),
            (shown(0.0, CropShape::Rectangle), turned),
            (
                shown(0.0, CropShape::Ellipse),
                ElementKind::stroke(Tip::Pen, &arc, 0.0),
            ),
        ] {
            let mut editor = Editor::new(board([
                (1, element(None, "a0", image)),
                (2, element(None, "a1", stroke)),
            ]));
            assert_eq!(editor.land(&ids([2])).unwrap(), ids([2]));
            let pixels = |editor: &Editor| {
                let ElementKind::Stroke {
                    frame,
                    rotation,
                    points,
                    ..
                } = &editor.board().elements[&id(2)].kind
                else {
                    unreachable!()
                };
                crate::geometry::stroke_points(frame, *rotation, points)
                    .into_iter()
                    .map(|point| editor.board().pixel_at(id(1), point).unwrap())
                    .collect::<Vec<_>>()
            };
            let before = pixels(&editor);
            for horizontally in [true, false] {
                editor.flip(&ids([1]), horizontally).unwrap();
                for (after, before) in pixels(&editor).into_iter().zip(&before) {
                    assert_at(after, before.x, before.y);
                }
                let elements = &editor.board().elements;
                assert!(crate::geometry::holds(
                    &elements[&id(1)].kind,
                    &elements[&id(2)].kind
                ));
            }
        }
    }

    #[test]
    fn landing_sticks_a_stroke_whose_line_lies_whole_on_a_surface() {
        // A diamond around (100, 100), each corner about 141 away.
        let mut turned = picture(0.0, 0.0);
        if let ElementKind::Image { rotation, .. } = &mut turned {
            *rotation = 45.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", turned)),
            // Along an edge, the corner of its frame off the image.
            (2, element(None, "a1", line((110.0, -20.0), (220.0, 90.0)))),
            (3, element(None, "a2", line((150.0, 100.0), (260.0, 100.0)))),
            // Drawn below it.
            (4, element(None, "Zz", line((90.0, 90.0), (110.0, 110.0)))),
        ]));
        assert_eq!(editor.land(&ids([2, 3, 4])).unwrap(), ids([2]));
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!([2, 3, 4].map(target), [Some(id(1)), None, None]);
        assert_sound(&editor);
    }

    #[test]
    fn landing_on_an_image_shown_as_an_ellipse_takes_a_stroke_by_its_points_as_turned() {
        let mut shown = picture(0.0, 0.0);
        if let ElementKind::Image { edits, .. } = &mut shown {
            edits.crop_shape = CropShape::Ellipse;
        }
        // Upright, it reaches above the picture. Turned around (100, 40), it lies across it.
        let mut across = line((95.0, -10.0), (105.0, 90.0));
        if let ElementKind::Stroke { rotation, .. } = &mut across {
            *rotation = 90.0;
        }
        let mut editor = Editor::new(board([
            (1, element(None, "a0", shown)),
            // Within the curve, the corner of its frame out of it.
            (2, element(None, "a1", line((20.0, 100.0), (100.0, 20.0)))),
            // Within the picture's frame, an end out of its curve.
            (3, element(None, "a2", line((100.0, 100.0), (190.0, 190.0)))),
            (4, element(None, "a3", across)),
        ]));
        assert_eq!(editor.land(&ids([2, 3, 4])).unwrap(), ids([2, 4]));
        let target = |bits| editor.board().elements[&id(bits)].kind.target();
        assert_eq!([2, 3, 4].map(target), [Some(id(1)), None, Some(id(1))]);
        assert_sound(&editor);
    }

    #[test]
    fn a_dot_and_a_flat_stroke_land_and_follow_a_scale_and_a_turn() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", picture(0.0, 0.0))),
            (
                2,
                element(
                    None,
                    "a1",
                    ElementKind::stroke(Tip::Pen, &[point(50.0, 50.0)], 0.0),
                ),
            ),
            (3, element(None, "a2", line((40.0, 150.0), (80.0, 150.0)))),
        ]));
        let before = editor.board().clone();
        let drawn = |editor: &Editor, bits| {
            let kind = &editor.board().elements[&id(bits)].kind;
            let ElementKind::Stroke {
                frame,
                rotation,
                points,
                ..
            } = kind
            else {
                unreachable!()
            };
            let points = crate::geometry::stroke_points(frame, *rotation, points);
            (points, kind.target())
        };
        let assert_drawn = |editor: &Editor, bits, expected: &[(f64, f64)]| {
            let (points, target) = drawn(editor, bits);
            assert!(
                points.len() == expected.len()
                    && points.iter().zip(expected).all(|(at, &(x, y))| {
                        (at.x - x).abs() < 1e-9 && (at.y - y).abs() < 1e-9
                    }),
                "{points:?} is not {expected:?}"
            );
            assert_eq!(target, Some(id(1)));
        };

        assert_eq!(editor.land(&ids([2, 3])).unwrap(), ids([2, 3]));
        editor.scale(&ids([1]), point(0.0, 0.0), 2.0).unwrap();
        assert_drawn(&editor, 2, &[(100.0, 100.0)]);
        assert_drawn(&editor, 3, &[(80.0, 300.0), (160.0, 300.0)]);
        editor.rotate(&ids([1]), point(200.0, 200.0), 90.0).unwrap();
        assert_drawn(&editor, 2, &[(300.0, 100.0)]);
        assert_drawn(&editor, 3, &[(100.0, 80.0), (100.0, 160.0)]);
        assert_sound(&editor);

        for _ in 0..3 {
            editor.undo();
        }
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn moving_scaling_and_turning_a_pen_stroke_leave_its_points_and_its_width_alone() {
        let mut editor = Editor::new(board([(1, element(None, "a0", stroke()))]));
        let origin = Point { x: 0.0, y: 0.0 };
        editor.translate(&ids([1]), 10.0, 20.0).unwrap();
        editor.scale(&ids([1]), origin, 2.0).unwrap();
        editor.rotate(&ids([1]), origin, 90.0).unwrap();
        assert_eq!(editor.flip(&ids([1]), true).unwrap(), []);
        let ElementKind::Stroke {
            frame,
            rotation,
            points,
            weight,
            ..
        } = &editor.board().elements[&id(1)].kind
        else {
            unreachable!()
        };
        let ElementKind::Stroke {
            points: drawn,
            weight: chosen,
            ..
        } = stroke()
        else {
            unreachable!()
        };
        assert_eq!((points, weight), (&drawn, &chosen));
        assert_eq!((frame.width, frame.height, *rotation), (200.0, 100.0, 90.0));
        editor.straighten(&ids([1])).unwrap();
        let ElementKind::Stroke { rotation, .. } = &editor.board().elements[&id(1)].kind else {
            unreachable!()
        };
        assert_eq!(*rotation, 0.0);
    }
}
