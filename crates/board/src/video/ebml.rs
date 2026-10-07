//! When each frame of a WebM or Matroska video shows, from its bytes read in order a chunk at a
//! time, as the clusters that say when their frames show run through the whole file, between the
//! frames' own data, which it passes over without keeping.

use super::{MOST_FRAMES, vint};

const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_A966;
const TIMESTAMP_SCALE: u64 = 0x2A_D7B1;
const TRACKS: u64 = 0x1654_AE6B;
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_NUMBER: u64 = 0xD7;
const TRACK_TYPE: u64 = 0x83;
const FLAG_ENABLED: u64 = 0xB9;
const DEFAULT_DURATION: u64 = 0x23_E383;
const CLUSTER: u64 = 0x1F43_B675;
const TIMESTAMP: u64 = 0xE7;
const SIMPLE_BLOCK: u64 = 0xA3;
const BLOCK_GROUP: u64 = 0xA0;
const BLOCK: u64 = 0xA1;
const BLOCK_DURATION: u64 = 0x9B;
/// What a segment holds besides clusters, any of which ends a cluster of unknown size.
const SEGMENT_PARTS: [u64; 7] = [
    INFO,
    TRACKS,
    0x114D_9B74,
    0x1C53_BB6B,
    0x1043_A770,
    0x1254_C367,
    0x1941_A469,
];
const VIDEO: u64 = 1;
/// The largest element it keeps whole to read, as tracks and their settings are small.
const MOST_KEPT: u64 = 1 << 20;
/// As the specification has it, in nanoseconds a tick.
const NANOSECONDS: u64 = 1_000_000;

#[derive(Debug)]
pub struct MatroskaFrames {
    /// Bytes read but not yet taken, from `at` in the file.
    pending: Vec<u8>,
    at: u64,
    /// Of the element passed over, what bytes are still to come.
    passing: u64,
    /// The elements it is within, each with where it ends, `None` for one of unknown size.
    within: Vec<(u64, Option<u64>)>,
    /// Nanoseconds a tick.
    scale: u64,
    /// Its first enabled video track, and how long its frames last by default, in nanoseconds.
    track: Option<(u64, Option<u64>)>,
    /// When the cluster read starts, in ticks.
    cluster: i64,
    /// The track of each frame, when it shows, in ticks, and how long it lasts when told, only
    /// the video track's once known.
    blocks: Vec<(u64, i64, Option<u64>)>,
    /// Whether the block of the group read was kept, which its duration then belongs to.
    grouped: bool,
    broken: bool,
}

impl Default for MatroskaFrames {
    fn default() -> Self {
        Self {
            pending: Vec::new(),
            at: 0,
            passing: 0,
            within: Vec::new(),
            scale: NANOSECONDS,
            track: None,
            cluster: 0,
            blocks: Vec::new(),
            grouped: false,
            broken: false,
        }
    }
}

enum Step {
    Taken(usize),
    /// Past an element, of which it may not hold all.
    Passed(u64),
}

impl MatroskaFrames {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next bytes of the file, whatever their length.
    pub fn read(&mut self, mut bytes: &[u8]) {
        if self.broken {
            return;
        }
        // Past what the element passed over still holds, which it keeps no copy of.
        let passed = self.passing.min(bytes.len() as u64);
        self.passing -= passed;
        self.at += passed;
        bytes = &bytes[passed as usize..];
        if bytes.is_empty() {
            return;
        }
        let mut pending = std::mem::take(&mut self.pending);
        pending.extend_from_slice(bytes);
        let mut taken = 0;
        while let Some(step) = self.step(&pending[taken..]) {
            let held = pending.len() - taken;
            let length = match step {
                Step::Taken(length) => length,
                // In 64 bits, as an element may outgrow what wasm32 counts in.
                Step::Passed(length) => {
                    self.passing = length.saturating_sub(held as u64);
                    length.min(held as u64) as usize
                }
            };
            taken += length;
            self.at += length as u64;
            if self.passing > 0 {
                break;
            }
        }
        self.pending = pending.split_off(taken);
    }

