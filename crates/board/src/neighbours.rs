//! What a box that moves or scales lines up with around it: the sides and middles of the elements
//! beside it, and the gaps that already part them, which pull it from as far as the grid's lines
//! do, and what shows it landed there. Each works across, and down once the board's axes are
//! swapped.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::arrange::HAIR;
use crate::grid::PULL;
use crate::{Axis, Board, ElementId, Point, Rect, snap_to_grid};

impl Board {
    /// The upright bounds of what each element, or each group whole, draws at the level of
    /// `within`, the group gone into, or the top level, and that stays put as `ids` move: none
    /// of them, nor what holds or follows any of them, as what sticks to them does. What draws
    /// nothing, such as a comment, is left out.
    pub fn neighbours(&self, ids: &[ElementId], within: Option<ElementId>) -> Vec<Rect> {
        let moving = self.followers(ids);
        self.elements
            .iter()
            .filter(|(id, element)| {
                element.group == within && self.with_descendants(&[**id]).is_disjoint(&moving)
            })
            .filter_map(|(id, _)| self.bounds(&[*id]))
            .collect()
    }

    /// `ids` with what their groups hold, and what sticks to any of those, whole or by an end,
    /// and so on.
    fn followers(&self, ids: &[ElementId]) -> BTreeSet<ElementId> {
        let mut found = self.with_descendants(ids);
        loop {
            let more: Vec<ElementId> = self
                .elements
                .iter()
                .filter(|(id, element)| {
                    !found.contains(id) && element.kind.targets().any(|to| found.contains(&to))
                })
                .map(|(id, _)| *id)
                .collect();
            if more.is_empty() {
                return found;
            }
            found.extend(more);
        }
    }
}

/// How far a moved box goes to line up with what is beside it, and what shows it did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Pull {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub y: Option<f64>,
    /// Along each line the box shares with a neighbour once pulled, across the room between
    /// those on it, each from a neighbour's end.
    pub bridges: Vec<(Point, Point)>,
    /// Across each gap that matches one beside the box, its own included, where the two it
    /// parts face each other, halfway.
    pub gaps: Vec<(Point, Point)>,
}

/// What a box that scales goes by instead to line up with what is beside it, and what shows it
/// did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Scaled {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub factor: Option<f64>,
    /// As a move's are.
    pub bridges: Vec<(Point, Point)>,
    /// As a move's are.
    pub gaps: Vec<(Point, Point)>,
}

/// Where a box drawn from one corner to another lands, and what shows it lined up.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Drawn {
    pub from: Point,
    pub to: Point,
    /// As a move's are.
    pub bridges: Vec<(Point, Point)>,
    /// As a move's are.
    pub gaps: Vec<(Point, Point)>,
}

/// Where `moving` lands among `neighbours`, at `zoom` screen pixels per board unit. Each way, it
/// lands within the reach of the grid's pull on the nearest side or middle of one that `window`
/// shows, or a gap away from one, as a gap already parts two of those beside it, or halfway
/// between two, a line before a gap as near, or else on the grid's lines when `grid`, as
/// [`snap_to_grid`] has it. Across first, then down from where that took it, and what shows it is
/// where it lands.
pub fn snap_to_neighbours(
    moving: Rect,
    neighbours: &[Rect],
    window: Rect,
    zoom: f64,
    grid: bool,
) -> Pull {
    let reach = PULL / zoom;
    let onto_grid = |area: &Rect| grid.then(|| snap_to_grid(&lines(area), zoom)).flatten();
    let shown = Shown::new(neighbours, &window);
    let lined_x = nudge(&moving, &shown.across, reach);
    let x = lined_x.or_else(|| onto_grid(&moving));
    let across = Rect {
        x: moving.x + x.unwrap_or(0.0),
        ..moving
    };
    let lined_y = nudge(&swap(&across), &shown.down, reach);
    let y = lined_y.or_else(|| onto_grid(&swap(&across)));
    let landed = Rect {
        y: across.y + y.unwrap_or(0.0),
        ..across
    };
    // Moving, each of its lines lines up as much as another.
    let (bridges, gaps) = shown.guides(&landed, [[lined_x.is_some(); 3], [lined_y.is_some(); 3]]);
    Pull {
        x,
        y,
        bridges,
        gaps,
    }
}

/// A box scaling around a point, as a gesture has it.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Scale {
    /// Upright, as it began.
    pub area: Rect,
    pub origin: Point,
    /// As the pointer has it.
    pub factor: f64,
    /// The least it may scale by.
    pub least: f64,
    /// The one way it scales, both when left out.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub along: Option<Axis>,
}

/// What the box `scale` has scales by instead, for a side of it that moves to land on the nearest
/// side or middle of a neighbour that `window` shows, or a gap away from the next one, as a gap
/// already parts two of those beside it, the box keeping to its room, a line before a gap as near.
/// The side that moves the furthest moves no further than the grid's lines pull at `zoom` screen
/// pixels per board unit, and what shows it is what the sides it moves line up with.
pub fn snap_scale_to_neighbours(
    scale: Scale,
    neighbours: &[Rect],
    window: Rect,
    zoom: f64,
) -> Scaled {
    let Scale {
        area,
        origin,
        factor,
        least,
        along,
    } = scale;
    let ways = [
        along != Some(Axis::Vertical),
        along != Some(Axis::Horizontal),
    ];
    let reaching = |scales: bool, start: f64, end: f64, origin: f64| {
        if scales {
            (start - origin).abs().max((end - origin).abs())
        } else {
            0.0
        }
    };
    let longest = reaching(ways[0], area.x, right(&area), origin.x).max(reaching(
        ways[1],
        area.y,
        area.y + area.height,
        origin.y,
    ));
    if longest <= HAIR {
        return Scaled::default();
    }
    let shown = Shown::new(neighbours, &window);
    let now = scaled(&area, origin, factor, ways);
    let mut nearest = Nearest::within(PULL / zoom);
    if ways[0] {
        let sides = Sides {
            area,
            origin: origin.x,
            factor,
            least,
            longest,
        };
        sides.offer(&now, &shown.across, &mut nearest);
    }
    if ways[1] {
        let sides = Sides {
            area: swap(&area),
            origin: origin.y,
            factor,
            least,
            longest,
        };
        sides.offer(&swap(&now), &shown.down, &mut nearest);
    }
    let Some((by, _)) = nearest.found() else {
        return Scaled::default();
    };
    // Only the sides it moves line up, as those it keeps were where they are already.
    let moving = |scales: bool, start: f64, end: f64, origin: f64| {
        let moves = |side: f64| scales && (side - origin).abs() > HAIR;
        [moves(start), false, moves(end)]
    };
    let which = [
        moving(ways[0], area.x, right(&area), origin.x),
        moving(ways[1], area.y, area.y + area.height, origin.y),
    ];
    let (bridges, gaps) = shown.guides(&scaled(&area, origin, by, ways), which);
    Scaled {
        factor: Some(by),
        bridges,
        gaps,
    }
}

