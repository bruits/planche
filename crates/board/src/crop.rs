//! Cropping an image keeps each pixel it still shows where it was, at the same size, however the
//! image is turned or flipped, so that cropping looks like hiding what lies outside.

use crate::stick::Surface;
use crate::{Board, ElementId, ElementKind, Point, Rect};

impl Board {
    /// The pixel of the image `id` at `point`, as displayed and whether it shows or is cropped
    /// out. `None` when there is no such image.
    pub fn pixel_at(&self, id: ElementId, point: Point) -> Option<Point> {
        surface(self, id)?.to_content(point, false)
    }

    /// Where the pixel of the image `id` lies, as [`Board::pixel_at`] gives it.
    pub fn point_of_pixel(&self, id: ElementId, pixel: Point) -> Option<Point> {
        surface(self, id)?.to_board(pixel, false)
    }
}

fn surface(board: &Board, id: ElementId) -> Option<Surface> {
    let kind = &board.elements.get(&id)?.kind;
    matches!(kind, ElementKind::Image { .. })
        .then(|| Surface::of(kind))
        .flatten()
}

/// The image showing `area` of its pixels, or the whole of them. `None` when it is not an image,
/// or `area` does not lie within it.
pub(crate) fn cropped(kind: &ElementKind, area: Option<Rect>) -> Option<ElementKind> {
    let ElementKind::Image {
        natural_size,
        frame,
        edits,
        ..
    } = kind
    else {
        return None;
    };
    let whole = Rect {
        x: 0.0,
        y: 0.0,
        width: natural_size.width.into(),
        height: natural_size.height.into(),
    };
    let area = area.unwrap_or(whole);
    let shown = edits.crop.unwrap_or(whole);
    if !(area.is_finite() && area.width > 0.0 && area.height > 0.0)
        || area.x < 0.0
        || area.y < 0.0
        || area.x + area.width > whole.width
        || area.y + area.height > whole.height
    {
        return None;
    }
    // Recomputed, the frame would come out a hair off.
    if area == shown {
        return Some(kind.clone());
    }
    let centre = Surface::of(kind)?.to_board(area.centre(), false)?;
    let width = area.width * frame.width / shown.width;
    let height = area.height * frame.height / shown.height;
    let mut kind = kind.clone();
    if let ElementKind::Image { frame, edits, .. } = &mut kind {
        *frame = Rect {
            x: centre.x - width / 2.0,
            y: centre.y - height / 2.0,
            width,
            height,
        };
        edits.crop = (area != whole).then_some(area);
    }
    Some(kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{board, element, id};
    use crate::{AssetId, Colour, CropShape, Editor, Error, ImageEdits, Size, Text};

    fn area(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn image(rotation: f64, flip_horizontal: bool, flip_vertical: bool) -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(b""),
            natural_size: Size {
                width: 200,
                height: 100,
            },
            frame: area(10.0, 20.0, 400.0, 200.0),
            rotation,
            edits: ImageEdits {
                flip_horizontal,
                flip_vertical,
                ..ImageEdits::default()
            },
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn editor(kinds: impl IntoIterator<Item = ElementKind>) -> Editor {
        let elements = kinds
            .into_iter()
            .zip(1..)
            .map(|(kind, bits)| (bits, element(None, &format!("a{bits}"), kind)));
        Editor::new(board(elements))
    }

    fn edits_of(editor: &Editor) -> ImageEdits {
        match &editor.board().elements[&id(1)].kind {
            ElementKind::Image { edits, .. } => *edits,
            _ => unreachable!(),
        }
    }

    fn crop_of(editor: &Editor) -> Option<Rect> {
        edits_of(editor).crop
    }

    fn assert_near(a: Point, b: Point) {
        assert!(
            (a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9,
            "{a:?} != {b:?}"
        );
    }

    #[test]
    fn cropping_keeps_each_pixel_it_still_shows_where_it_was_however_turned_or_flipped() {
        let pixels =
            [(60.0, 30.0), (149.0, 79.0), (100.0, 50.0), (60.0, 79.0)].map(|(x, y)| Point { x, y });
        for rotation in [0.0, 90.0, 30.0] {
            for (horizontally, vertically) in
                [(false, false), (true, false), (false, true), (true, true)]
            {
                let mut editor = editor([image(rotation, horizontally, vertically)]);
                let at = |editor: &Editor| {
                    pixels.map(|pixel| editor.board().point_of_pixel(id(1), pixel).unwrap())
                };
                let before = at(&editor);

                editor.crop(id(1), area(50.0, 20.0, 100.0, 60.0)).unwrap();
                let cropped = at(&editor);
                editor.crop(id(1), area(40.0, 10.0, 150.0, 80.0)).unwrap();
                let widened = at(&editor);
                editor.reset_crop(&[id(1)]).unwrap();

                for points in [cropped, widened, at(&editor)] {
                    points
                        .into_iter()
                        .zip(before)
                        .for_each(|(after, before)| assert_near(after, before));
                }
                assert_eq!(crop_of(&editor), None);
            }
        }
    }

    #[test]
    fn cropping_keeps_each_pixel_where_it_was_on_a_turned_stretched_image() {
        let mut stretched = image(30.0, true, false);
        if let ElementKind::Image { frame, .. } = &mut stretched {
            *frame = area(10.0, 20.0, 400.0, 300.0);
        }
        let pixels =
            [(60.0, 30.0), (149.0, 79.0), (100.0, 50.0), (60.0, 79.0)].map(|(x, y)| Point { x, y });
        let mut editor = editor([stretched]);
        let at = |editor: &Editor| {
            pixels.map(|pixel| editor.board().point_of_pixel(id(1), pixel).unwrap())
        };
        let before = at(&editor);

        editor.crop(id(1), area(50.0, 20.0, 100.0, 60.0)).unwrap();
        let cropped = at(&editor);
        editor.crop(id(1), area(40.0, 10.0, 150.0, 80.0)).unwrap();
        let widened = at(&editor);
        editor.reset_crop(&[id(1)]).unwrap();

        for points in [cropped, widened, at(&editor)] {
            points
                .into_iter()
                .zip(before)
                .for_each(|(after, before)| assert_near(after, before));
        }
    }

    #[test]
    fn a_crop_keeps_the_size_each_pixel_shows_at() {
        let mut editor = editor([image(0.0, false, false)]);

        editor.crop(id(1), area(50.0, 20.0, 100.0, 60.0)).unwrap();

        let ElementKind::Image { frame, .. } = &editor.board().elements[&id(1)].kind else {
            unreachable!()
        };
        assert_eq!(*frame, area(110.0, 60.0, 200.0, 120.0));
    }

    #[test]
    fn a_point_and_its_pixel_lead_back_to_each_other() {
        let editor = editor([image(30.0, true, false)]);
        let point = Point { x: 150.0, y: 90.0 };

        let pixel = editor.board().pixel_at(id(1), point).unwrap();

        assert_near(editor.board().point_of_pixel(id(1), pixel).unwrap(), point);
    }

    #[test]
    fn what_is_no_image_has_no_pixels() {
        let note = ElementKind::Note {
            frame: area(0.0, 0.0, 10.0, 10.0),
            rotation: 0.0,
            text: Text::new("Note".to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let editor = editor([note]);
        let point = Point { x: 5.0, y: 5.0 };

        assert_eq!(editor.board().pixel_at(id(1), point), None);
        assert_eq!(editor.board().point_of_pixel(id(1), point), None);
        assert_eq!(editor.board().pixel_at(id(2), point), None);
    }

    #[test]
    fn resetting_the_crop_of_a_group_shows_the_whole_of_its_images() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", image(30.0, true, false))),
        ]));
        editor.crop(id(2), area(50.0, 20.0, 100.0, 60.0)).unwrap();
        let before = editor
            .board()
            .point_of_pixel(id(2), Point { x: 60.0, y: 30.0 });

        editor.reset_crop(&[id(1)]).unwrap();

        let ElementKind::Image { edits, .. } = &editor.board().elements[&id(2)].kind else {
            unreachable!()
        };
        assert_eq!(edits.crop, None);
        assert_near(
            editor
                .board()
                .point_of_pixel(id(2), Point { x: 60.0, y: 30.0 })
                .unwrap(),
            before.unwrap(),
        );
    }

    #[test]
    fn resetting_the_crop_shows_the_whole_image_as_a_rectangle() {
        let mut editor = editor([image(0.0, false, false)]);
        editor.crop(id(1), area(50.0, 20.0, 100.0, 60.0)).unwrap();
        editor.set_crop_shape(&[id(1)], CropShape::Ellipse).unwrap();

        editor.reset_crop(&[id(1)]).unwrap();

        assert_eq!(edits_of(&editor).crop, None);
        assert_eq!(edits_of(&editor).crop_shape, CropShape::Rectangle);
        editor.undo();
        assert_eq!(edits_of(&editor).crop, Some(area(50.0, 20.0, 100.0, 60.0)));
        assert_eq!(edits_of(&editor).crop_shape, CropShape::Ellipse);
    }

    #[test]
    fn the_crop_shape_applies_to_the_images_of_a_group_in_one_step() {
        let mut editor = Editor::new(board([
            (1, element(None, "a0", ElementKind::Group)),
            (2, element(Some(1), "a0", image(30.0, true, false))),
            (3, element(Some(1), "a1", image(0.0, false, false))),
        ]));
        let shapes = |editor: &Editor| {
            [2, 3].map(|bits| match &editor.board().elements[&id(bits)].kind {
                ElementKind::Image { edits, .. } => edits.crop_shape,
                _ => unreachable!(),
            })
        };

        assert_eq!(
            editor.set_crop_shape(&[id(1)], CropShape::Ellipse).unwrap(),
            [id(2), id(3)]
        );

        assert_eq!(shapes(&editor), [CropShape::Ellipse; 2]);
        editor.undo();
        assert_eq!(shapes(&editor), [CropShape::Rectangle; 2]);
    }

    #[test]
    fn cropping_to_the_whole_image_keeps_no_crop() {
        let mut editor = editor([image(0.0, false, false)]);
        editor.crop(id(1), area(50.0, 20.0, 100.0, 60.0)).unwrap();

        editor.crop(id(1), area(0.0, 0.0, 200.0, 100.0)).unwrap();

        assert_eq!(crop_of(&editor), None);
    }

    #[test]
    fn a_crop_beyond_the_image_or_of_what_is_no_image_is_refused() {
        let note = ElementKind::Note {
            frame: area(0.0, 0.0, 10.0, 10.0),
            rotation: 0.0,
            text: Text::new("Note".to_owned(), 20.0),
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let mut editor = editor([image(0.0, false, false), note]);
        let before = editor.board().clone();

        for refused in [
            area(-1.0, 0.0, 10.0, 10.0),
            area(150.0, 0.0, 60.0, 10.0),
            area(0.0, 0.0, 0.0, 10.0),
            area(0.0, f64::NAN, 10.0, 10.0),
        ] {
            assert_eq!(
                editor.crop(id(1), refused),
                Err(Error::OutsideImage {
                    id: id(1),
                    width: 200,
                    height: 100
                })
            );
        }
        assert_eq!(
            editor.crop(id(2), area(0.0, 0.0, 1.0, 1.0)),
            Err(Error::NotAnImage(id(2)))
        );
        assert_eq!(editor.board(), &before);
    }

    #[test]
    fn what_sticks_to_an_image_keeps_its_pixel_as_it_is_cropped() {
        let note = ElementKind::Note {
            frame: area(150.0, 80.0, 40.0, 20.0),
            rotation: 0.0,
            text: Text::new("Note".to_owned(), 20.0),
            target: Some(id(1)),
            colour: Colour::Ink,
            opacity: Default::default(),
        };
        let mut editor = editor([image(30.0, true, false), note]);
        let centre = |editor: &Editor| match &editor.board().elements[&id(2)].kind {
            ElementKind::Note { frame, .. } => frame.centre(),
            _ => unreachable!(),
        };
        let pixel = editor.board().pixel_at(id(1), centre(&editor)).unwrap();

        editor.crop(id(1), area(40.0, 10.0, 150.0, 80.0)).unwrap();

        assert_near(
            editor.board().pixel_at(id(1), centre(&editor)).unwrap(),
            pixel,
        );
    }
}