    /// When each frame of its first enabled video track starts showing, in seconds, in the order
    /// they show, then when the last one ends, of what it read. `None` without such a track, or
    /// once its bytes broke, or until it read two frames, or one and how long it lasts.
    pub fn frames(&self) -> Option<Vec<f64>> {
        let (track, lasts) = self.track?;
        let mut ticks: Vec<(i64, Option<u64>)> = self
            .blocks
            .iter()
            .filter(|&&(of, _, _)| of == track)
            .map(|&(_, shown, duration)| (shown, duration))
            .collect();
        ticks.sort_unstable_by_key(|&(shown, _)| shown);
        ticks.dedup_by_key(|&mut (shown, _)| shown);
        let scale = self.scale as f64 / 1e9;
        let &(last, duration) = ticks.last()?;
        let gap = (ticks.len() > 1).then(|| (last - ticks[ticks.len() - 2].0) as f64 * scale);
        let lasts = duration
            .map(|ticks| ticks as f64 * scale)
            .or(lasts.map(|nanoseconds| nanoseconds as f64 / 1e9))
            .or(gap)?;
        let mut times: Vec<f64> = ticks
            .iter()
            .map(|&(shown, _)| shown as f64 * scale)
            .collect();
        times.push(last as f64 * scale + lasts);
        (!self.broken).then_some(times)
    }

    /// The next step through `bytes`, the pending ones, `None` once it needs more of them.
    fn step(&mut self, bytes: &[u8]) -> Option<Step> {
        while let Some(&(_, Some(end))) = self.within.last()
            && self.at >= end
        {
            self.within.pop();
        }
        let header = vint(bytes, true).and_then(|(id, id_length)| {
            let (size, size_length) = vint(bytes.get(id_length..)?, false)?;
            Some((id, id_length, size, size_length))
        });
        let Some((id, id_length, size, size_length)) = header else {
            // Only lacking bytes for a header leaves it whole.
            self.broken |= bytes.len() >= 16;
            return None;
        };
        let length = id_length + size_length;
        // All ones, whatever its length.
        let unknown = size == (1 << (7 * size_length)) - 1;
        if let Some(&(CLUSTER, None)) = self.within.last()
            && (id == CLUSTER || SEGMENT_PARTS.contains(&id))
        {
            self.within.pop();
            return Some(Step::Taken(0));
        }
        match id {
            SEGMENT | CLUSTER | BLOCK_GROUP => {
                if id == BLOCK_GROUP {
                    self.grouped = false;
                }
                let end = (!unknown).then(|| self.at + length as u64 + size);
                self.within.push((id, end));
                Some(Step::Taken(length))
            }
            _ if unknown => {
                self.broken = true;
                None
            }
            INFO | TRACKS | TIMESTAMP | BLOCK_DURATION if size <= MOST_KEPT => {
                let contents = bytes.get(length..length + size as usize)?;
                self.take(id, contents);
                Some(Step::Taken(length + size as usize))
            }
            SIMPLE_BLOCK | BLOCK => {
                // Its track, when it shows from its cluster's start, and its flags.
                let start = bytes.get(length..length + size.min(11) as usize)?;
                self.block(start);
                Some(Step::Passed(length as u64 + size))
            }
            _ => Some(Step::Passed(length as u64 + size)),
        }
    }

    fn take(&mut self, id: u64, contents: &[u8]) {
        match id {
            INFO => {
                if let Some(scale) = children(contents)
                    .find_map(|(id, value)| (id == TIMESTAMP_SCALE).then(|| unsigned(value)))
                    .filter(|&scale| scale > 0)
                {
                    self.scale = scale;
                }
            }
            TRACKS if self.track.is_none() => {
                self.track = children(contents)
                    .filter(|&(id, _)| id == TRACK_ENTRY)
                    .find_map(|(_, entry)| video_track(entry));
                if let Some((video, _)) = self.track {
                    self.blocks.retain(|&(track, ..)| track == video);
                }
            }
            TIMESTAMP => self.cluster = i64::try_from(unsigned(contents)).unwrap_or(i64::MAX),
            BLOCK_DURATION if self.grouped => {
                if let Some((_, _, lasts)) = self.blocks.last_mut() {
                    *lasts = Some(unsigned(contents));
                }
            }
            _ => {}
        }
    }