/// Where a box drawn `from` one corner `to` the other lands among `neighbours`, at `zoom` screen
/// pixels per board unit. Each way, within the reach of the grid's pull, the corner it starts from
/// lands on the nearest side or middle of one that `window` shows, and the one it is drawn to on
/// one too, or a gap away from the next one, as a gap already parts two of those beside it, a line
/// before a gap as near, or else each on the grid's lines when `grid`, as [`snap_to_grid`] has
/// it. Across first, then down from where that took it, and what shows it is what the sides that
/// lined up line up with.
pub fn snap_drawn_to_neighbours(
    from: Point,
    to: Point,
    neighbours: &[Rect],
    window: Rect,
    zoom: f64,
    grid: bool,
) -> Drawn {
    let shown = Shown::new(neighbours, &window);
    let reach = PULL / zoom;
    let onto_grid = |value: f64| grid.then(|| snap_to_grid(&[value], zoom)).flatten();
    let across = Drawing {
        from: from.x,
        to: to.x,
        down: [from.y.min(to.y), from.y.max(to.y)],
    };
    let ([from_x, to_x], lined_x) = across.land(&shown.across, reach, &onto_grid);
    let down = Drawing {
        from: from.y,
        to: to.y,
        down: [from_x.min(to_x), from_x.max(to_x)],
    };
    let ([from_y, to_y], lined_y) = down.land(&shown.down, reach, &onto_grid);
    let (from, to) = (
        Point {
            x: from_x,
            y: from_y,
        },
        Point { x: to_x, y: to_y },
    );
    let sides = |[started, ended]: [bool; 2], first: f64, last: f64| {
        if first <= last {
            [started, false, ended]
        } else {
            [ended, false, started]
        }
    };
    let landed = Rect {
        x: from.x.min(to.x),
        y: from.y.min(to.y),
        width: (to.x - from.x).abs(),
        height: (to.y - from.y).abs(),
    };
    let which = [sides(lined_x, from_x, to_x), sides(lined_y, from_y, to_y)];
    let (bridges, gaps) = shown.guides(&landed, which);
    Drawn {
        from,
        to,
        bridges,
        gaps,
    }
}

/// A box drawn across `from` one side `to` the other, as far down as `down` reaches.
struct Drawing {
    from: f64,
    to: f64,
    down: [f64; 2],
}

impl Drawing {
    /// Where its two sides land among `shown`, and whether each lined up with one of them.
    fn land(
        &self,
        shown: &[Rect],
        reach: f64,
        onto_grid: &dyn Fn(f64) -> Option<f64>,
    ) -> ([f64; 2], [bool; 2]) {
        let mut start = Nearest::within(reach);
        for neighbour in shown {
            for line in lines(neighbour) {
                start.offer(line - self.from, Rank::Line, line);
            }
        }
        let lined_from = start.found();
        let from = lined_from
            .or_else(|| onto_grid(self.from).map(|nudge| self.from + nudge))
            .unwrap_or(self.from);
        // Brought back within reach of the line it started on, onto that line too, so that a drag
        // back there counts as a click.
        if lined_from.is_some() && (self.to - from).abs() <= reach {
            return ([from, from], [true, false]);
        }
        // As it scales around where it starts.
        let area = Rect {
            x: from.min(self.to),
            y: self.down[0],
            width: (self.to - from).abs(),
            height: self.down[1] - self.down[0],
        };
        let mut end = Nearest::within(reach);
        if area.width > HAIR {
            let sides = Sides {
                area,
                origin: from,
                factor: 1.0,
                least: 0.0,
                longest: area.width,
            };
            sides.offer(&area, shown, &mut end);
        }
        let lined_to = end.found().map(|(_, to)| to);
        let to = lined_to
            .or_else(|| onto_grid(self.to).map(|nudge| self.to + nudge))
            .unwrap_or(self.to);
        ([from, to], [lined_from.is_some(), lined_to.is_some()])
    }
}

/// How far across `moving` goes to land on the nearest line or gap within `reach`.
fn nudge(moving: &Rect, shown: &[Rect], reach: f64) -> Option<f64> {
    let mut nearest = Nearest::within(reach);
    for neighbour in shown {
        for theirs in lines(neighbour) {
            for mine in lines(moving) {
                nearest.offer(theirs - mine, Rank::Line, theirs - mine);
            }
        }
    }
    let row = Row::of(moving, shown);
    let width = moving.width;
    // A gap after what ends where a stretch of room starts, or before what starts where one ends,
    // the box fitting in it.
    for (from, to) in row.stretches() {
        let most = to - from - width;
        if from.is_finite()
            && let Some(gap) = row.gap(moving.x - from, most)
        {
            let by = from + gap - moving.x;
            nearest.offer(by, Rank::Gap, by);
        }
        if to.is_finite()
            && let Some(gap) = row.gap(to - width - moving.x, most)
        {
            let by = to - gap - width - moving.x;
            nearest.offer(by, Rank::Gap, by);
        }
    }
    for room in &row.rooms {
        if room.width() > width {
            let by = (room.from + room.to - width) / 2.0 - moving.x;
            nearest.offer(by, Rank::Gap, by);
        }
    }
    nearest.found()
}

/// The sides of a box scaling across around `origin`, by no less than `least`, the furthest of
/// which from it moves `longest` times as far as `factor` changes.
struct Sides {
    area: Rect,
    origin: f64,
    factor: f64,
    least: f64,
    longest: f64,
}

