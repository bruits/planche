//! The style of what is drawn, so that a part chosen as it comes writes nothing and the same
//! look always writes the same bytes.

use serde::{Deserialize, Serialize};

use crate::{
    Align, Colour, Corners, Dash, ElementKind, Fill, Heads, Opacity, Paper, Shape, Text, Weight,
};

/// A part of a style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub enum Setting {
    Colour,
    Paper,
    Weight,
    Dash,
    Heads,
    Fill,
    Corners,
    FontSize,
    Bold,
    Italic,
    Strike,
    Align,
    Opacity,
}

/// Parts of a style, each set or not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
pub struct Style {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub colour: Option<Colour>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub paper: Option<Paper>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub weight: Option<Weight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub dash: Option<Dash>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub heads: Option<Heads>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub fill: Option<Fill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub corners: Option<Corners>,
    /// In board units.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub align: Option<Align>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub opacity: Option<Opacity>,
}

const IMAGE: &[Setting] = &[Setting::Opacity];
const NOTE: &[Setting] = &[
    Setting::Colour,
    Setting::FontSize,
    Setting::Bold,
    Setting::Italic,
    Setting::Strike,
    Setting::Align,
    Setting::Opacity,
];
const STICKY: &[Setting] = &[
    Setting::Paper,
    Setting::FontSize,
    Setting::Bold,
    Setting::Italic,
    Setting::Strike,
    Setting::Align,
    Setting::Opacity,
];
const SHAPE: &[Setting] = &[
    Setting::Colour,
    Setting::Weight,
    Setting::Dash,
    Setting::Fill,
    Setting::FontSize,
    Setting::Bold,
    Setting::Italic,
    Setting::Strike,
    Setting::Align,
    Setting::Opacity,
];
/// Of a star or a polygon, which counts its corners.
const POLYGON: &[Setting] = &[
    Setting::Colour,
    Setting::Weight,
    Setting::Dash,
    Setting::Fill,
    Setting::Corners,
    Setting::FontSize,
    Setting::Bold,
    Setting::Italic,
    Setting::Strike,
    Setting::Align,
    Setting::Opacity,
];
const CROSS: &[Setting] = &[
    Setting::Colour,
    Setting::Weight,
    Setting::Dash,
    Setting::FontSize,
    Setting::Bold,
    Setting::Italic,
    Setting::Strike,
    Setting::Align,
    Setting::Opacity,
];
const ARROW: &[Setting] = &[
    Setting::Colour,
    Setting::Weight,
    Setting::Dash,
    Setting::Heads,
    Setting::Opacity,
];
const LINE: &[Setting] = &[
    Setting::Colour,
    Setting::Weight,
    Setting::Dash,
    Setting::Opacity,
];
const STROKE: &[Setting] = &[Setting::Colour, Setting::Weight, Setting::Opacity];

/// How finely a pen stroke's points are kept, in parts of its frame, a hundredth of a board unit
/// across a frame of a thousand.
const POINT_PARTS: f64 = 100_000.0;

