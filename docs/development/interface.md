# Interface

Planche looks modern and minimal, is easy to use, and never feels cold.

## Three surfaces

Nearly everything the user works with lives in three places.

- The bar at the bottom of the window, with the tools, the commands that act at once, the zoom, and a menu for the rest.
- The style card, which floats by the selection and follows it.
- The menu a right-click opens, about the selection or the board.

A new control goes into one of them. Find a command and comments' pins are the exceptions.

## Menus

- A menu holds three groups at most, and a submenu two, so that it stays quick to scan.
- A new entry joins an existing group. When none fits, the menu needs rethinking.
- The right-click menu mostly leaves out what the style card and the keys already reach, such as colours.
- On a selection, the menu goes from what copies or removes the elements, to what changes each one, to their place among the others.
- A menu offers only what applies where it opens. Find a command lists them all.

## Keys

- As many actions as possible have a shortcut, and each takes the key users most expect. When conventions disagree, generic actions follow web design tools, and image actions follow reference-board apps.
- Shortcuts are not settled yet, so an existing one moves when a better key comes along.
- The keyboard reaches every control of the three surfaces.
- Every key is listed in [shortcuts](../usage/shortcuts.md), which changes with it.

## Text

- Labels, hints, and messages are short and plain, in British English.
- A hint gives the main actions of what is under way, three at most. Those for the board and the selection end with "right-click for more".
- Rarer keys stay in [shortcuts](../usage/shortcuts.md), and hints never point to Find a command.

## Look

- The bar, the cards, and the menus share one look, the surface colour with a 1 px line, a soft shadow, and rounded corners.
- Colours come from the tokens in `web/public/style.css`, and each new one is checked in light, dark, and high contrast. High contrast drops shadows and translucency.
- What shows over the board during a gesture, such as guides, stays thin, leaves the pictures readable, and never reads as a selection.
- Icons come from Tabler Icons, outline, on a 24 grid, and text is set in Inter.
