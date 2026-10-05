//! The board's types as the web app's TypeScript declares them, so that the two never drift
//! apart.

use std::collections::BTreeMap;

use ts_rs::{Config, TS, TypeVisitor};

use crate::{
    Alignment, Axis, BoardView, Copied, Element, ElementKind, End, Item, Media, Order, Restack,
    Setting, Side, Style, Transform,
};

/// Each type the web app reads or writes, and those they hold, exported, in the order of their
/// names, so that the same types always declare alike.
pub fn typescript() -> String {
    let config = Config::default();
    let mut found = Declarations {
        config: &config,
        declared: BTreeMap::new(),
    };
    found.visit::<Alignment>();
    found.visit::<Axis>();
    found.visit::<BoardView>();
    found.visit::<Copied>();
    found.visit::<Element>();
    found.visit::<ElementKind>();
    found.visit::<End>();
    found.visit::<Item>();
    found.visit::<Media>();
    found.visit::<Order>();
    found.visit::<Restack>();
    found.visit::<Setting>();
    found.visit::<Side>();
    found.visit::<Style>();
    found.visit::<Transform>();
    found
        .declared
        .values()
        .map(|declaration| format!("export {declaration}\n"))
        .collect()
}

struct Declarations<'a> {
    config: &'a Config,
    declared: BTreeMap<String, String>,
}

impl TypeVisitor for Declarations<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        // Primitives and collections declare nothing of their own.
        if T::output_path().is_none() {
            return;
        }
        let name = T::ident(self.config);
        if !self.declared.contains_key(&name) {
            self.declared.insert(name, T::decl(self.config));
            T::visit_dependencies(self);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Colour;

    fn declaration(name: &str) -> String {
        let start = format!("export type {name} = ");
        let declared = typescript();
        let mut found = declared.split(&start).skip(1);
        let declaration = found.next().expect("declared").to_owned();
        assert!(found.next().is_none(), "{name} is declared once");
        declaration
    }

    #[test]
    fn each_type_the_web_app_takes_is_declared_once_and_alike_every_time() {
        assert_eq!(typescript(), typescript());
        for name in [
            "Alignment",
            "Axis",
            "Board",
            "Copied",
            "Element",
            "ElementKind",
            "End",
            "Item",
            "Media",
            "Paint",
            "Order",
            "Restack",
            "Setting",
            "Side",
            "Style",
            "Transform",
        ] {
            declaration(name);
        }
    }

    #[test]
    fn a_colour_is_declared_as_the_palette_names_it() {
        let declared = declaration("Colour");
        let declared = declared.split(';').next().unwrap();
        let named: Vec<String> = Colour::PALETTE
            .iter()
            .map(|(_, name)| format!("\"{name}\""))
            .collect();
        assert_eq!(declared, format!("{} | `#${{string}}`", named.join(" | ")));
    }
}