impl Sides {
    /// Offers what it scales by, and where that lands the side, for each of its sides that moves
    /// to land on a line of `shown`, or a gap away from the next one of the row, `now` as it shows
    /// at `factor`, the room it keeps to its own.
    fn offer(&self, now: &Rect, shown: &[Rect], nearest: &mut Nearest<(f64, f64)>) {
        let Self {
            area,
            origin,
            factor,
            least,
            longest,
        } = *self;
        let row = Row::of(now, shown);
        let room = row
            .stretches()
            .find(|(from, to)| *from <= origin + HAIR && origin <= *to + HAIR);
        // A gap away from the next one only counts with the box in its room, both sides of it.
        let fits = |by: f64| {
            room.is_some_and(|(from, to)| {
                let [start, end] = [area.x, right(&area)].map(|side| origin + (side - origin) * by);
                start >= from - HAIR && end <= to + HAIR
            })
        };
        for side in [area.x, right(&area)] {
            let apart = side - origin;
            if apart.abs() <= HAIR {
                continue;
            }
            let at = origin + apart * factor;
            let mut offer = |to: f64, rank: Rank| {
                let by = (to - origin) / apart;
                if by > 0.0 && by >= least && (rank == Rank::Line || fits(by)) {
                    nearest.offer((by - factor) * longest, rank, (by, to));
                }
            };
            for neighbour in shown {
                for line in lines(neighbour) {
                    offer(line, Rank::Line);
                }
            }
            match room {
                Some((_, to)) if apart > 0.0 && to.is_finite() => {
                    if let Some(gap) = row.gap(to - at, to - origin) {
                        offer(to - gap, Rank::Gap);
                    }
                }
                Some((from, _)) if apart < 0.0 && from.is_finite() => {
                    if let Some(gap) = row.gap(at - from, origin - from) {
                        offer(from + gap, Rank::Gap);
                    }
                }
                _ => {}
            }
        }
    }
}

/// `area` scaled `by` around `origin`, each way it `scales`.
fn scaled(area: &Rect, origin: Point, by: f64, scales: [bool; 2]) -> Rect {
    let along = |start: f64, size: f64, origin: f64, scales: bool| {
        if scales {
            (origin + (start - origin) * by, size * by)
        } else {
            (start, size)
        }
    };
    let (x, width) = along(area.x, area.width, origin.x, scales[0]);
    let (y, height) = along(area.y, area.height, origin.y, scales[1]);
    Rect {
        x,
        y,
        width,
        height,
    }
}

type Spans = Vec<(Point, Point)>;

/// Which of a box's lines along one way: its start, its middle, its end.
type Lines = [bool; 3];

/// The nearest of what is offered within reach, a line before a gap as near.
struct Nearest<T> {
    reach: f64,
    best: Option<(f64, Rank, T)>,
}

impl<T> Nearest<T> {
    fn within(reach: f64) -> Self {
        Self { reach, best: None }
    }

    /// `far` how far either way it takes the box.
    fn offer(&mut self, far: f64, rank: Rank, value: T) {
        let far = far.abs();
        let better = self.best.as_ref().is_none_or(|(found, ranked, _)| {
            far < found - HAIR || (far <= found + HAIR && rank < *ranked)
        });
        if far <= self.reach && better {
            self.best = Some((far, rank, value));
        }
    }

    fn found(self) -> Option<T> {
        self.best.map(|(_, _, value)| value)
    }
}

/// The neighbours a window shows, as they are and with the board's axes swapped.
struct Shown {
    across: Vec<Rect>,
    down: Vec<Rect>,
}

impl Shown {
    fn new(neighbours: &[Rect], window: &Rect) -> Self {
        let across: Vec<Rect> = neighbours
            .iter()
            .copied()
            .filter(|area| meets(area, window))
            .collect();
        let down = across.iter().map(swap).collect();
        Self { across, down }
    }

    /// The bridges and the gaps that show what `which` of `landed`'s lines line up with, across,
    /// then down.
    fn guides(&self, landed: &Rect, which: [Lines; 2]) -> (Spans, Spans) {
        let mut bridged = bridges(landed, &self.across, which[0]);
        let mut spaced = gaps(landed, &self.across, which[0]);
        let back = |(from, to): (Point, Point)| (swap_point(from), swap_point(to));
        let down = swap(landed);
        bridged.extend(bridges(&down, &self.down, which[1]).into_iter().map(back));
        spaced.extend(gaps(&down, &self.down, which[1]).into_iter().map(back));
        (bridged, spaced)
    }
}

/// Those beside a box that face it up and down, from left to right, the rooms between them, and
/// the gaps that part two of them facing each other, from the narrowest, once each.
struct Row {
    areas: Vec<Rect>,
    rooms: Vec<Room>,
    parted: Vec<f64>,
}

impl Row {
    fn of(area: &Rect, shown: &[Rect]) -> Self {
        let areas = row(area, shown);
        let rooms = rooms(&areas);
        let mut parted: Vec<f64> = rooms
            .iter()
            .filter(|room| facing(&areas[room.before], &areas[room.after]) > HAIR)
            .map(Room::width)
            .collect();
        parted.sort_by(f64::total_cmp);
        parted.dedup_by(|a, b| *a - *b <= HAIR);
        Self {
            areas,
            rooms,
            parted,
        }
    }

    /// Each stretch of room along it: its rooms, and what it leaves open before it and after it.
    fn stretches(&self) -> impl Iterator<Item = (f64, f64)> + '_ {
        let open = self.areas.first().map(|first| {
            let end = self
                .areas
                .iter()
                .map(right)
                .fold(f64::NEG_INFINITY, f64::max);
            [(f64::NEG_INFINITY, first.x), (end, f64::INFINITY)]
        });
        let rooms = self.rooms.iter().map(|room| (room.from, room.to));
        rooms.chain(open.into_iter().flatten())
    }

    /// Of its gaps, the one nearest `aimed` that is at most `most`.
    fn gap(&self, aimed: f64, most: f64) -> Option<f64> {
        let fitting = &self.parted[..self.parted.partition_point(|gap| *gap <= most + HAIR)];
        let at = fitting.partition_point(|gap| *gap < aimed);
        [at.checked_sub(1), Some(at)]
            .into_iter()
            .flatten()
            .filter_map(|at| fitting.get(at).copied())
            .min_by(|a, b| (a - aimed).abs().total_cmp(&(b - aimed).abs()))
    }
}

/// Which of two as near wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Line,
    Gap,
}

