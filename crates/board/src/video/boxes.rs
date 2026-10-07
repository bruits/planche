//! When each frame of an MP4 or QuickTime movie shows, from the box that indexes its samples,
//! which shells find a box header at a time, as the frames' own data may run to gigabytes.

use std::slice::ChunksExact;

use super::MOST_FRAMES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovieIndex {
    /// Its `moov` box, from one byte to another.
    At(u64, u64),
    /// Where the next box starts.
    Next(u64),
}

/// Of a box starting at `start` in a movie `length` bytes long, from `window`, the bytes from
/// there on, of which 16 suffice: whether it is the movie's index, or else where the next box
/// starts. `None` past its end, or for a box cut short or of no size a box can have.
pub fn movie_index(length: u64, start: u64, window: &[u8]) -> Option<MovieIndex> {
    let (kind, _, size) = header(window, length.checked_sub(start)?)?;
    let end = start.checked_add(size).filter(|&end| end <= length)?;
    Some(if kind == *b"moov" {
        MovieIndex::At(start, end)
    } else {
        MovieIndex::Next(end)
    })
}

/// When each frame of the movie whose `moov` box is `index`, as [`movie_index`] finds it, starts
/// showing, in seconds, in the order they show, then when the last one ends. Its first enabled
/// video track's, placed as its edit list places them. `None` for a fragmented movie, whose
/// fragments hold samples its index leaves out, or one without a video track, or cut short.
pub fn movie_frames(index: &[u8]) -> Option<Vec<f64>> {
    let (kind, length, size) = header(index, index.len() as u64)?;
    let index = index.get(usize::try_from(length).ok()?..usize::try_from(size).ok()?)?;
    if kind != *b"moov" || child(index, b"mvex").is_some() {
        return None;
    }
    let movie_scale = timescale(child(index, b"mvhd")?)?;
    boxes(index)
        .filter(|(kind, _)| kind == b"trak")
        .find_map(|(_, track)| track_frames(track, movie_scale))
}

fn track_frames(track: &[u8], movie_scale: u32) -> Option<Vec<f64>> {
    let (_, flags, _) = full(child(track, b"tkhd")?)?;
    let media = child(track, b"mdia")?;
    let (_, _, handler) = full(child(media, b"hdlr")?)?;
    // Past what it predefines.
    if flags & 1 == 0 || handler.get(4..8)? != b"vide" {
        return None;
    }
    let scale = timescale(child(media, b"mdhd")?)?;
    let table = child(child(media, b"minf")?, b"stbl")?;
    let mut samples = samples(child(table, b"stts")?, child(table, b"ctts"))?;
    samples.sort_unstable_by_key(|&(shown, _)| shown);
    let edits = match child(track, b"edts").and_then(|list| child(list, b"elst")) {
        Some(list) => edits(list)?,
        None => Vec::new(),
    };
    placed(&samples, &edits, f64::from(scale), f64::from(movie_scale))
}

/// When each sample shows, and for how long, in the media's own ticks, in the order they decode.
fn samples(times: &[u8], offsets: Option<&[u8]>) -> Option<Vec<(i64, u64)>> {
    let mut samples = Vec::new();
    let mut decoded = 0_i64;
    for entry in entries(times, 8)? {
        let count = u32_at(entry, 0)?;
        let delta = u32_at(entry, 4)?;
        if samples.len().saturating_add(usize::try_from(count).ok()?) > MOST_FRAMES {
            return None;
        }
        for _ in 0..count {
            samples.push((decoded, u64::from(delta)));
            decoded = decoded.checked_add(i64::from(delta))?;
        }
    }
    if let Some(offsets) = offsets {
        let mut sample = samples.iter_mut();
        // Signed whatever its version, as writers take it.
        for entry in entries(offsets, 8)? {
            let offset = i64::from(i32::from_be_bytes(entry.get(4..8)?.try_into().ok()?));
            for (shown, _) in sample.by_ref().take(u32_at(entry, 0)? as usize) {
                *shown += offset;
            }
        }
    }
    Some(samples)
}