impl ElementKind {
    /// The parts of a style it takes, those of its text even while it holds none. A cross fills
    /// nothing, and only a star or a polygon counts its corners.
    pub fn settings(&self) -> &'static [Setting] {
        match self {
            Self::Note { .. } => NOTE,
            Self::Sticky { .. } => STICKY,
            Self::Shape {
                shape: Shape::Cross,
                ..
            } => CROSS,
            Self::Shape { shape, .. } if shape.counts_corners() => POLYGON,
            Self::Shape { .. } => SHAPE,
            Self::Arrow { .. } => ARROW,
            Self::Line { .. } => LINE,
            Self::Stroke { .. } => STROKE,
            Self::Image { .. } => IMAGE,
            Self::Comment { .. } | Self::Group => &[],
        }
    }

    /// Each part of a style it takes as it comes, which its type, and a shape's, alone tell. Its
    /// text has a size of its own, so none.
    pub fn plain_style(&self) -> Style {
        let mut style = Style::default();
        for setting in self.settings() {
            match setting {
                Setting::Colour => style.colour = Some(Colour::default()),
                Setting::Paper => style.paper = Some(Paper::default()),
                Setting::Weight => style.weight = Some(Weight::default()),
                Setting::Dash => style.dash = Some(Dash::default()),
                Setting::Heads => style.heads = Some(Heads::default()),
                Setting::Fill => style.fill = Some(Fill::default()),
                Setting::Corners => style.corners = Some(Corners::default()),
                Setting::FontSize => {}
                Setting::Bold => style.bold = Some(false),
                Setting::Italic => style.italic = Some(false),
                Setting::Strike => style.strike = Some(false),
                Setting::Align => style.align = self.default_align(),
                Setting::Opacity => style.opacity = Some(Opacity::default()),
            }
        }
        style
    }

    /// With each part of `style` that it takes, the others as they were, as it writes them.
    pub fn with_style(mut self, style: &Style) -> Self {
        match &mut self {
            Self::Note { colour, .. } => set(colour, style.colour),
            Self::Sticky { paper, .. } => set(paper, style.paper),
            Self::Shape {
                shape,
                corners,
                colour,
                weight,
                dash,
                fill,
                ..
            } => {
                set(colour, style.colour);
                set(weight, style.weight);
                set(dash, style.dash);
                if *shape != Shape::Cross {
                    set(fill, style.fill);
                }
                if shape.counts_corners() {
                    set(corners, style.corners);
                }
            }
            Self::Arrow {
                colour,
                weight,
                dash,
                heads,
                ..
            } => {
                set(colour, style.colour);
                set(weight, style.weight);
                set(dash, style.dash);
                set(heads, style.heads);
            }
            Self::Line {
                colour,
                weight,
                dash,
                ..
            } => {
                set(colour, style.colour);
                set(weight, style.weight);
                set(dash, style.dash);
            }
            Self::Stroke { colour, weight, .. } => {
                set(colour, style.colour);
                set(weight, style.weight);
            }
            Self::Image { .. } | Self::Comment { .. } | Self::Group => {}
        }
        if let Some(opacity) = self.opacity_mut() {
            set(opacity, style.opacity);
        }
        if let Some(text) = self.text_mut() {
            set(&mut text.font_size, style.font_size);
            set(&mut text.bold, style.bold);
            set(&mut text.italic, style.italic);
            set(&mut text.strike, style.strike);
            if style.align.is_some() {
                text.align = style.align;
            }
        }
        self.canonical()
    }

    /// As it writes, with what it draws as if left as it comes written as such.
    pub fn canonical(mut self) -> Self {
        let chosen = self.default_align();
        if let Some(text) = self.text_mut() {
            text.align.take_if(|align| Some(*align) == chosen);
        }
        if let Self::Shape {
            shape,
            corners,
            fill,
            ..
        } = &mut self
        {
            if *shape == Shape::Cross {
                *fill = Fill::default();
            }
            if !shape.counts_corners() {
                *corners = Corners::default();
            }
        }
        if let Self::Stroke { points, .. } = &mut self {
            for point in points.iter_mut() {
                point.x = (point.x * POINT_PARTS).round() / POINT_PARTS;
                point.y = (point.y * POINT_PARTS).round() / POINT_PARTS;
            }
            points.dedup();
        }
        self
    }

    fn default_align(&self) -> Option<Align> {
        match self {
            Self::Note { .. } | Self::Sticky { .. } => Some(Align::Left),
            Self::Shape { .. } => Some(Align::Centre),
            _ => None,
        }
    }

    pub(crate) fn opacity(&self) -> Option<Opacity> {
        match self {
            Self::Image { opacity, .. }
            | Self::Note { opacity, .. }
            | Self::Sticky { opacity, .. }
            | Self::Shape { opacity, .. }
            | Self::Arrow { opacity, .. }
            | Self::Line { opacity, .. }
            | Self::Stroke { opacity, .. } => Some(*opacity),
            Self::Comment { .. } | Self::Group => None,
        }
    }

    fn opacity_mut(&mut self) -> Option<&mut Opacity> {
        match self {
            Self::Image { opacity, .. }
            | Self::Note { opacity, .. }
            | Self::Sticky { opacity, .. }
            | Self::Shape { opacity, .. }
            | Self::Arrow { opacity, .. }
            | Self::Line { opacity, .. }
            | Self::Stroke { opacity, .. } => Some(opacity),
            Self::Comment { .. } | Self::Group => None,
        }
    }

    fn text_mut(&mut self) -> Option<&mut Text> {
        match self {
            Self::Note { text, .. } | Self::Sticky { text, .. } | Self::Shape { text, .. } => {
                Some(text)
            }
            _ => None,
        }
    }
}