/// Along each of `which` of `landed`'s lines that one of `shown` shares, across the room between
/// those on it, each from a neighbour's end, so that what it dashes stays put as the box moves.
fn bridges(landed: &Rect, shown: &[Rect], which: Lines) -> Spans {
    let mut found = Vec::new();
    let mut done: Vec<f64> = Vec::new();
    for (line, shows) in lines(landed).into_iter().zip(which) {
        // A box with no width has one line where it would have three.
        if !shows || done.iter().any(|other| (other - line).abs() <= HAIR) {
            continue;
        }
        done.push(line);
        let mut on: Vec<(f64, f64, bool)> = shown
            .iter()
            .filter(|area| {
                lines(area)
                    .iter()
                    .any(|theirs| (theirs - line).abs() <= HAIR)
            })
            .map(|area| (area.y, area.y + area.height, false))
            .collect();
        if on.is_empty() {
            continue;
        }
        on.push((landed.y, landed.y + landed.height, true));
        on.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut end = on[0].1;
        for &(top, bottom, moved) in &on[1..] {
            if top - end > HAIR {
                let (from, to) = if moved { (end, top) } else { (top, end) };
                found.push((Point { x: line, y: from }, Point { x: line, y: to }));
            }
            end = end.max(bottom);
        }
    }
    found
}

/// Across each gap in `landed`'s row that matches one beside `which` of its sides.
fn gaps(landed: &Rect, shown: &[Rect], which: Lines) -> Spans {
    let mut row = row(landed, shown);
    let at = row.partition_point(|area| order(area, landed).is_lt());
    row.insert(at, *landed);
    let rooms: Vec<Room> = rooms(&row)
        .into_iter()
        .filter(|room| facing(&row[room.before], &row[room.after]) > HAIR)
        .collect();
    let alike = |a: &Room, b: &Room| (a.width() - b.width()).abs() <= HAIR;
    let matched: Vec<&Room> = rooms
        .iter()
        .filter(|own| (own.after == at && which[0]) || (own.before == at && which[2]))
        .filter(|own| rooms.iter().filter(|room| alike(room, own)).count() > 1)
        .collect();
    rooms
        .iter()
        .filter(|room| matched.iter().any(|own| alike(room, own)))
        .map(|room| {
            let (a, b) = (&row[room.before], &row[room.after]);
            let middle = (a.y.max(b.y) + (a.y + a.height).min(b.y + b.height)) / 2.0;
            (
                Point {
                    x: room.from,
                    y: middle,
                },
                Point {
                    x: room.to,
                    y: middle,
                },
            )
        })
        .collect()
}

/// The room across between two of a row that nothing else of it takes, and where in the row
/// the two are.
struct Room {
    from: f64,
    to: f64,
    before: usize,
    after: usize,
}

impl Room {
    fn width(&self) -> f64 {
        self.to - self.from
    }
}

/// Each room of `row`, which runs from left to right, in its order.
fn rooms(row: &[Rect]) -> Vec<Room> {
    let mut found = Vec::new();
    let Some(first) = row.first() else {
        return found;
    };
    // What reaches furthest so far, which a wide one can do past those after it.
    let (mut end, mut reaching) = (right(first), 0);
    for (at, area) in row.iter().enumerate().skip(1) {
        if area.x - end > HAIR {
            found.push(Room {
                from: end,
                to: area.x,
                before: reaching,
                after: at,
            });
        }
        if right(area) > end {
            (end, reaching) = (right(area), at);
        }
    }
    found
}

/// Those of `shown` that face `moving` up and down, from left to right.
fn row(moving: &Rect, shown: &[Rect]) -> Vec<Rect> {
    let mut row: Vec<Rect> = shown
        .iter()
        .filter(|area| facing(area, moving) > HAIR)
        .copied()
        .collect();
    row.sort_by(order);
    row
}

fn order(a: &Rect, b: &Rect) -> std::cmp::Ordering {
    a.x.total_cmp(&b.x).then(right(a).total_cmp(&right(b)))
}

/// How far the two overlap up and down, negative when apart.
fn facing(a: &Rect, b: &Rect) -> f64 {
    (a.y + a.height).min(b.y + b.height) - a.y.max(b.y)
}

/// Its left, its middle across, and its right.
fn lines(area: &Rect) -> [f64; 3] {
    [area.x, area.x + area.width / 2.0, right(area)]
}

fn right(area: &Rect) -> f64 {
    area.x + area.width
}

/// Whether the two touch, edges included.
fn meets(a: &Rect, b: &Rect) -> bool {
    a.x <= right(b) && b.x <= right(a) && a.y <= b.y + b.height && b.y <= a.y + a.height
}

fn swap(area: &Rect) -> Rect {
    Rect {
        x: area.y,
        y: area.x,
        width: area.height,
        height: area.width,
    }
}

