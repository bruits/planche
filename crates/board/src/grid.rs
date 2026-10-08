//! The grid a board may show behind its elements, and the pull its lines have on what comes
//! near them. Its finest lines are [`GRID_SPACING`] apart, and every [`GRID_STEP`]th is also a
//! line of the next level up, which takes over as zooming out crowds the finer one.

use crate::Point;

/// Between the finest lines, in board units. Every level's is a whole multiple of it, so that
/// a coordinate on a line writes as it reads.
pub const GRID_SPACING: f64 = 40.0;
/// Lines of a level per line of the next one up.
pub const GRID_STEP: f64 = 5.0;
/// The fewest screen pixels between the lines of a level that shows. Denser, the next one up
/// shows instead, and a level only shows in full once twice as far apart.
const DENSEST: f64 = 8.0;
/// How near a line pulls what comes to it, in screen pixels.
pub(crate) const PULL: f64 = 8.0;
/// How far off a line, relative to [`GRID_SPACING`], float arithmetic leaves what it moved or
/// scaled onto it. Far below a pixel at any zoom.
const HAIR: f64 = 1e-9;

/// The finest lines that show at a zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridLevel {
    /// In board units.
    pub spacing: f64,
    /// How much they show, from 0 as they come in to 1. Those of the next level up, every
    /// [`GRID_STEP`]th, show in full.
    pub fade: f64,
}

impl GridLevel {
    /// At `zoom` screen pixels per board unit, which is positive.
    pub fn at(zoom: f64) -> Self {
        let mut spacing = GRID_SPACING;
        // A power would not give whole numbers back.
        while spacing * zoom < DENSEST && spacing.is_finite() {
            spacing *= GRID_STEP;
        }
        let fade = (spacing * zoom - DENSEST) / DENSEST;
        Self {
            spacing,
            fade: fade.clamp(0.0, 1.0),
        }
    }
}

/// How far to move along one axis for the nearest of `values` to land on a line of the grid
/// that shows at `zoom`, when one is near enough. Adding it to that value gives the line
/// exactly, as the two are close.
pub fn snap_to_grid(values: &[f64], zoom: f64) -> Option<f64> {
    let (spacing, reach) = pull(zoom);
    values
        .iter()
        .map(|value| (value / spacing).round() * spacing - value)
        .filter(|nudge| nudge.abs() <= reach)
        .min_by(|a, b| a.abs().total_cmp(&b.abs()))
}

/// The factor near `factor` that scales `corner` around `origin` onto a line of the grid that
/// shows at `zoom`, one way or the other, when one is near enough. The corner keeps to the
/// diagonal, so landing on a line one way moves it the other way too. The line it moves the
/// least to reach wins, and none that would move it further either way than a line pulls, nor
/// onto or past the origin's own line.
pub fn snap_scale_to_grid(origin: Point, corner: Point, factor: f64, zoom: f64) -> Option<f64> {
    let (_, reach) = pull(zoom);
    let longest = (corner.x - origin.x).abs().max((corner.y - origin.y).abs());
    [(origin.x, corner.x), (origin.y, corner.y)]
        .into_iter()
        .filter(|(from, to)| from != to)
        .filter_map(|(from, to)| {
            let moved = from + (to - from) * factor;
            let nudge = snap_to_grid(&[moved], zoom)?;
            Some((moved + nudge - from) / (to - from))
        })
        .filter(|snapped| *snapped > 0.0 && (snapped - factor).abs() * longest <= reach)
        .min_by(|a, b| (a - factor).abs().total_cmp(&(b - factor).abs()))
}

/// `point` with each coordinate on a line of the grid that shows at `zoom`, when one is near
/// enough.
pub(crate) fn pulled(point: Point, zoom: f64) -> Point {
    let onto = |value: f64| value + snap_to_grid(&[value], zoom).unwrap_or(0.0);
    Point {
        x: onto(point.x),
        y: onto(point.y),
    }
}

