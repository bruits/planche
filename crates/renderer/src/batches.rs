//! How the items placed on the board batch into draws. Strokes one after the other draw at once,
//! as each draw rebinds the instances on WebGL2.

use std::ops::Range;

pub const IMAGE: f32 = 0.0;
pub const STROKE: f32 = 1.0;
pub const TEXT: f32 = 2.0;
/// The lines of a see-through pen stroke, which together cover each pixel once, as the
/// `fs_clear`, `fs_cover`, and `fs_once` of the renderer's strokes draw them.
pub const ONCE: f32 = 3.0;

/// What drawing an item takes besides its instance.
#[derive(Clone, Copy)]
pub struct Item {
    pub kind: f32,
    /// The texture's slot, or -1 for a stroke.
    pub texture: f32,
    /// Which stroke a line of a see-through pen stroke belongs to.
    pub stroke: f32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Batch {
    Strokes(Range<u32>),
    Once(Range<u32>),
    Image { at: u32, texture: usize },
    Text { at: u32, texture: usize },
}

pub fn batches<'a>(
    items: &'a [Item],
    uploaded: impl Fn(usize) -> bool + 'a,
) -> impl Iterator<Item = Batch> + 'a {
    let mut at = 0;
    std::iter::from_fn(move || {
        while at < items.len() {
            let Item {
                kind,
                texture,
                stroke,
            } = items[at];
            let start = at;
            let drawn = |run: usize| start as u32..(start + run) as u32;
            if kind == ONCE {
                let run = run(&items[at..], |item| {
                    item.kind == ONCE && item.stroke == stroke
                });
                at += run;
                return Some(Batch::Once(drawn(run)));
            }
            if kind == STROKE {
                let run = run(&items[at..], |item| item.kind == STROKE);
                at += run;
                return Some(Batch::Strokes(drawn(run)));
            }
            at += 1;
            // -1 and NaN name no slot, which a cast would take for 0.
            let slot = (texture >= 0.0)
                .then_some(texture as usize)
                .filter(|&slot| uploaded(slot));
            let at = start as u32;
            match slot {
                Some(texture) if kind == IMAGE => return Some(Batch::Image { at, texture }),
                Some(texture) if kind == TEXT => return Some(Batch::Text { at, texture }),
                _ => {}
            }
        }
        None
    })
}

fn run(items: &[Item], alike: impl Fn(&Item) -> bool) -> usize {
    items.iter().take_while(|item| alike(item)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: f32, texture: f32) -> Item {
        Item {
            kind,
            texture,
            stroke: 0.0,
        }
    }

    fn stroke() -> Item {
        item(STROKE, -1.0)
    }

    fn line_of(stroke: f32) -> Item {
        Item {
            kind: ONCE,
            texture: -1.0,
            stroke,
        }
    }

    fn all(_: usize) -> bool {
        true
    }

    fn drawn(items: &[Item], uploaded: impl Fn(usize) -> bool) -> Vec<Batch> {
        batches(items, uploaded).collect()
    }

    #[test]
    fn strokes_one_after_the_other_draw_at_once_until_another_kind_comes() {
        let items = [stroke(), stroke(), item(IMAGE, 0.0), stroke()];
        assert_eq!(
            drawn(&items, all),
            [
                Batch::Strokes(0..2),
                Batch::Image { at: 2, texture: 0 },
                Batch::Strokes(3..4),
            ]
        );
        assert!(drawn(&[], all).is_empty());
    }

    #[test]
    fn each_image_and_text_draws_alone_with_its_texture() {
        let items = [item(IMAGE, 1.0), item(IMAGE, 1.0), item(TEXT, 2.0)];
        assert_eq!(
            drawn(&items, all),
            [
                Batch::Image { at: 0, texture: 1 },
                Batch::Image { at: 1, texture: 1 },
                Batch::Text { at: 2, texture: 2 },
            ]
        );
    }

    #[test]
    fn the_lines_of_a_see_through_stroke_draw_once_apart_from_the_next_one() {
        let items = [stroke(), line_of(0.0), line_of(0.0), line_of(1.0), stroke()];
        assert_eq!(
            drawn(&items, |_| false),
            [
                Batch::Strokes(0..1),
                Batch::Once(1..3),
                Batch::Once(3..4),
                Batch::Strokes(4..5),
            ]
        );
    }

    #[test]
    fn what_lacks_its_texture_or_a_kind_is_left_out_where_it_stands() {
        let uploaded = |slot| slot != 4;
        let items = [
            stroke(),
            item(IMAGE, 4.0),
            stroke(),
            item(TEXT, 4.0),
            item(9.0, 0.0),
            item(IMAGE, 0.0),
        ];
        assert_eq!(
            drawn(&items, uploaded),
            [
                Batch::Strokes(0..1),
                Batch::Strokes(2..3),
                Batch::Image { at: 5, texture: 0 },
            ]
        );
    }

    #[test]
    fn no_slot_stands_for_a_texture_of_minus_one_or_nan() {
        let items = [item(IMAGE, -1.0), item(TEXT, f32::NAN), item(IMAGE, 0.0)];
        assert_eq!(drawn(&items, all), [Batch::Image { at: 2, texture: 0 }]);
    }
}