fn swap_point(point: Point) -> Point {
    Point {
        x: point.y,
        y: point.x,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{arrow, board, element, id, stroke};
    use crate::{AssetId, ElementKind, ImageEdits, Size};

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn at(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn scaling(area: Rect, origin: Point, factor: f64, along: Option<Axis>) -> Scale {
        Scale {
            area,
            origin,
            factor,
            least: 0.01,
            along,
        }
    }

    /// As much of the board as any test reaches.
    const WINDOW: Rect = Rect {
        x: -1000.0,
        y: -1000.0,
        width: 3000.0,
        height: 3000.0,
    };

    fn image(x: f64, y: f64, width: f64, height: f64, rotation: f64) -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(b""),
            natural_size: Size {
                width: 1,
                height: 1,
            },
            frame: area(x, y, width, height),
            rotation,
            edits: ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    #[test]
    fn each_side_and_middle_lands_on_each_of_a_neighbour_within_reach() {
        // Its left, middle, and right are 100, 200, and 300 across, the moved box's 0, 15, and 30
        // from its left.
        let neighbour = [area(100.0, 300.0, 200.0, 20.0)];
        for (x, expected) in [
            (103.0, -3.0),
            (89.0, -4.0),
            (65.0, 5.0),
            (206.0, -6.0),
            (167.0, 3.0),
            (287.0, -2.0),
            (277.0, -7.0),
        ] {
            let pull = snap_to_neighbours(area(x, 0.0, 30.0, 10.0), &neighbour, WINDOW, 1.0, false);
            assert_eq!(pull.x, Some(expected), "{x}");
            assert_eq!(pull.y, None, "{x}");
        }
        let far = snap_to_neighbours(area(108.5, 0.0, 30.0, 10.0), &neighbour, WINDOW, 1.0, false);
        assert_eq!(far.x, None);
    }

    #[test]
    fn it_reaches_as_far_on_screen_at_any_zoom() {
        // Its three lines as one.
        let neighbour = [area(0.0, 300.0, 0.0, 50.0)];
        for zoom in [0.05, 0.5, 1.0, 7.0] {
            let reach = 8.0 / zoom;
            let near = snap_to_neighbours(
                area(reach, 0.0, 10.0, 10.0),
                &neighbour,
                WINDOW,
                zoom,
                false,
            );
            assert_eq!(near.x, Some(-reach), "{zoom}");
            let beyond = area(reach * 1.01, 0.0, 10.0, 10.0);
            let far = snap_to_neighbours(beyond, &neighbour, WINDOW, zoom, false);
            assert_eq!(far.x, None, "{zoom}");
        }
    }

    #[test]
    fn the_nearest_line_wins_each_way_on_its_own() {
        let neighbours = [
            area(100.0, 300.0, 50.0, 50.0),
            area(300.0, 105.0, 50.0, 50.0),
        ];
        let pull = snap_to_neighbours(
            area(96.0, 103.0, 20.0, 20.0),
            &neighbours,
            WINDOW,
            1.0,
            false,
        );
        assert_eq!((pull.x, pull.y), (Some(4.0), Some(2.0)));
        let nearer = [
            area(100.0, 300.0, 50.0, 50.0),
            area(98.0, 500.0, 50.0, 50.0),
        ];
        let pull = snap_to_neighbours(area(96.0, 0.0, 20.0, 20.0), &nearer, WINDOW, 1.0, false);
        assert_eq!(pull.x, Some(2.0));
    }

    #[test]
    fn only_neighbours_the_window_shows_pull() {
        let neighbour = [area(100.0, 300.0, 50.0, 50.0)];
        let window = area(0.0, 0.0, 200.0, 299.0);
        let pull = snap_to_neighbours(area(103.0, 0.0, 10.0, 10.0), &neighbour, window, 1.0, false);
        assert_eq!(pull, Pull::default());
        let touching = area(0.0, 0.0, 200.0, 300.0);
        let pull = snap_to_neighbours(
            area(103.0, 0.0, 10.0, 10.0),
            &neighbour,
            touching,
            1.0,
            false,
        );
        assert_eq!(pull.x, Some(-3.0));
    }

    #[test]
    fn a_neighbour_wins_over_the_grid_which_takes_the_way_none_pulls() {
        let neighbour = [area(303.0, 200.0, 100.0, 100.0)];
        let moving = area(196.0, 3.0, 100.0, 100.0);
        // The grid's line at 300 is nearer than the neighbour's side, and one at 0 pulls down.
        let pull = snap_to_neighbours(moving, &neighbour, WINDOW, 1.0, true);
        assert_eq!((pull.x, pull.y), (Some(7.0), Some(-3.0)));
        // From where it lands, the grid's pull included.
        assert_eq!(pull.bridges, [(at(303.0, 200.0), at(303.0, 100.0))]);
        let unpulled = snap_to_neighbours(moving, &neighbour, WINDOW, 1.0, false);
        assert_eq!((unpulled.x, unpulled.y), (Some(7.0), None));
    }

    #[test]
    fn a_line_lands_within_far_less_than_a_hair_of_where_it_was_aimed() {
        let neighbour = [area(-4_321.123_456_789, 0.0, 77.7, 33.3)];
        let mut x: f64 = -4_340.0;
        while x < -4_200.0 {
            let moving = area(x, 100.0, 13.1, 10.0);
            if let Some(nudge) = snap_to_neighbours(moving, &neighbour, WINDOW, 0.7, false).x {
                let landed = area(x + nudge, 100.0, 13.1, 10.0);
                let on = lines(&landed).iter().any(|mine| {
                    lines(&neighbour[0])
                        .iter()
                        .any(|theirs| (mine - theirs).abs() < 1e-9)
                });
                assert!(on, "{x}");
            }
            x += 0.618_033_988_7;
        }
    }

    #[test]
    fn it_lands_a_gap_away_as_one_already_parts_its_row() {
        // 40 apart, and the moved box faces both up and down.
        let row = [area(0.0, 0.0, 100.0, 100.0), area(140.0, 20.0, 60.0, 100.0)];
        let after = snap_to_neighbours(area(243.0, 50.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(after.x, Some(-3.0));
        let before = snap_to_neighbours(area(-75.0, 50.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(before.x, Some(5.0));
        // Below the row, it faces neither.
        let below = snap_to_neighbours(area(243.0, 130.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(below.x, None);
    }

    #[test]
    fn it_lands_a_gap_after_one_or_before_the_next_in_the_room_between_them() {
        let row = [
            area(0.0, 0.0, 100.0, 100.0),
            area(140.0, 0.0, 60.0, 100.0),
            area(400.0, 0.0, 100.0, 100.0),
        ];
        let after = snap_to_neighbours(area(243.0, 40.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(after.x, Some(-3.0));
        let before = snap_to_neighbours(area(327.0, 40.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(before.x, Some(3.0));
    }

    #[test]
    fn a_gap_counts_from_what_reaches_furthest() {
        // The second lies within the first, which reaches past it.
        let row = [
            area(0.0, 0.0, 300.0, 100.0),
            area(100.0, 0.0, 50.0, 100.0),
            area(340.0, 0.0, 60.0, 100.0),
        ];
        let after = snap_to_neighbours(area(443.0, 40.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(after.x, Some(-3.0));
        let within = snap_to_neighbours(area(193.0, 40.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(within.x, None);
    }

    #[test]
    fn it_lands_halfway_between_two() {
        let row = [area(0.0, 0.0, 100.0, 100.0), area(200.0, 0.0, 100.0, 100.0)];
        let pull = snap_to_neighbours(area(133.0, 40.0, 30.0, 20.0), &row, WINDOW, 1.0, false);
        assert_eq!(pull.x, Some(2.0));
        assert_eq!(
            pull.gaps,
            [
                (at(100.0, 50.0), at(135.0, 50.0)),
                (at(165.0, 50.0), at(200.0, 50.0))
            ]
        );
    }

    #[test]
    fn a_gap_counts_only_between_two_that_face_each_other() {
        // 40 apart across, but one above the other, as each faces the moved box only in part.
        let apart = [area(0.0, 0.0, 100.0, 50.0), area(140.0, 60.0, 60.0, 50.0)];
        let pull = snap_to_neighbours(area(243.0, 40.0, 30.0, 30.0), &apart, WINDOW, 1.0, false);
        assert_eq!(pull.x, None);
    }

    #[test]
    fn a_gap_that_would_overlap_another_does_not_pull() {
        // Landing 40 after the first would put it over the second.
        let row = [area(0.0, 0.0, 100.0, 100.0), area(140.0, 0.0, 60.0, 100.0)];
        let pull = snap_to_neighbours(area(137.0, 50.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(pull.x, Some(3.0), "onto the second's left instead");
        assert!(pull.gaps.is_empty());
    }

    #[test]
    fn a_line_wins_over_a_gap_as_near() {
        let row = [
            area(0.0, 0.0, 100.0, 100.0),
            area(140.0, 0.0, 60.0, 100.0),
            area(240.0, 500.0, 10.0, 10.0),
        ];
        // 40 after the second is also the third's left, and nothing pulls down from 2 away.
        let pull = snap_to_neighbours(area(241.0, 25.0, 30.0, 30.0), &row, WINDOW, 4.0, false);
        assert_eq!((pull.x, pull.y), (Some(-1.0), None));
        assert_eq!(pull.bridges, [(at(240.0, 500.0), at(240.0, 55.0))]);
        // Which also leaves it a gap away, as it shows.
        assert_eq!(
            pull.gaps,
            [
                (at(100.0, 50.0), at(140.0, 50.0)),
                (at(200.0, 40.0), at(240.0, 40.0))
            ]
        );
    }

    #[test]
    fn the_matching_gaps_show_halfway_where_their_two_face_each_other() {
        let row = [area(0.0, 0.0, 100.0, 100.0), area(140.0, 20.0, 60.0, 100.0)];
        let pull = snap_to_neighbours(area(243.0, 50.0, 30.0, 30.0), &row, WINDOW, 1.0, false);
        assert_eq!(
            pull.gaps,
            [
                (at(100.0, 60.0), at(140.0, 60.0)),
                (at(200.0, 65.0), at(240.0, 65.0))
            ]
        );
    }

    #[test]
    fn a_bridge_spans_only_the_room_between_each_on_a_line_from_a_neighbours_end() {
        let neighbours = [area(100.0, 0.0, 50.0, 50.0), area(100.0, 300.0, 50.0, 50.0)];
        let pull = snap_to_neighbours(
            area(102.0, 120.0, 50.0, 50.0),
            &neighbours,
            WINDOW,
            1.0,
            false,
        );
        assert_eq!(pull.x, Some(-2.0));
        assert_eq!(
            pull.bridges,
            [
                (at(100.0, 50.0), at(100.0, 120.0)),
                (at(100.0, 300.0), at(100.0, 170.0)),
                (at(125.0, 50.0), at(125.0, 120.0)),
                (at(125.0, 300.0), at(125.0, 170.0)),
                (at(150.0, 50.0), at(150.0, 120.0)),
                (at(150.0, 300.0), at(150.0, 170.0)),
            ]
        );
    }

    #[test]
    fn a_bridge_spans_no_room_where_the_two_overlap_along_the_line() {
        let neighbour = [area(100.0, 0.0, 50.0, 50.0)];
        let pull = snap_to_neighbours(
            area(103.0, 30.0, 10.0, 50.0),
            &neighbour,
            WINDOW,
            1.0,
            false,
        );
        assert_eq!(pull.x, Some(-3.0));
        assert!(pull.bridges.is_empty());
    }

    #[test]
    fn down_works_as_across() {
        let neighbours = [area(300.0, 100.0, 50.0, 50.0)];
        let pull = snap_to_neighbours(area(0.0, 96.0, 20.0, 20.0), &neighbours, WINDOW, 1.0, false);
        assert_eq!((pull.x, pull.y), (None, Some(4.0)));
        assert_eq!(pull.bridges, [(at(300.0, 100.0), at(20.0, 100.0))]);
        let column = [area(0.0, 0.0, 100.0, 100.0), area(20.0, 140.0, 100.0, 60.0)];
        let pull = snap_to_neighbours(area(50.0, 243.0, 30.0, 30.0), &column, WINDOW, 1.0, false);
        assert_eq!(pull.y, Some(-3.0));
        assert_eq!(
            pull.gaps,
            [
                (at(60.0, 100.0), at(60.0, 140.0)),
                (at(65.0, 200.0), at(65.0, 240.0))
            ]
        );
    }

    #[test]
    fn a_scaled_side_lands_on_a_neighbour_within_reach_of_its_corner() {
        let square = area(0.0, 0.0, 100.0, 100.0);
        let neighbour = [area(250.0, 300.0, 50.0, 50.0)];
        let scaled = |factor| {
            let scale = scaling(square, at(0.0, 0.0), factor, None);
            snap_scale_to_neighbours(scale, &neighbour, WINDOW, 1.0)
        };
        let near = scaled(2.47);
        assert_eq!(near.factor, Some(2.5));
        assert_eq!(near.bridges, [(at(250.0, 300.0), at(250.0, 250.0))]);
        assert!(near.gaps.is_empty());
        // The corner would move 12 to get there.
        assert_eq!(scaled(2.62), Scaled::default());
    }

    #[test]
    fn scaling_around_its_middle_lands_the_far_side_too() {
        let neighbour = [area(-100.0, 300.0, 40.0, 40.0)];
        let scale = scaling(area(0.0, 0.0, 100.0, 100.0), at(50.0, 50.0), 2.18, None);
        let scaled = snap_scale_to_neighbours(scale, &neighbour, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(2.2));
    }

    #[test]
    fn a_scale_lands_no_less_than_its_least() {
        let neighbours = [area(10.0, 300.0, 7.0, 7.0), area(24.0, 300.0, 6.0, 6.0)];
        // From 19 wide, the line at 17 is nearer than the one at 24, but the box may not go
        // under 20.
        let scale = Scale {
            least: 0.2,
            ..scaling(area(0.0, 0.0, 100.0, 100.0), at(0.0, 0.0), 0.19, None)
        };
        let scaled = snap_scale_to_neighbours(scale, &neighbours, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(0.24));
    }

    #[test]
    fn a_stretch_scales_only_its_own_way() {
        let stretching = area(0.0, 0.0, 100.0, 50.0);
        let neighbours = [
            area(150.0, 200.0, 40.0, 40.0),
            area(400.0, 74.0, 10.0, 10.0),
        ];
        let scaled = |along| {
            let scale = scaling(stretching, at(0.0, 0.0), 1.47, along);
            snap_scale_to_neighbours(scale, &neighbours, WINDOW, 1.0)
        };
        // Down, its bottom reaches the second's top sooner.
        assert_eq!(scaled(None).factor, Some(1.48));
        let across = scaled(Some(Axis::Horizontal));
        assert_eq!(across.factor, Some(1.5));
        assert_eq!(across.bridges, [(at(150.0, 200.0), at(150.0, 50.0))]);
        let down = scaled(Some(Axis::Vertical));
        assert_eq!(down.factor, Some(1.48));
        assert_eq!(down.bridges, [(at(400.0, 74.0), at(100.0, 74.0))]);
    }

    #[test]
    fn a_stretch_lands_a_gap_away_from_the_next_one() {
        let row = [
            area(-200.0, 0.0, 60.0, 100.0),
            area(-100.0, 0.0, 60.0, 100.0),
            area(250.0, 0.0, 100.0, 100.0),
        ];
        let along = Some(Axis::Horizontal);
        let scale = scaling(area(0.0, 0.0, 100.0, 100.0), at(0.0, 0.0), 2.07, along);
        let scaled = snap_scale_to_neighbours(scale, &row, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(2.1));
        assert_eq!(
            scaled.gaps,
            [
                (at(-140.0, 50.0), at(-100.0, 50.0)),
                (at(-40.0, 50.0), at(0.0, 50.0)),
                (at(210.0, 50.0), at(250.0, 50.0)),
            ]
        );
    }

    #[test]
    fn a_stretch_lands_a_gap_away_from_the_one_before() {
        let row = [
            area(-300.0, 0.0, 100.0, 100.0),
            area(200.0, 0.0, 60.0, 100.0),
            area(300.0, 0.0, 60.0, 100.0),
        ];
        // Around its right side, its left side moving.
        let along = Some(Axis::Horizontal);
        let scale = scaling(area(0.0, 0.0, 100.0, 100.0), at(100.0, 0.0), 2.63, along);
        let scaled = snap_scale_to_neighbours(scale, &row, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(2.6));
        assert_eq!(
            scaled.gaps,
            [
                (at(-200.0, 50.0), at(-160.0, 50.0)),
                (at(260.0, 50.0), at(300.0, 50.0))
            ]
        );
    }

    #[test]
    fn a_line_wins_over_a_gap_for_a_scale_as_near() {
        let neighbours = [
            area(-200.0, 0.0, 60.0, 100.0),
            area(-100.0, 0.0, 60.0, 100.0),
            area(247.0, 0.0, 100.0, 100.0),
            area(213.0, 300.0, 20.0, 20.0),
        ];
        // 3 short of 40 before the third, and 3 short of the fourth's left side.
        let along = Some(Axis::Horizontal);
        let scale = scaling(area(0.0, 0.0, 100.0, 100.0), at(0.0, 0.0), 2.1, along);
        let scaled = snap_scale_to_neighbours(scale, &neighbours, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(2.13));
    }

    #[test]
    fn a_gap_away_counts_only_with_the_box_in_its_room() {
        let row = [
            area(-100.0, 0.0, 100.0, 100.0),
            area(300.0, 0.0, 100.0, 100.0),
            area(440.0, 0.0, 60.0, 100.0),
        ];
        // Around its middle, its right side would land 40 before the second, but its left side
        // would cover the first.
        let along = Some(Axis::Horizontal);
        let scale = scaling(area(40.0, 0.0, 20.0, 100.0), at(50.0, 50.0), 20.8, along);
        let scaled = snap_scale_to_neighbours(scale, &row, WINDOW, 1.0);
        assert_eq!(scaled, Scaled::default());
    }

    #[test]
    fn only_the_side_a_stretch_moves_shows_what_it_lines_up_with() {
        let neighbours = [
            // A gap alike to the one before the box, and a line on its left side, both kept.
            area(-200.0, 0.0, 60.0, 100.0),
            area(-100.0, 0.0, 60.0, 100.0),
            area(0.0, 300.0, 30.0, 30.0),
            area(250.0, 300.0, 50.0, 50.0),
        ];
        let along = Some(Axis::Horizontal);
        let scale = scaling(area(0.0, 0.0, 100.0, 100.0), at(0.0, 0.0), 2.47, along);
        let scaled = snap_scale_to_neighbours(scale, &neighbours, WINDOW, 1.0);
        assert_eq!(scaled.factor, Some(2.5));
        assert_eq!(scaled.bridges, [(at(250.0, 300.0), at(250.0, 100.0))]);
        assert!(scaled.gaps.is_empty());
    }

    #[test]
    fn both_corners_of_what_is_drawn_land_on_a_neighbours_lines() {
        let neighbour = [area(100.0, 300.0, 50.0, 50.0)];
        let drawn = |from, to| snap_drawn_to_neighbours(from, to, &neighbour, WINDOW, 1.0, false);
        let right = drawn(at(97.0, 0.0), at(147.0, 40.0));
        assert_eq!((right.from, right.to), (at(100.0, 0.0), at(150.0, 40.0)));
        let both = [
            (at(100.0, 300.0), at(100.0, 40.0)),
            (at(150.0, 300.0), at(150.0, 40.0)),
        ];
        assert_eq!(right.bridges, both);
        let left = drawn(at(150.0, 0.0), at(103.0, 40.0));
        assert_eq!((left.from, left.to), (at(150.0, 0.0), at(100.0, 40.0)));
        assert_eq!(left.bridges, both);
    }

    #[test]
    fn what_is_drawn_ends_a_gap_away_from_the_next_one() {
        let row = [
            area(-200.0, 0.0, 60.0, 100.0),
            area(-100.0, 0.0, 60.0, 100.0),
            area(250.0, 0.0, 100.0, 100.0),
        ];
        let drawn =
            snap_drawn_to_neighbours(at(0.0, 0.0), at(207.0, 100.0), &row, WINDOW, 1.0, false);
        assert_eq!(drawn.to, at(210.0, 100.0));
        assert_eq!(
            drawn.gaps,
            [
                (at(-140.0, 50.0), at(-100.0, 50.0)),
                (at(-40.0, 50.0), at(0.0, 50.0)),
                (at(210.0, 50.0), at(250.0, 50.0)),
            ]
        );
    }

    #[test]
    fn what_is_drawn_lands_on_the_grid_where_no_neighbour_pulls() {
        let drawn = snap_drawn_to_neighbours(at(3.0, 4.0), at(57.0, 61.0), &[], WINDOW, 1.0, true);
        assert_eq!((drawn.from, drawn.to), (at(0.0, 0.0), at(60.0, 60.0)));
        assert!(drawn.bridges.is_empty() && drawn.gaps.is_empty());
    }

    #[test]
    fn what_is_drawn_lands_down_as_across() {
        // Below, the first pulls it across, and beside it, the second down.
        let neighbours = [area(100.0, 300.0, 50.0, 50.0), area(300.0, 0.0, 50.0, 80.0)];
        let drawn = snap_drawn_to_neighbours(
            at(97.0, 3.0),
            at(147.0, 77.0),
            &neighbours,
            WINDOW,
            1.0,
            false,
        );
        assert_eq!((drawn.from, drawn.to), (at(100.0, 0.0), at(150.0, 80.0)));
        assert!(drawn.bridges.contains(&(at(300.0, 0.0), at(150.0, 0.0))));
        assert!(drawn.bridges.contains(&(at(300.0, 80.0), at(150.0, 80.0))));
    }

    #[test]
    fn what_is_drawn_back_to_where_it_started_lands_there() {
        // A gutter of 10 between two, the start on the right one's left side.
        let neighbours = [
            area(190.0, 0.0, 100.0, 100.0),
            area(300.0, 0.0, 100.0, 100.0),
        ];
        let drawn = snap_drawn_to_neighbours(
            at(296.0, 50.0),
            at(296.0, 50.0),
            &neighbours,
            WINDOW,
            1.0,
            false,
        );
        assert_eq!(drawn.from, drawn.to);
    }

    #[test]
    fn what_is_drawn_never_ends_behind_where_it_started() {
        // Zoomed out, the grid's lines 100 apart pull from 20 away, and one lies just behind, but
        // the line it started on is nearer.
        let neighbour = [area(303.0, 200.0, 50.0, 50.0)];
        let drawn = snap_drawn_to_neighbours(
            at(285.0, 0.0),
            at(306.0, 0.0),
            &neighbour,
            WINDOW,
            0.4,
            true,
        );
        assert_eq!((drawn.from.x, drawn.to.x), (303.0, 303.0));
    }

    #[test]
    fn what_is_drawn_thin_keeps_its_size_with_nothing_beside_it() {
        let alone = snap_drawn_to_neighbours(at(0.0, 0.0), at(300.0, 6.0), &[], WINDOW, 1.0, false);
        assert_eq!(alone.to, at(300.0, 6.0));
        // Out of the reach of the grid's lines, which pull from 5 away at a zoom of 1.
        let gridded =
            snap_drawn_to_neighbours(at(3.0, 4.0), at(57.0, 11.0), &[], WINDOW, 1.0, true);
        assert_eq!((gridded.from, gridded.to), (at(0.0, 0.0), at(60.0, 11.0)));
    }

    #[test]
    fn neighbours_are_what_stays_put_at_the_level_of_the_selection() {
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 100.0, 50.0, 0.0))),
            (2, element(None, "a1", image(200.0, 0.0, 100.0, 50.0, 0.0))),
            // Turned a quarter, its upright box is as tall as it is wide.
            (3, element(None, "a2", image(400.0, 0.0, 100.0, 50.0, 90.0))),
            (4, element(None, "a3", ElementKind::group())),
            (
                5,
                element(Some(4), "a0", image(0.0, 300.0, 10.0, 10.0, 0.0)),
            ),
            (
                6,
                element(Some(4), "a1", image(90.0, 390.0, 10.0, 10.0, 0.0)),
            ),
            (7, element(None, "a4", ElementKind::group())),
        ]);
        assert_areas(
            board.neighbours(&[id(1)], None),
            &[
                area(0.0, 300.0, 100.0, 100.0),
                area(200.0, 0.0, 100.0, 50.0),
                area(425.0, -25.0, 50.0, 100.0),
            ],
        );
        let inside = board.neighbours(&[id(5)], Some(id(4)));
        assert_eq!(inside, [area(90.0, 390.0, 10.0, 10.0)]);
        let grouped = board.neighbours(&[id(4)], None);
        assert_eq!(grouped.len(), 3);
        assert!(!grouped.contains(&area(0.0, 300.0, 100.0, 100.0)));
    }

    #[test]
    fn what_follows_a_moved_element_is_no_neighbour() {
        let mut stuck = stroke();
        if let ElementKind::Stroke { target, .. } = &mut stuck {
            *target = Some(id(1));
        }
        let mut tied = arrow();
        if let ElementKind::Arrow { from_target, .. } = &mut tied {
            *from_target = Some(id(2));
        }
        let board = board([
            (1, element(None, "a0", image(0.0, 0.0, 100.0, 50.0, 0.0))),
            (2, element(None, "a1", stuck)),
            (3, element(None, "a2", tied)),
            (4, element(None, "a3", ElementKind::group())),
            (
                5,
                element(Some(4), "a0", image(500.0, 0.0, 10.0, 10.0, 0.0)),
            ),
            (6, element(None, "a4", image(900.0, 0.0, 10.0, 10.0, 0.0))),
        ]);
        assert_eq!(board.neighbours(&[id(1)], None).len(), 2);
        assert_eq!(
            board.neighbours(&[id(1), id(4)], None),
            [area(900.0, 0.0, 10.0, 10.0)]
        );
    }

    /// In any order, and as near as turning leaves them.
    fn assert_areas(mut found: Vec<Rect>, expected: &[Rect]) {
        found.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
        let near = |a: &Rect, b: &Rect| {
            [a.x - b.x, a.y - b.y, a.width - b.width, a.height - b.height]
                .iter()
                .all(|off| off.abs() < 1e-9)
        };
        assert!(
            found.len() == expected.len() && found.iter().zip(expected).all(|(a, b)| near(a, b)),
            "{found:?} is not {expected:?}"
        );
    }
}