    fn block(&mut self, start: &[u8]) {
        self.grouped = false;
        if let Some((track, length)) = vint(start, false)
            && let Some(&[high, low]) = start.get(length..length + 2)
            && self.track.is_none_or(|(video, _)| track == video)
        {
            if self.blocks.len() >= MOST_FRAMES {
                self.broken = true;
                return;
            }
            let shown = self
                .cluster
                .saturating_add(i64::from(i16::from_be_bytes([high, low])))
                .max(0);
            self.blocks.push((track, shown, None));
            self.grouped = true;
        }
    }
}

/// Its number and how long its frames last by default, when it is an enabled video track.
fn video_track(entry: &[u8]) -> Option<(u64, Option<u64>)> {
    let mut number = None;
    let mut kind = None;
    let mut enabled = true;
    let mut lasts = None;
    for (id, value) in children(entry) {
        match id {
            TRACK_NUMBER => number = Some(unsigned(value)),
            TRACK_TYPE => kind = Some(unsigned(value)),
            FLAG_ENABLED => enabled = unsigned(value) != 0,
            DEFAULT_DURATION => lasts = Some(unsigned(value)).filter(|&lasts| lasts > 0),
            _ => {}
        }
    }
    (kind == Some(VIDEO) && enabled).then_some((number?, lasts))
}

/// The elements `bytes` holds, up to one cut short or of unknown size.
fn children(mut bytes: &[u8]) -> impl Iterator<Item = (u64, &[u8])> {
    std::iter::from_fn(move || {
        let (id, id_length) = vint(bytes, true)?;
        let (size, size_length) = vint(bytes.get(id_length..)?, false)?;
        let start = id_length + size_length;
        let end = start.checked_add(usize::try_from(size).ok()?)?;
        let contents = bytes.get(start..end)?;
        bytes = &bytes[end..];
        Some((id, contents))
    })
}

