//! Keys that sort as strings and always leave room between two of them, after David
//! Greenspan's "Implementing Fractional Indexing" and rocicorp's `fractional-indexing` (CC0).
//! A key is an integer part, whose head letter gives its length so that appending stays
//! short, then a fraction that never ends with a zero.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{Error, Result};

const DIGITS: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = DIGITS[0];
const LAST: u8 = DIGITS[DIGITS.len() - 1];
/// Nothing sorts below it, so it is not a key.
const SMALLEST_INTEGER: &[u8] = b"A00000000000000000000000000";

/// Where an element stacks among the elements of its group, lowest first. Restacking an
/// element gives it a key between its new neighbours, so it rewrites only that element's
/// file, and two people restacking different elements never conflict. A merge can leave two
/// siblings with the same key: to stack between them, re-key the upper one first.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(type = "string"))]
pub struct ZIndex(String);

impl ZIndex {
    /// A key strictly between `below` and `above`, `None` standing for the end of the stack
    /// on that side. Returns `None` when `below` is not lower than `above`.
    pub fn between(below: Option<&Self>, above: Option<&Self>) -> Option<Self> {
        let key = match (below, above) {
            (None, None) => b"a0".to_vec(),
            (Some(below), None) => {
                let (integer, fraction) = below.split();
                increment(integer).unwrap_or_else(|| [integer, &midpoint(fraction, None)].concat())
            }
            (None, Some(above)) => {
                let (integer, fraction) = above.split();
                if integer == SMALLEST_INTEGER {
                    [integer, &midpoint(&[], Some(fraction))].concat()
                } else if fraction.is_empty() {
                    let below = decrement(integer).expect("only the smallest integer has none");
                    if below == SMALLEST_INTEGER {
                        [&below, midpoint(&[], None).as_slice()].concat()
                    } else {
                        below
                    }
                } else {
                    integer.to_vec()
                }
            }
            (Some(below), Some(above)) => {
                if below >= above {
                    return None;
                }
                let (low_integer, low_fraction) = below.split();
                let (high_integer, high_fraction) = above.split();
                if low_integer == high_integer {
                    [low_integer, &midpoint(low_fraction, Some(high_fraction))].concat()
                } else {
                    match increment(low_integer) {
                        Some(next) if next.as_slice() < above.0.as_bytes() => next,
                        _ => [low_integer, &midpoint(low_fraction, None)].concat(),
                    }
                }
            }
        };
        Some(Self(String::from_utf8(key).expect("digits are ASCII")))
    }

    fn split(&self) -> (&[u8], &[u8]) {
        let key = self.0.as_bytes();
        key.split_at(integer_length(key[0]).expect("keys are checked when parsed"))
    }
}

/// Digits strictly between two fractions, `None` standing for one. Neither ends with a zero,
/// and neither does the result.
fn midpoint(low: &[u8], high: Option<&[u8]>) -> Vec<u8> {
    if let Some(high) = high {
        // `low` reads as padded with zeros. It is lower, so it differs before `high` ends.
        let common = high
            .iter()
            .enumerate()
            .take_while(|&(at, &digit)| low.get(at).copied().unwrap_or(ZERO) == digit)
            .count();
        if common > 0 {
            let rest = midpoint(low.get(common..).unwrap_or_default(), Some(&high[common..]));
            return [&high[..common], &rest].concat();
        }
    }
    let low_digit = low.first().map_or(0, |&digit| value(digit));
    let high_digit = high.map_or(DIGITS.len(), |high| value(high[0]));
    if high_digit - low_digit > 1 {
        vec![DIGITS[(low_digit + high_digit).div_ceil(2)]]
    } else if let Some(high) = high.filter(|high| high.len() > 1) {
        vec![high[0]]
    } else {
        let rest = midpoint(low.get(1..).unwrap_or_default(), None);
        [&[DIGITS[low_digit]], rest.as_slice()].concat()
    }
}

/// The next integer, or `None` past the largest one.
fn increment(integer: &[u8]) -> Option<Vec<u8>> {
    let (&head, digits) = integer.split_first()?;
    let mut digits = digits.to_vec();
    for digit in digits.iter_mut().rev() {
        match DIGITS.get(value(*digit) + 1) {
            Some(&next) => {
                *digit = next;
                return Some([&[head], digits.as_slice()].concat());
            }
            None => *digit = ZERO,
        }
    }
    let head = match head {
        b'Z' => return Some(b"a0".to_vec()),
        b'z' => return None,
        _ => head + 1,
    };
    // Lowercase heads grow longer as they rise, uppercase ones shorter.
    if head > b'a' {
        digits.push(ZERO);
    } else {
        digits.pop();
    }
    Some([&[head], digits.as_slice()].concat())
}

/// The previous integer, or `None` below the smallest one.
fn decrement(integer: &[u8]) -> Option<Vec<u8>> {
    let (&head, digits) = integer.split_first()?;
    let mut digits = digits.to_vec();
    for digit in digits.iter_mut().rev() {
        match value(*digit).checked_sub(1) {
            Some(previous) => {
                *digit = DIGITS[previous];
                return Some([&[head], digits.as_slice()].concat());
            }
            None => *digit = LAST,
        }
    }
    let head = match head {
        b'a' => return Some(vec![b'Z', LAST]),
        b'A' => return None,
        _ => head - 1,
    };
    if head < b'Z' {
        digits.push(LAST);
    } else {
        digits.pop();
    }
    Some([&[head], digits.as_slice()].concat())
}

/// The length of the integer part that `head` starts.
fn integer_length(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some(usize::from(head - b'a') + 2),
        b'A'..=b'Z' => Some(usize::from(b'Z' - head) + 2),
        _ => None,
    }
}

fn value(digit: u8) -> usize {
    DIGITS
        .iter()
        .position(|&candidate| candidate == digit)
        .expect("keys are checked when parsed")
}

impl fmt::Display for ZIndex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for ZIndex {
    type Err = Error;

    fn from_str(text: &str) -> Result<Self> {
        let key = text.as_bytes();
        let fraction = key
            .first()
            .and_then(|&head| integer_length(head))
            .and_then(|length| key.get(length..));
        let valid = key.iter().all(u8::is_ascii_alphanumeric)
            && fraction.is_some_and(|fraction| fraction.last() != Some(&ZERO))
            && key != SMALLEST_INTEGER;
        if valid {
            Ok(Self(text.to_owned()))
        } else {
            Err(Error::InvalidZIndex(text.to_owned()))
        }
    }
}

impl Serialize for ZIndex {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ZIndex {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}
