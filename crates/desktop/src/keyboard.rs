//! What each key types without a modifier in the keyboard layout in use, which macOS's webview
//! does not tell the page, where ⌥ makes keys type other characters, so that its shortcuts follow
//! the letter printed on a key.

use std::ffi::{c_int, c_ulong, c_void};

/// The keys that type characters, by `KeyboardEvent.code`, and their virtual key codes, as
/// HIToolbox's Events.h has them, where some layouts put letters on punctuation, as Dvorak does.
const KEYS: [(&str, u16); 48] = [
    ("KeyA", 0x00),
    ("KeyS", 0x01),
    ("KeyD", 0x02),
    ("KeyF", 0x03),
    ("KeyH", 0x04),
    ("KeyG", 0x05),
    ("KeyZ", 0x06),
    ("KeyX", 0x07),
    ("KeyC", 0x08),
    ("KeyV", 0x09),
    ("KeyB", 0x0B),
    ("KeyQ", 0x0C),
    ("KeyW", 0x0D),
    ("KeyE", 0x0E),
    ("KeyR", 0x0F),
    ("KeyY", 0x10),
    ("KeyT", 0x11),
    ("KeyO", 0x1F),
    ("KeyU", 0x20),
    ("KeyI", 0x22),
    ("KeyP", 0x23),
    ("KeyL", 0x25),
    ("KeyJ", 0x26),
    ("KeyK", 0x28),
    ("KeyN", 0x2D),
    ("KeyM", 0x2E),
    ("Digit1", 0x12),
    ("Digit2", 0x13),
    ("Digit3", 0x14),
    ("Digit4", 0x15),
    ("Digit5", 0x17),
    ("Digit6", 0x16),
    ("Digit7", 0x1A),
    ("Digit8", 0x1C),
    ("Digit9", 0x19),
    ("Digit0", 0x1D),
    ("Minus", 0x1B),
    ("Equal", 0x18),
    ("BracketLeft", 0x21),
    ("BracketRight", 0x1E),
    ("Backslash", 0x2A),
    ("Semicolon", 0x29),
    ("Quote", 0x27),
    ("Backquote", 0x32),
    ("Comma", 0x2B),
    ("Period", 0x2F),
    ("Slash", 0x2C),
    ("IntlBackslash", 0x0A),
];

/// `kUCKeyActionDisplay`, what a key shows.
const DISPLAY: u16 = 3;
/// `kUCKeyTranslateNoDeadKeysMask`, so that a dead key gives its own character.
const NO_DEAD_KEYS: u32 = 1;

// libSystem's, which every program links.
unsafe extern "C" {
    safe fn pthread_main_np() -> c_int;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(object: *const c_void);
    fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
}

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: *const c_void;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> *const c_void;
    fn TISGetInputSourceProperty(source: *const c_void, key: *const c_void) -> *const c_void;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const c_void,
        key: u16,
        action: u16,
        modifiers: u32,
        keyboard: u32,
        options: u32,
        dead: *mut u32,
        most: c_ulong,
        length: *mut c_ulong,
        characters: *mut u16,
    ) -> i32;
}

/// Released once dropped, as what a `Copy` function returns must be.
struct Owned(*const c_void);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: `self.0` came from a Core Foundation `Copy` function, and is released once.
        unsafe { CFRelease(self.0) };
    }
}

/// By `KeyboardEvent.code`, in the layout macOS takes shortcuts from, the one in use, or the last
/// Latin one in use where the one in use is not, as for Russian. Empty when it cannot tell, or off
/// the main thread, where Text Input Sources aborts.
pub fn typed() -> Vec<(&'static str, String)> {
    if pthread_main_np() == 0 {
        return Vec::new();
    }
    // SAFETY: on the main thread, as checked; the source it copies is released by `Owned`.
    let source = unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() };
    if source.is_null() {
        return Vec::new();
    }
    let source = Owned(source);
    // SAFETY: `source` is a live input source, and the property's data belongs to it.
    let data = unsafe { TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData) };
    if data.is_null() {
        return Vec::new();
    }
    // SAFETY: `data` is a live CFData, which outlives this function as `source` holds it.
    let layout = unsafe { CFDataGetBytePtr(data) }.cast::<c_void>();
    // SAFETY: no argument, and no state it changes.
    let keyboard = u32::from(unsafe { LMGetKbdType() });
    KEYS.iter()
        .filter_map(|&(code, key)| {
            let mut characters = [0_u16; 4];
            let mut length: c_ulong = 0;
            let mut dead = 0;
            // SAFETY: `layout` is the layout's data, alive while `source` is, and the buffers are
            // as long as told.
            let status = unsafe {
                UCKeyTranslate(
                    layout,
                    key,
                    DISPLAY,
                    0,
                    keyboard,
                    NO_DEAD_KEYS,
                    &mut dead,
                    characters.len() as c_ulong,
                    &mut length,
                    characters.as_mut_ptr(),
                )
            };
            let typed = characters.get(..usize::try_from(length).ok()?)?;
            (status == 0 && !typed.is_empty()).then(|| (code, String::from_utf16_lossy(typed)))
        })
        .collect()
}