/// One edit: how long it lasts in the movie's ticks, and where it starts in the media's, `None`
/// for one that shows nothing for that long.
type Edit = (u64, Option<i64>);

fn edits(list: &[u8]) -> Option<Vec<Edit>> {
    let (version, _, _) = full(list)?;
    let width = if version == 1 { 20 } else { 12 };
    let entries = entries(list, width)?;
    if entries.len() > MOST_FRAMES {
        return None;
    }
    entries
        .map(|entry| {
            let (duration, start, rate) = if version == 1 {
                let duration = u64::from_be_bytes(entry.get(..8)?.try_into().ok()?);
                let start = i64::from_be_bytes(entry.get(8..16)?.try_into().ok()?);
                (duration, start, entry.get(16..18)?)
            } else {
                let start = i32::from_be_bytes(entry.get(4..8)?.try_into().ok()?);
                (
                    u64::from(u32_at(entry, 0)?),
                    i64::from(start),
                    entry.get(8..10)?,
                )
            };
            // One that dwells on a frame, at a rate of 0, shows it as an empty one shows nothing.
            let shows = start >= 0 && rate != [0, 0];
            Some((duration, shows.then_some(start)))
        })
        .collect()
}

/// The times samples show at, as the edits place them in the movie, the last one's end after.
fn placed(
    samples: &[(i64, u64)],
    edits: &[Edit],
    scale: f64,
    movie_scale: f64,
) -> Option<Vec<f64>> {
    let last = samples
        .iter()
        .map(|&(shown, lasts)| shown.saturating_add(lasts.try_into().unwrap_or(i64::MAX)))
        .max()?;
    let mut times = Vec::with_capacity(samples.len() + 1);
    let mut push = |time: f64| {
        if times.last().is_none_or(|&before| time > before) {
            times.push(time);
        }
    };
    if edits.is_empty() {
        samples
            .iter()
            .for_each(|&(shown, _)| push(shown.max(0) as f64 / scale));
        times.push(last as f64 / scale);
        return (times.len() > 1).then_some(times);
    }
    let mut at = 0.0;
    // Edits may show the same frames over and over, which is work and memory to bound too.
    let mut visited = 0_usize;
    for &(duration, start) in edits {
        visited += 1;
        let lasts = duration as f64 / movie_scale;
        let Some(start) = start else {
            at += lasts;
            continue;
        };
        // An edit of no duration runs to the end of the media.
        let end = if duration == 0 {
            last
        } else {
            start.saturating_add((lasts * scale).round() as i64)
        };
        // The frame showing as it starts, which may have started before it.
        let first = samples
            .partition_point(|&(shown, _)| shown <= start)
            .saturating_sub(1);
        let stop = samples
            .partition_point(|&(shown, _)| shown < end)
            .max(first);
        visited += stop - first;
        if visited > MOST_FRAMES {
            return None;
        }
        for &(shown, _) in &samples[first..stop] {
            push(at + (shown.max(start) - start) as f64 / scale);
        }
        at += if duration == 0 {
            last.saturating_sub(start).max(0) as f64 / scale
        } else {
            lasts
        };
    }
    times.push(at);
    (times.len() > 1).then_some(times)
}

/// Its version, its flags, and what follows them.
fn full(bytes: &[u8]) -> Option<(u8, u32, &[u8])> {
    let (&version, rest) = bytes.split_first()?;
    let flags = u32::from_be_bytes([0, *rest.first()?, *rest.get(1)?, *rest.get(2)?]);
    Some((version, flags, rest.get(3..)?))
}

fn timescale(header: &[u8]) -> Option<u32> {
    let (version, _, rest) = full(header)?;
    // Past when it was made and changed, of 8 bytes each from version 1 on, 4 before.
    let at = if version == 1 { 16 } else { 8 };
    u32_at(rest, at).filter(|&scale| scale > 0)
}

