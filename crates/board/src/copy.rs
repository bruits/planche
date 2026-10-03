//! Elements copied out of a board, to paste into it or another one, as [`crate::Editor::paste`]
//! does.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{AssetId, Board, Element, ElementId, ZIndex, with_emptied};

/// Elements with all that their groups hold, which stick to nothing outside them. The outermost
/// ones lie at the top level, and each level stacks as the board drew it, on keys of its own, so
/// that new ids cannot break a tie between them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Copied {
    #[cfg_attr(feature = "ts", ts(type = "Record<string, Element>"))]
    pub elements: BTreeMap<ElementId, Element>,
}

impl Copied {
    /// Without the images whose assets `assets` leaves out, nor the groups that empties.
    pub fn keeping(&self, assets: &BTreeSet<AssetId>) -> Self {
        let lost = self
            .elements
            .iter()
            .filter(|(_, element)| {
                element
                    .kind
                    .asset()
                    .is_some_and(|asset| !assets.contains(&asset))
            })
            .map(|(id, _)| *id)
            .collect();
        let removed = with_emptied(&self.elements, lost);
        let elements = self
            .elements
            .iter()
            .filter(|(id, _)| !removed.contains(id))
            .map(|(id, element)| (*id, element.clone()))
            .collect();
        Self { elements }
    }
}

impl Board {
    /// Unknown ids are left out.
    pub fn copy(&self, ids: &[ElementId]) -> Copied {
        let taken = self.with_descendants(ids);
        let mut elements: BTreeMap<ElementId, Element> = taken
            .iter()
            .map(|id| (*id, self.elements[id].clone()))
            .collect();
        for element in elements.values_mut() {
            for target in element.kind.targets_mut() {
                target.take_if(|target| !taken.contains(target));
            }
        }
        let mut tops: BTreeMap<Option<ElementId>, ZIndex> = BTreeMap::new();
        for id in self.draw_order() {
            let Some(element) = elements.get_mut(&id) else {
                continue;
            };
            let group = element.group.filter(|group| taken.contains(group));
            let z = ZIndex::between(tops.get(&group), None).expect("nothing lies above");
            element.group = group;
            element.z.clone_from(&z);
            tops.insert(group, z);
        }
        Copied { elements }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{arrow, board, element, id, z};
    use crate::{Colour, ElementKind, ImageEdits, Rect, Size, Text};

    fn note() -> ElementKind {
        ElementKind::Note {
            frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            rotation: 0.0,
            text: Text::new(String::new(), 2.0),
            target: None,
            colour: Colour::Ink,
        }
    }

    #[test]
    fn a_copy_holds_what_its_groups_hold_its_outermost_elements_stacked_at_the_top_level() {
        let board = board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", ElementKind::Group)),
            (3, element(Some(2), "a5", arrow())),
            (4, element(Some(1), "a0", arrow())),
            (5, element(None, "a3", arrow())),
            (6, element(Some(7), "a0", arrow())),
            (7, element(None, "a2", ElementKind::Group)),
            (8, element(None, "a4", arrow())),
        ]);
        let copied = board.copy(&[5, 1, 6, 9].map(id));
        let shown: Vec<(ElementId, Option<ElementId>, ZIndex)> = copied
            .elements
            .iter()
            .map(|(id, element)| (*id, element.group, element.z.clone()))
            .collect();
        let expected = [
            // 1 below 6, and 6 below 5, as the board draws them, whatever their groups, and 2
            // below 4, which shared its key.
            (1, None, "a0"),
            (2, Some(1), "a0"),
            (3, Some(2), "a0"),
            (4, Some(1), "a1"),
            (5, None, "a2"),
            (6, None, "a1"),
        ]
        .map(|(element, group, key)| (id(element), group.map(id), z(key)));
        assert_eq!(shown, expected);
    }

    #[test]
    fn keeping_assets_leaves_out_other_images_and_the_groups_that_empties() {
        let image = |bytes: &[u8]| ElementKind::Image {
            asset: AssetId::of(bytes),
            natural_size: Size {
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
            edits: ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
        };
        let copied = Copied {
            elements: board([
                (1, element(None, "a0", ElementKind::Group)),
                (2, element(Some(1), "a0", ElementKind::Group)),
                (3, element(Some(2), "a0", image(b"lost"))),
                (4, element(Some(1), "a1", image(b"kept"))),
                (5, element(None, "a1", ElementKind::Group)),
                (6, element(Some(5), "a0", image(b"lost"))),
                (7, element(None, "a2", ElementKind::Group)),
            ])
            .elements,
        };
        let kept = copied.keeping(&BTreeSet::from([AssetId::of(b"kept")]));
        // 7 held nothing to begin with, so nothing emptied it.
        assert_eq!(
            kept.elements.keys().copied().collect::<Vec<_>>(),
            [1, 4, 7].map(id)
        );
    }

    #[test]
    fn a_copy_lets_go_of_what_it_leaves_out() {
        let mut arrow = arrow();
        for (_, target) in arrow.ends_mut().unwrap() {
            *target = Some(id(1));
        }
        let mut stuck = note();
        *stuck.target_mut().unwrap() = Some(id(3));
        let board = board([
            (1, element(None, "a0", note())),
            (2, element(None, "a1", arrow)),
            (3, element(None, "a2", note())),
            (4, element(None, "a3", stuck.clone())),
        ]);
        let copied = board.copy(&[2, 4].map(id));
        assert!(copied.elements[&id(2)].kind.targets().next().is_none());
        assert_eq!(copied.elements[&id(4)].kind.target(), None);
        assert_eq!(board.copy(&[3, 4].map(id)).elements[&id(4)].kind, stuck);
    }
}