fn set<T>(part: &mut T, to: Option<T>) {
    if let Some(to) = to {
        *part = to;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{arrow, stroke as pen};
    use crate::{AssetId, ImageEdits, Point, Rect, Size, Tip};

    fn frame() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 50.0,
        }
    }

    fn shape(shape: Shape, fill: Fill) -> ElementKind {
        ElementKind::Shape {
            frame: frame(),
            rotation: 0.0,
            shape,
            corners: Default::default(),
            text: Text::new("Hello", 20.0),
            target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            fill,
            opacity: Default::default(),
        }
    }

    fn note(align: Option<Align>) -> ElementKind {
        let mut text = Text::new("Hello", 20.0);
        text.align = align;
        ElementKind::Note {
            frame: frame(),
            rotation: 0.0,
            text,
            target: None,
            colour: Colour::Ink,
            opacity: Default::default(),
        }
    }

    fn sticky() -> ElementKind {
        ElementKind::Sticky {
            frame: frame(),
            rotation: 0.0,
            text: Text::new("", 20.0),
            target: None,
            paper: Paper::Yellow,
            opacity: Default::default(),
        }
    }

    fn image() -> ElementKind {
        ElementKind::Image {
            asset: AssetId::of(b""),
            natural_size: Size {
                width: 1,
                height: 1,
            },
            frame: frame(),
            rotation: 0.0,
            edits: ImageEdits::default(),
            source: None,
            filename: None,
            caption: None,
            opacity: Default::default(),
        }
    }

    fn line() -> ElementKind {
        ElementKind::Line {
            from: Point { x: 0.0, y: 0.0 },
            to: Point { x: 10.0, y: 0.0 },
            from_target: None,
            to_target: None,
            colour: Colour::Ink,
            weight: Weight::Medium,
            dash: Dash::Solid,
            opacity: Default::default(),
        }
    }

    fn comment() -> ElementKind {
        ElementKind::Comment {
            at: Point { x: 0.0, y: 0.0 },
            text: "Here".to_owned(),
            target: None,
        }
    }

    /// Of every kind, each with every part of its style as it comes.
    fn plain_kinds() -> [ElementKind; 15] {
        [
            note(None),
            sticky(),
            shape(Shape::Rectangle, Fill::Hollow),
            shape(Shape::Ellipse, Fill::Hollow),
            shape(Shape::Cross, Fill::Hollow),
            shape(Shape::Triangle, Fill::Hollow),
            shape(Shape::Diamond, Fill::Hollow),
            shape(Shape::Star, Fill::Hollow),
            shape(Shape::Polygon, Fill::Hollow),
            arrow(),
            line(),
            pen(),
            image(),
            comment(),
            ElementKind::Group,
        ]
    }

    /// As `plain`, with every part of its style it takes chosen otherwise.
    fn loud(plain: ElementKind) -> ElementKind {
        let mut kind = plain.with_style(&Style {
            colour: Some(Colour::Rgb([0x12, 0xab, 0x9f])),
            paper: Some(Paper::Pink),
            weight: Some(Weight::Thick),
            dash: Some(Dash::Dashed),
            heads: Some(Heads::Both),
            fill: Some(Fill::Solid),
            corners: Corners::new(9),
            font_size: Some(33.0),
            bold: Some(true),
            italic: Some(true),
            strike: Some(true),
            align: Some(Align::Right),
            opacity: Opacity::new(40),
        });
        // A fill a cross holds from a file written before crosses took none.
        if let ElementKind::Shape {
            shape: Shape::Cross,
            fill,
            ..
        } = &mut kind
        {
            *fill = Fill::Tint;
        }
        kind
    }

    #[test]
    fn each_element_takes_its_own_parts_of_a_style() {
        assert_eq!(note(None).settings()[0], Setting::Colour);
        assert_eq!(sticky().settings()[0], Setting::Paper);
        assert!(
            shape(Shape::Rectangle, Fill::Hollow)
                .settings()
                .contains(&Setting::Fill)
        );
        assert!(
            !shape(Shape::Cross, Fill::Hollow)
                .settings()
                .contains(&Setting::Fill)
        );
        for (counted, counts) in [
            (Shape::Star, true),
            (Shape::Polygon, true),
            (Shape::Triangle, false),
            (Shape::Diamond, false),
            (Shape::Rectangle, false),
        ] {
            let settings = shape(counted, Fill::Hollow).settings();
            assert_eq!(settings.contains(&Setting::Corners), counts, "{counted:?}");
            assert!(settings.contains(&Setting::Fill), "{counted:?}");
        }
        assert!(arrow().settings().contains(&Setting::Heads));
        assert_eq!(image().settings(), [Setting::Opacity]);
        assert!(comment().settings().is_empty());
        assert!(ElementKind::Group.settings().is_empty());
        // The plain style shows each part the element takes, but the size of its text.
        for kind in plain_kinds() {
            let shown = serde_json::to_value(kind.plain_style()).unwrap();
            let taken = serde_json::to_value(kind.settings()).unwrap();
            let mut shown: Vec<&String> = shown.as_object().unwrap().keys().collect();
            let mut taken: Vec<&str> = taken
                .as_array()
                .unwrap()
                .iter()
                .map(|setting| setting.as_str().unwrap())
                .filter(|setting| *setting != "font_size")
                .collect();
            shown.sort();
            taken.sort();
            assert_eq!(shown, taken, "{kind:?}");
        }
    }

    #[test]
    fn the_plain_style_is_each_part_as_it_comes_whatever_the_element_chose() {
        let whole = Style {
            opacity: Some(Opacity::WHOLE),
            ..Style::default()
        };
        let text = Style {
            bold: Some(false),
            italic: Some(false),
            strike: Some(false),
            ..whole
        };
        let stroke = Style {
            colour: Some(Colour::Ink),
            weight: Some(Weight::Medium),
            dash: Some(Dash::Solid),
            ..whole
        };
        let in_shape = Style {
            colour: stroke.colour,
            weight: stroke.weight,
            dash: stroke.dash,
            align: Some(Align::Centre),
            ..text
        };
        let plain = [
            Style {
                colour: Some(Colour::Ink),
                align: Some(Align::Left),
                ..text
            },
            Style {
                paper: Some(Paper::Yellow),
                align: Some(Align::Left),
                ..text
            },
            Style {
                fill: Some(Fill::Hollow),
                ..in_shape
            },
            Style {
                fill: Some(Fill::Hollow),
                ..in_shape
            },
            in_shape,
            Style {
                fill: Some(Fill::Hollow),
                ..in_shape
            },
            Style {
                fill: Some(Fill::Hollow),
                ..in_shape
            },
            Style {
                fill: Some(Fill::Hollow),
                corners: Some(Corners::default()),
                ..in_shape
            },
            Style {
                fill: Some(Fill::Hollow),
                corners: Some(Corners::default()),
                ..in_shape
            },
            Style {
                heads: Some(Heads::End),
                ..stroke
            },
            stroke,
            Style {
                dash: None,
                ..stroke
            },
            whole,
            Style::default(),
            Style::default(),
        ];
        for (kind, plain) in plain_kinds().into_iter().zip(plain) {
            assert_eq!(kind.plain_style(), plain, "{kind:?}");
            assert_eq!(loud(kind.clone()).plain_style(), plain, "{kind:?}");
        }
    }

    #[test]
    fn a_style_sets_only_what_the_element_takes() {
        let style = Style {
            colour: Some(Colour::Red),
            paper: Some(Paper::Pink),
            fill: Some(Fill::Solid),
            corners: Corners::new(8),
            bold: Some(true),
            ..Style::default()
        };
        let ElementKind::Sticky { paper, text, .. } = sticky().with_style(&style) else {
            unreachable!()
        };
        assert_eq!((paper, text.bold), (Paper::Pink, true));
        let ElementKind::Shape { colour, fill, .. } =
            shape(Shape::Cross, Fill::Hollow).with_style(&style)
        else {
            unreachable!()
        };
        assert_eq!((colour, fill), (Colour::Red, Fill::Hollow));
        let corners = |kind: ElementKind| match kind.with_style(&style) {
            ElementKind::Shape { corners, .. } => corners.count(),
            _ => unreachable!(),
        };
        assert_eq!(corners(shape(Shape::Star, Fill::Hollow)), 8);
        assert_eq!(corners(shape(Shape::Polygon, Fill::Hollow)), 8);
        assert_eq!(corners(shape(Shape::Triangle, Fill::Hollow)), 5);
        assert_eq!(image().with_style(&style), image());
        let faded = Style {
            opacity: Opacity::new(50),
            ..Style::default()
        };
        let ElementKind::Image { opacity, .. } = image().with_style(&faded) else {
            unreachable!()
        };
        assert_eq!(opacity.percent(), 50);
        assert_eq!(comment().with_style(&faded), comment());
        // Unset parts stay as they were.
        let right = note(Some(Align::Right));
        assert_eq!(right.clone().with_style(&Style::default()), right);
    }

    #[test]
    fn a_pen_stroke_keeps_its_points_to_a_hundred_thousandth_of_its_frame_without_repeats() {
        let ElementKind::Stroke {
            frame,
            rotation,
            colour,
            weight,
            opacity,
            ..
        } = pen()
        else {
            unreachable!()
        };
        let drawn = |points: &[(f64, f64)]| ElementKind::Stroke {
            tip: Tip::Pen,
            frame,
            rotation,
            points: points.iter().map(|&(x, y)| Point { x, y }).collect(),
            target: None,
            colour,
            weight,
            opacity,
        };
        let kept = drawn(&[
            (0.123_456_789, 1.0),
            (0.123_457_1, 0.999_999_9),
            (0.5, -0.000_001),
        ])
        .canonical();
        assert_eq!(kept, drawn(&[(0.123_46, 1.0), (0.5, 0.0)]));
        assert_eq!(kept.clone().canonical(), kept);
    }

    #[test]
    fn a_part_chosen_as_it_comes_writes_nothing() {
        let left = Style {
            align: Some(Align::Left),
            ..Style::default()
        };
        assert_eq!(note(Some(Align::Right)).with_style(&left), note(None));
        let centred = Style {
            align: Some(Align::Centre),
            ..Style::default()
        };
        let ElementKind::Shape { text, .. } =
            shape(Shape::Rectangle, Fill::Hollow).with_style(&left)
        else {
            unreachable!()
        };
        assert_eq!(text.align, Some(Align::Left));
        let ElementKind::Shape { text, .. } =
            shape(Shape::Rectangle, Fill::Hollow).with_style(&centred)
        else {
            unreachable!()
        };
        assert_eq!(text.align, None);
        assert_eq!(
            shape(Shape::Cross, Fill::Solid).canonical(),
            shape(Shape::Cross, Fill::Hollow)
        );
        // A star that turns into a shape that counts no corners keeps none of its own.
        let mut nine = loud(shape(Shape::Star, Fill::Hollow));
        if let ElementKind::Shape { shape, .. } = &mut nine {
            *shape = Shape::Diamond;
        }
        let ElementKind::Shape { corners, .. } = nine.canonical() else {
            unreachable!()
        };
        assert_eq!(corners, Corners::default());
        // Choosing the plain style puts every part back as it comes, which writes nothing.
        for kind in plain_kinds() {
            let canonical = kind.clone().canonical();
            assert_eq!(canonical.clone().canonical(), canonical);
            let chosen = loud(kind.clone()).with_style(&kind.plain_style());
            let mut written = serde_json::to_value(&chosen).unwrap();
            if let Some(text) = written
                .get_mut("text")
                .and_then(|text| text.as_object_mut())
            {
                assert_eq!(text.remove("font_size"), Some(33.0.into()), "{kind:?}");
                assert!(text.keys().all(|key| key == "content"), "{kind:?}");
            }
            let parts = [
                "colour", "paper", "weight", "dash", "heads", "fill", "corners",
            ];
            assert!(
                parts.iter().all(|part| written.get(part).is_none()),
                "{kind:?}"
            );
            assert_eq!(chosen.clone().with_style(&kind.plain_style()), chosen);
        }
    }
}