/// The entries of a table `width` bytes each, as many as its count says, `None` when they would
/// run past it.
fn entries(table: &[u8], width: usize) -> Option<ChunksExact<'_, u8>> {
    let (_, _, rest) = full(table)?;
    let count = usize::try_from(u32_at(rest, 0)?).ok()?;
    let all = rest.get(4..)?.get(..count.checked_mul(width)?)?;
    Some(all.chunks_exact(width))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Its kind, the length of its header, and its size, `rest` when it runs to the end of what holds
/// it. `None` for a box too small for its header.
fn header(bytes: &[u8], rest: u64) -> Option<([u8; 4], u64, u64)> {
    let kind = bytes.get(4..8)?.try_into().ok()?;
    let (length, size) = match u32_at(bytes, 0)? {
        0 => (8, rest),
        1 => (16, u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)),
        size => (8, u64::from(size)),
    };
    (size >= length).then_some((kind, length, size))
}

/// The boxes `bytes` holds, each with its contents, up to one cut short.
fn boxes(mut bytes: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    std::iter::from_fn(move || {
        let (kind, length, size) = header(bytes, bytes.len() as u64)?;
        let size = usize::try_from(size).ok()?;
        let contents = bytes.get(usize::try_from(length).ok()?..size)?;
        bytes = &bytes[size..];
        Some((kind, contents))
    })
}

fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(bytes).find_map(|(found, contents)| (found == *kind).then_some(contents))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(kind: &[u8; 4], contents: &[u8]) -> Vec<u8> {
        let mut bytes = u32::try_from(contents.len() + 8)
            .unwrap()
            .to_be_bytes()
            .to_vec();
        bytes.extend(kind);
        bytes.extend(contents);
        bytes
    }

    fn full_box(kind: &[u8; 4], version: u8, flags: u32, contents: &[u8]) -> Vec<u8> {
        let mut bytes = vec![version];
        bytes.extend(&flags.to_be_bytes()[1..]);
        bytes.extend(contents);
        boxed(kind, &bytes)
    }

    fn scaled(kind: &[u8; 4], version: u8, scale: u32) -> Vec<u8> {
        let mut contents = vec![0; if version == 1 { 16 } else { 8 }];
        contents.extend(scale.to_be_bytes());
        contents.extend([0; 8]);
        full_box(kind, version, 0, &contents)
    }

    fn table(kind: &[u8; 4], version: u8, entries: &[[u32; 2]]) -> Vec<u8> {
        let mut contents = u32::try_from(entries.len()).unwrap().to_be_bytes().to_vec();
        for entry in entries {
            contents.extend(entry.iter().flat_map(|value| value.to_be_bytes()));
        }
        full_box(kind, version, 0, &contents)
    }

    struct Track<'a> {
        handler: &'a [u8; 4],
        enabled: bool,
        scale: u32,
        times: &'a [[u32; 2]],
        offsets: Option<&'a [[u32; 2]]>,
        edits: Option<Vec<u8>>,
    }

    const VIDEO: Track<'static> = Track {
        handler: b"vide",
        enabled: true,
        scale: 24,
        times: &[[4, 1]],
        offsets: None,
        edits: None,
    };

    fn track(track: &Track) -> Vec<u8> {
        let mut handler = vec![0; 4];
        handler.extend(track.handler);
        handler.extend([0; 12]);
        let mut stbl = table(b"stts", 0, track.times);
        if let Some(offsets) = track.offsets {
            stbl.extend(table(b"ctts", 1, offsets));
        }
        let mut media = scaled(b"mdhd", 0, track.scale);
        media.extend(full_box(b"hdlr", 0, 0, &handler));
        media.extend(boxed(b"minf", &boxed(b"stbl", &stbl)));
        let mut contents = full_box(b"tkhd", 0, u32::from(track.enabled), &[0; 80]);
        if let Some(edits) = &track.edits {
            contents.extend(boxed(b"edts", edits));
        }
        contents.extend(boxed(b"mdia", &media));
        boxed(b"trak", &contents)
    }

    fn movie(tracks: &[Track]) -> Vec<u8> {
        let mut contents = scaled(b"mvhd", 0, 600);
        for each in tracks {
            contents.extend(track(each));
        }
        boxed(b"moov", &contents)
    }

    fn edit_list(version: u8, edits: &[(u64, i64)]) -> Vec<u8> {
        let mut contents = u32::try_from(edits.len()).unwrap().to_be_bytes().to_vec();
        for &(duration, start) in edits {
            if version == 1 {
                contents.extend(duration.to_be_bytes());
                contents.extend(start.to_be_bytes());
            } else {
                contents.extend(u32::try_from(duration).unwrap().to_be_bytes());
                contents.extend(i32::try_from(start).unwrap().to_be_bytes());
            }
            contents.extend([0, 1, 0, 0]);
        }
        full_box(b"elst", version, 0, &contents)
    }

    fn twelfths(times: &[f64]) -> Vec<f64> {
        times
            .iter()
            .map(|time| (time * 12.0 * 1e6).round() / 1e6)
            .collect()
    }

    #[test]
    fn a_movie_shows_its_frames_as_their_durations_add_up() {
        let times = movie_frames(&movie(&[Track {
            times: &[[2, 1], [1, 3]],
            ..VIDEO
        }]))
        .unwrap();
        assert_eq!(twelfths(&times), [0.0, 0.5, 1.0, 2.5]);
    }

    /// Shown 1, 4, 2, and 3 frames on, as B-frames are.
    const REORDERED: &[[u32; 2]] = &[[1, 1], [1, 3], [2, 0]];

    #[test]
    fn frames_decoded_out_of_order_show_in_order() {
        let offsets = REORDERED;
        let times = movie_frames(&movie(&[Track {
            offsets: Some(offsets),
            ..VIDEO
        }]))
        .unwrap();
        assert_eq!(twelfths(&times), [0.5, 1.0, 1.5, 2.0, 2.5]);
    }

    #[test]
    fn an_edit_list_moves_frames_to_where_the_movie_shows_them() {
        for version in [0, 1] {
            // As writers start the movie on the first frame, past what B-frames hold back, its
            // four frames lasting 100 of the movie's 600 ticks a second.
            let times = movie_frames(&movie(&[Track {
                offsets: Some(REORDERED),
                edits: Some(edit_list(version, &[(100, 1)])),
                ..VIDEO
            }]))
            .unwrap();
            assert_eq!(twelfths(&times), [0.0, 0.5, 1.0, 1.5, 2.0], "{version}");
        }
        // Half a second of nothing first, then from the second frame on.
        let times = movie_frames(&movie(&[Track {
            edits: Some(edit_list(0, &[(300, -1), (75, 1)])),
            ..VIDEO
        }]))
        .unwrap();
        assert_eq!(twelfths(&times), [6.0, 6.5, 7.0, 7.5]);
    }

    #[test]
    fn the_first_enabled_video_track_shows() {
        let sound = Track {
            handler: b"soun",
            ..VIDEO
        };
        let off = Track {
            enabled: false,
            times: &[[2, 1]],
            ..VIDEO
        };
        let times = movie_frames(&movie(&[sound, off, VIDEO])).unwrap();
        assert_eq!(times.len(), 5);
        assert_eq!(
            movie_frames(&movie(&[Track {
                handler: b"soun",
                ..VIDEO
            }])),
            None
        );
    }

    #[test]
    fn a_fragmented_broken_or_cut_movie_tells_no_frames() {
        let mut contents = movie(&[VIDEO])[8..].to_vec();
        contents.extend(boxed(b"mvex", &[]));
        assert_eq!(movie_frames(&boxed(b"moov", &contents)), None);
        let whole = movie(&[VIDEO]);
        assert_eq!(movie_frames(&whole[..whole.len() - 3]), None);
        let claims: &[[u32; 2]] = &[[u32::MAX, 1]];
        assert_eq!(
            movie_frames(&movie(&[Track {
                times: claims,
                ..VIDEO
            }])),
            None
        );
        let mut counted = movie(&[VIDEO]);
        let at = counted.windows(4).position(|kind| kind == b"stts").unwrap() + 8;
        counted[at..at + 4].copy_from_slice(&1000_u32.to_be_bytes());
        assert_eq!(movie_frames(&counted), None);
    }

    #[test]
    fn its_index_is_found_a_box_header_at_a_time() {
        let mut file = boxed(b"ftyp", b"isom\0\0\0\0");
        file.extend(boxed(b"mdat", &[0; 100]));
        let index = file.len() as u64;
        file.extend(movie(&[VIDEO]));
        let length = file.len() as u64;
        let at = |start: u64| movie_index(length, start, &file[start as usize..]);
        assert_eq!(at(0), Some(MovieIndex::Next(16)));
        assert_eq!(at(16), Some(MovieIndex::Next(index)));
        assert_eq!(at(index), Some(MovieIndex::At(index, length)));
        assert_eq!(at(length), None);
        // Of 64 bits, and running to the end.
        let mut large = 1_u32.to_be_bytes().to_vec();
        large.extend(b"mdat");
        large.extend(4096_u64.to_be_bytes());
        assert_eq!(movie_index(5000, 0, &large), Some(MovieIndex::Next(4096)));
        assert_eq!(
            movie_index(5000, 4096, b"\0\0\0\0moov"),
            Some(MovieIndex::At(4096, 5000))
        );
        assert_eq!(movie_index(5000, 0, b"\0\0\0\x04mdat"), None);
        assert_eq!(movie_index(100, 0, b"\0\0\x01\0mdat"), None);
    }

    #[test]
    fn edits_repeating_its_frames_past_the_most_a_movie_has_tell_none() {
        // Of some 12 KB, 4,096 frames shown 1,025 times over.
        let index = movie(&[Track {
            times: &[[1 << 12, 1]],
            edits: Some(edit_list(0, &[(0, 0); 1025])),
            ..VIDEO
        }]);
        assert!(index.len() < 13_000);
        assert_eq!(movie_frames(&index).map(|times| times.len()), None);
    }

    #[test]
    fn an_edit_list_longer_than_the_most_frames_a_movie_has_tells_none() {
        // Its frames shown once, then more empty edits than a movie has frames.
        let mut edits = vec![(0, 0)];
        edits.extend(std::iter::repeat_n((1, -1), MOST_FRAMES));
        let index = movie(&[Track {
            edits: Some(edit_list(0, &edits)),
            ..VIDEO
        }]);
        assert_eq!(movie_frames(&index).map(|times| times.len()), None);
    }

    #[test]
    fn frames_shown_before_the_movie_starts_show_from_its_start() {
        let back = (-1_i32).cast_unsigned();
        // Shown -1, 3, 1, 2 ticks on, without an edit list.
        let straddles: &[[u32; 2]] = &[[1, back], [1, 2], [2, back]];
        let times = movie_frames(&movie(&[Track {
            offsets: Some(straddles),
            ..VIDEO
        }]))
        .unwrap();
        assert_eq!(twelfths(&times), [0.0, 0.5, 1.0, 1.5, 2.0]);
        // Shown -1, 0, 1, 2, the first ending where the timeline starts.
        let before: &[[u32; 2]] = &[[4, back]];
        let times = movie_frames(&movie(&[Track {
            offsets: Some(before),
            ..VIDEO
        }]))
        .unwrap();
        assert_eq!(twelfths(&times), [0.0, 0.5, 1.0, 1.5]);
    }

    #[test]
    fn an_edit_starting_past_any_tick_tells_none() {
        // One frame shown 2 ticks before the timeline starts, lasting none, then an edit of no
        // duration starting at the last tick there is.
        let back = (-2_i32).cast_unsigned();
        let index = movie(&[Track {
            times: &[[1, 0]],
            offsets: Some(&[[1, back]]),
            edits: Some(edit_list(1, &[(0, i64::MAX)])),
            ..VIDEO
        }]);
        assert_eq!(movie_frames(&index), None);
    }
}