fn unsigned(bytes: &[u8]) -> u64 {
    bytes
        .iter()
        .take(8)
        .fold(0, |value, &byte| value << 8 | u64::from(byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Its id as written, marker included, then its size on as many bytes as `width` says.
    fn sized(id: u64, contents: &[u8], width: usize) -> Vec<u8> {
        let id_bytes = id.to_be_bytes();
        let mut bytes = id_bytes[id_bytes.iter().position(|&byte| byte != 0).unwrap()..].to_vec();
        let size = contents.len() as u64 | 1 << (7 * width);
        bytes.extend(&size.to_be_bytes()[8 - width..]);
        bytes.extend(contents);
        bytes
    }

    fn element(id: u64, contents: &[u8]) -> Vec<u8> {
        sized(id, contents, 4)
    }

    /// Of unknown size, which runs to where something else starts.
    fn open(id: u64, contents: &[u8]) -> Vec<u8> {
        let id_bytes = id.to_be_bytes();
        let mut bytes = id_bytes[id_bytes.iter().position(|&byte| byte != 0).unwrap()..].to_vec();
        bytes.push(0xFF);
        bytes.extend(contents);
        bytes
    }

    fn number(id: u64, value: u64) -> Vec<u8> {
        element(id, &value.to_be_bytes())
    }

    fn track(number_: u64, kind: u64) -> Vec<u8> {
        let mut entry = number(TRACK_NUMBER, number_);
        entry.extend(number(TRACK_TYPE, kind));
        element(TRACK_ENTRY, &entry)
    }

    fn simple(track: u8, at: i16) -> Vec<u8> {
        let mut contents = vec![0x80 | track];
        contents.extend(at.to_be_bytes());
        contents.push(0x80);
        contents.extend([0x55; 40]);
        element(SIMPLE_BLOCK, &contents)
    }

    fn cluster(at: u64, blocks: &[Vec<u8>]) -> Vec<u8> {
        let mut contents = number(TIMESTAMP, at);
        contents.extend(blocks.concat());
        element(CLUSTER, &contents)
    }

    /// Its sound on track 1 and its picture on track 2, a frame every 40 ms, the last one of a
    /// group, which says it lasts 40 ms.
    fn video() -> Vec<u8> {
        let mut segment = element(INFO, &number(TIMESTAMP_SCALE, 1_000_000));
        let mut tracks = track(1, 2);
        tracks.extend(track(2, VIDEO));
        segment.extend(element(TRACKS, &tracks));
        segment.extend(cluster(
            0,
            &[simple(2, 0), simple(1, 0), simple(2, 80), simple(2, 40)],
        ));
        let mut group = element(BLOCK, &simple(2, 0)[5..]);
        group.extend(number(BLOCK_DURATION, 40));
        segment.extend(cluster(120, &[element(BLOCK_GROUP, &group)]));
        let mut bytes = element(0x1A45_DFA3, &[0x42, 0x82, 0x84, b'w', b'e', b'b', b'm']);
        bytes.extend(open(SEGMENT, &segment));
        bytes
    }

    fn read(bytes: &[u8], chunk: usize) -> Option<Vec<f64>> {
        let mut frames = MatroskaFrames::new();
        bytes.chunks(chunk).for_each(|part| frames.read(part));
        frames.frames()
    }

    fn milliseconds(times: &[f64]) -> Vec<f64> {
        times
            .iter()
            .map(|time| (time * 1e6).round() / 1e3)
            .collect()
    }

    #[test]
    fn a_video_shows_its_frames_in_order_whatever_the_chunks_it_reads() {
        let bytes = video();
        for chunk in [1, 3, 7, 64, bytes.len()] {
            assert_eq!(
                read(&bytes, chunk).map(|times| milliseconds(&times)),
                Some(vec![0.0, 40.0, 80.0, 120.0, 160.0]),
                "{chunk}"
            );
        }
    }

    #[test]
    fn a_duration_of_another_track_leaves_the_frame_before_as_it_was() {
        let mut tracks = track(1, 2);
        tracks.extend(track(2, VIDEO));
        let mut segment = element(TRACKS, &tracks);
        let mut group = element(BLOCK, &simple(1, 40)[5..]);
        group.extend(number(BLOCK_DURATION, 1000));
        segment.extend(cluster(
            0,
            &[simple(2, 0), simple(2, 40), element(BLOCK_GROUP, &group)],
        ));
        let times = read(&open(SEGMENT, &segment), 64).unwrap();
        assert_eq!(milliseconds(&times), [0.0, 40.0, 80.0]);
    }

    #[test]
    fn a_cluster_of_unknown_size_ends_where_another_starts() {
        let mut segment = element(TRACKS, &track(1, VIDEO));
        segment.extend(open(
            CLUSTER,
            &[number(TIMESTAMP, 0), simple(1, 0)].concat(),
        ));
        segment.extend(open(
            CLUSTER,
            &[number(TIMESTAMP, 33), simple(1, 0)].concat(),
        ));
        segment.extend(element(0x1C53_BB6B, &[0; 12]));
        let times = read(&open(SEGMENT, &segment), 5).unwrap();
        assert_eq!(milliseconds(&times), [0.0, 33.0, 66.0]);
    }

    #[test]
    fn a_video_without_a_picture_or_cut_short_tells_no_frames() {
        let mut sound = element(TRACKS, &track(1, 2));
        sound.extend(cluster(0, &[simple(1, 0), simple(1, 20)]));
        assert_eq!(read(&open(SEGMENT, &sound), 64), None);
        let bytes = video();
        assert_eq!(read(&bytes[..60], 64), None);
        // Its first cluster alone, cut in its last frame.
        let cut = read(&bytes[..bytes.len() - 60], 64).unwrap();
        assert_eq!(milliseconds(&cut), [0.0, 40.0, 80.0, 120.0]);
        let mut broken = bytes.clone();
        broken.extend([0; 32]);
        assert_eq!(read(&broken, 64), None);
    }

    #[test]
    fn frames_shown_before_the_video_starts_show_from_its_start() {
        let mut straddles = element(TRACKS, &track(1, VIDEO));
        straddles.extend(cluster(0, &[simple(1, -20), simple(1, 20), simple(1, 60)]));
        let times = read(&open(SEGMENT, &straddles), 64).unwrap();
        assert_eq!(milliseconds(&times), [0.0, 20.0, 60.0, 100.0]);
        let mut before = element(TRACKS, &track(1, VIDEO));
        before.extend(cluster(0, &[simple(1, -40), simple(1, 0), simple(1, 40)]));
        let times = read(&open(SEGMENT, &before), 64).unwrap();
        assert_eq!(milliseconds(&times), [0.0, 40.0, 80.0]);
    }
}