/// `at`, at a multiple of 45° around `around`, moved along its way exactly onto the nearest line
/// of the grid that shows at `zoom`, short of `around`'s own lines, and kept exactly at its
/// angle.
pub(crate) fn pulled_along(at: Point, around: Point, zoom: f64) -> Point {
    let (way_x, way_y) = (sign(at.x - around.x), sign(at.y - around.y));
    let nudge = |value: f64, from: f64, way: f64| {
        snap_to_grid(&[value], zoom)
            .filter(|nudge| way != 0.0 && (value + nudge - from) * way > 0.0)
    };
    match (nudge(at.x, around.x, way_x), nudge(at.y, around.y, way_y)) {
        (Some(x), y) if y.is_none_or(|y| x.abs() <= y.abs()) => {
            let x = at.x + x;
            Point {
                x,
                y: if way_y == 0.0 {
                    at.y
                } else {
                    around.y + way_y * (x - around.x).abs()
                },
            }
        }
        (_, Some(y)) => {
            let y = at.y + y;
            Point {
                x: if way_x == 0.0 {
                    at.x
                } else {
                    around.x + way_x * (y - around.y).abs()
                },
                y,
            }
        }
        _ => at,
    }
}

/// -1, 0, or 1, where [`f64::signum`] gives 1 for 0.
fn sign(value: f64) -> f64 {
    if value == 0.0 { 0.0 } else { value.signum() }
}

/// How far apart the lines that pull at `zoom` are, and how far they reach, in board units.
fn pull(zoom: f64) -> (f64, f64) {
    let GridLevel { spacing, fade } = GridLevel::at(zoom);
    // Only lines that show in full pull, as a pull toward lines that barely show looks like none.
    let spacing = if fade < 1.0 {
        spacing * GRID_STEP
    } else {
        spacing
    };
    // A pull reaching halfway to the next line would leave no place free of it.
    (spacing, PULL.min(spacing * zoom / 4.0) / zoom)
}

pub(crate) fn settled(value: f64) -> f64 {
    let line = (value / GRID_SPACING).round() * GRID_SPACING;
    if (value - line).abs() <= GRID_SPACING * HAIR {
        line
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_level_gives_way_before_its_lines_crowd_together() {
        assert_eq!(
            GridLevel::at(0.3),
            GridLevel {
                spacing: 40.0,
                fade: 0.5
            }
        );
        assert_eq!(GridLevel::at(0.4).fade, 1.0);
        assert_eq!(GridLevel::at(100.0).spacing, 40.0);
        assert_eq!(GridLevel::at(100.0).fade, 1.0);
        assert_eq!(GridLevel::at(0.2).fade, 0.0);
        assert_eq!(GridLevel::at(0.19).spacing, 200.0);
        assert_eq!(GridLevel::at(0.005).spacing, 5000.0);
        for zoom in [0.005, 0.0065, 0.05, 0.19, 0.2, 1.0, 3.7, 100.0] {
            let GridLevel { spacing, fade } = GridLevel::at(zoom);
            assert!(spacing * zoom >= DENSEST, "{zoom}");
            assert_eq!(spacing % GRID_SPACING, 0.0, "{zoom}");
            assert!((0.0..=1.0).contains(&fade), "{zoom}");
        }
    }

    #[test]
    fn levels_take_over_from_each_other_unseen() {
        let crowded = GridLevel::at(0.2);
        let zoomed_out = GridLevel::at(0.2 * (1.0 - 1e-9));
        assert_eq!(crowded.fade, 0.0);
        assert_eq!(zoomed_out.spacing, crowded.spacing * GRID_STEP);
        assert!(zoomed_out.fade > 1.0 - 1e-6);
    }

    #[test]
    fn the_nearest_value_within_reach_lands_on_its_line() {
        // 8 screen pixels at a zoom of 2 are 4 board units.
        assert_eq!(snap_to_grid(&[83.0], 2.0), Some(-3.0));
        assert_eq!(snap_to_grid(&[76.5], 2.0), Some(3.5));
        assert_eq!(snap_to_grid(&[85.0], 2.0), None);
        assert_eq!(snap_to_grid(&[85.0, 118.0, 151.0], 2.0), Some(2.0));
        assert_eq!(snap_to_grid(&[], 2.0), None);
    }

    #[test]
    fn crowded_lines_pull_from_less_far() {
        // 16 pixels apart at a zoom of 0.4, and a pull of 8 would reach everywhere.
        assert_eq!(snap_to_grid(&[89.0], 0.4), Some(-9.0));
        assert_eq!(snap_to_grid(&[91.0], 0.4), None);
        // Zoomed out further, the next level's lines are the ones that pull.
        assert_eq!(snap_to_grid(&[1180.0], 0.1), Some(20.0));
    }

    #[test]
    fn faint_lines_leave_the_pull_to_the_next_level() {
        // At a zoom of 0.2, the lines 40 apart have faded out, and those 200 apart show in full.
        assert_eq!(snap_to_grid(&[82.0], 0.2), None);
        assert_eq!(snap_to_grid(&[190.0], 0.2), Some(10.0));
        // At 0.3, the lines 40 apart show by half, which is not enough to pull.
        assert_eq!(snap_to_grid(&[82.0], 0.3), None);
        assert_eq!(snap_to_grid(&[190.0], 0.3), Some(10.0));
    }

    #[test]
    fn a_snapped_value_is_exactly_on_its_line() {
        let mut value: f64 = -4_321.123_456_789;
        while value < 4321.0 {
            for zoom in [0.05, 0.4, 0.5, 1.0, 7.0] {
                if let Some(nudge) = snap_to_grid(&[value], zoom) {
                    assert_eq!((value + nudge) % GRID_SPACING, 0.0, "{value} {zoom}");
                }
            }
            value += 0.618_033_988_7;
        }
    }

    #[test]
    fn a_scaled_corner_lands_on_the_line_it_moves_the_least_to_reach() {
        let at = |x, y| Point { x, y };
        let snapped = snap_scale_to_grid(at(6.0, 14.0), at(206.0, 214.0), 1.0, 0.5).unwrap();
        assert!((snapped - 0.97).abs() < 1e-12, "{snapped}");
        // A line across is 1.2 off and one down 4, but reaching the one down changes the scale less.
        let wide = (at(0.0, 10.0), at(200.0, 50.0));
        assert_eq!(snap_scale_to_grid(wide.0, wide.1, 0.78, 0.5), Some(0.8));
        // A line across is 3.6 off, but landing on it would move the corner 72 along.
        let long = (at(0.0, 0.0), at(800.0, 40.0));
        assert_eq!(snap_scale_to_grid(long.0, long.1, 1.91, 0.5), Some(1.9));
        // A line across within reach would move a thin selection's corner hundreds along.
        let thin = (at(0.0, 26.0), at(1600.0, 32.0));
        assert_eq!(snap_scale_to_grid(thin.0, thin.1, 0.6685, 0.5), None);
        assert_eq!(snap_scale_to_grid(thin.0, thin.1, 0.672, 0.5), Some(0.675));
        // So small on screen that its origin's own line is the nearest, it keeps to the other one.
        let small = (at(-14.0, 3.4), at(186.0, 203.4));
        assert_eq!(
            snap_scale_to_grid(small.0, small.1, 0.01, 0.025),
            Some(0.07)
        );
    }

    #[test]
    fn a_snapped_corner_moves_no_further_than_a_line_pulls() {
        let at = |x, y| Point { x, y };
        for (origin, corner) in [
            (at(0.0, 13.0), at(800.0, 16.0)),
            (at(0.0, 0.0), at(400.0, 20.0)),
            (at(3.0, 7.0), at(-97.0, 107.0)),
            (at(3.0, 7.0), at(3.0, 107.0)),
            (at(3.0, 7.0), at(3.0, 7.0)),
        ] {
            for zoom in [0.05, 0.3, 1.0, 2.5, 7.0] {
                let (_, reach) = pull(zoom);
                let mut factor = 0.01;
                while factor < 12.0 {
                    if let Some(snapped) = snap_scale_to_grid(origin, corner, factor, zoom) {
                        let moved = |from: f64, to: f64| from + (to - from) * snapped;
                        let shift = |from: f64, to: f64| ((to - from) * (snapped - factor)).abs();
                        let on = |from: f64, to: f64| {
                            let line = (moved(from, to) / GRID_SPACING).round() * GRID_SPACING;
                            from != to && (moved(from, to) - line).abs() < 1e-6
                        };
                        let context = format!("{origin:?} {corner:?} {zoom} {factor}");
                        assert!(snapped > 0.0, "{context}");
                        assert!(
                            shift(origin.x, corner.x) <= reach * (1.0 + 1e-9),
                            "{context}"
                        );
                        assert!(
                            shift(origin.y, corner.y) <= reach * (1.0 + 1e-9),
                            "{context}"
                        );
                        assert!(
                            on(origin.x, corner.x) || on(origin.y, corner.y),
                            "{context}"
                        );
                    }
                    factor += 0.001;
                }
            }
        }
    }

    #[test]
    fn only_what_is_a_hair_off_a_line_settles_on_it() {
        assert_eq!(settled(1_799.999_999_999_999_8), 1800.0);
        assert_eq!(settled(440.000_000_000_000_06), 440.0);
        assert_eq!(settled(-80.000_000_000_000_01), -80.0);
        assert_eq!(settled(1_799.9), 1_799.9);
        assert_eq!(settled(17.3), 17.3);
    }
}
