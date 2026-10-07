//! Whether a file is a video, from the start of its bytes: an MP4 or QuickTime movie by its
//! `ftyp` box, or by its leading atoms for an old one without, a WebM or Matroska one by its EBML
//! header.

mod boxes;
mod ebml;

pub use boxes::{MovieIndex, movie_frames, movie_index};
pub use ebml::MatroskaFrames;

/// The container a video comes in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Video {
    /// MP4 and QuickTime alike.
    Mp4,
    WebM,
    Matroska,
}

impl Video {
    /// The type of the blob a host plays it from. WKWebView refuses some untyped ones, and
    /// Chromium and WKWebView both play a QuickTime movie typed as MP4.
    pub fn mime(self) -> &'static str {
        match self {
            Self::Mp4 => "video/mp4",
            Self::WebM => "video/webm",
            Self::Matroska => "video/x-matroska",
        }
    }
}

/// `None` when the bytes do not start as a video, of which the first kilobyte or so suffices.
pub fn video(bytes: &[u8]) -> Option<Video> {
    movie(bytes).or_else(|| matroska(bytes))
}

/// Major brands of movies.
const MOVIES: [&[u8; 4]; 13] = [
    b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"dash", b"M4V ",
    b"M4VH", b"M4VP", b"qt  ",
];
/// Major brands of pictures, still or animated, and of sound, whose compatible brands may name
/// movies.
const NOT_MOVIES: [&[u8; 4]; 13] = [
    b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1", b"avif", b"avis",
    b"M4A ", b"M4B ", b"M4P ",
];
/// Compatible brands that make a movie of a file of any other major brand, such as a phone's
/// `3gp4`. An animated AVIF lists `iso8`, so no other `iso` brand is one.
const PLAYABLE: [&[u8; 4]; 4] = [b"isom", b"mp41", b"mp42", b"qt  "];

fn movie(bytes: &[u8]) -> Option<Video> {
    if bytes.get(4..8)? != b"ftyp" {
        return old_movie(bytes);
    }
    let (major, compatible) = brands(bytes)?;
    let playable = || compatible.iter().any(|brand| PLAYABLE.contains(&brand));
    let is_movie = MOVIES.contains(&major) || (!NOT_MOVIES.contains(&major) && playable());
    is_movie.then_some(Video::Mp4)
}

/// An ISO file's major brand and the compatible ones that `bytes` hold, from its `ftyp` box.
pub(crate) fn brands(bytes: &[u8]) -> Option<(&[u8; 4], &[[u8; 4]])> {
    if bytes.get(4..8)? != b"ftyp" {
        return None;
    }
    let (start, end) = match u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) {
        // Up to the end of the file.
        0 => (8, bytes.len()),
        1 => {
            let size = u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?);
            (16, usize::try_from(size).ok()?)
        }
        size => (8, usize::try_from(size).ok()?),
    };
    // Its last compatible brands may lie past what was read.
    let brands = bytes.get(start..end.min(bytes.len()))?;
    let (major, rest) = brands.split_first_chunk::<4>()?;
    // Past the minor version.
    let (compatible, _) = rest.get(4..)?.as_chunks::<4>();
    Some((major, compatible))
}

/// Atoms that may come before an old QuickTime movie's own, which predates `ftyp`.
const LEADING: [&[u8; 4]; 5] = [b"wide", b"free", b"skip", b"pnot", b"PICT"];

fn old_movie(mut bytes: &[u8]) -> Option<Video> {
    loop {
        let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
        let kind = bytes.get(4..8)?;
        if kind == b"moov" || kind == b"mdat" {
            // 0 runs to the end of the file, and 1 has a size of 64 bits.
            return (size <= 1 || size >= 8).then_some(Video::Mp4);
        }
        if size < 8 || !LEADING.iter().any(|leading| *leading == kind) {
            return None;
        }
        bytes = bytes.get(usize::try_from(size).ok()?..)?;
    }
}

const EBML: [u8; 4] = [0x1A, 0x45, 0xDF, 0xA3];
const DOC_TYPE: u64 = 0x4282;

fn matroska(bytes: &[u8]) -> Option<Video> {
    let rest = bytes.strip_prefix(&EBML)?;
    let (size, length) = vint(rest, false)?;
    let header = rest.get(length..)?;
    // One of unknown size, or that runs past what was read, holds what there is.
    let mut header = usize::try_from(size)
        .ok()
        .and_then(|size| header.get(..size))
        .unwrap_or(header);
    while !header.is_empty() {
        let (id, id_length) = vint(header, true)?;
        let (size, size_length) = vint(header.get(id_length..)?, false)?;
        let start = id_length + size_length;
        let data = header.get(start..start.checked_add(usize::try_from(size).ok()?)?)?;
        if id == DOC_TYPE {
            // Strings may be padded with zeros.
            return match data.split(|&byte| byte == 0).next()? {
                b"webm" => Some(Video::WebM),
                b"matroska" => Some(Video::Matroska),
                _ => None,
            };
        }
        header = &header[start + data.len()..];
    }
    None
}

/// No video a board holds has more frames, nearly ten hours at 30 a second, and one that tells
/// more is broken, as reading them takes memory the core never gives back.
const MOST_FRAMES: usize = 1 << 20;

/// An EBML variable-length integer and its length in bytes. An id keeps the bit that marks its
/// length, which a size drops.
fn vint(bytes: &[u8], id: bool) -> Option<(u64, usize)> {
    let first = *bytes.first()?;
    let length = first.leading_zeros() as usize + 1;
    if length > 8 {
        return None;
    }
    let marked = if id {
        u64::from(first)
    } else {
        u64::from(first) & (0xFF >> length)
    };
    let value = bytes
        .get(1..length)?
        .iter()
        .fold(marked, |value, &byte| value << 8 | u64::from(byte));
    Some((value, length))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ftyp(major: &[u8; 4], compatible: &[&[u8; 4]]) -> Vec<u8> {
        let size = u32::try_from(16 + 4 * compatible.len()).unwrap();
        let mut bytes = size.to_be_bytes().to_vec();
        bytes.extend(b"ftyp");
        bytes.extend(major);
        bytes.extend([0; 4]);
        for brand in compatible {
            bytes.extend(*brand);
        }
        bytes.extend(b"\0\0\0\x08free");
        bytes
    }

    #[test]
    fn a_movie_is_known_by_its_major_brand() {
        for major in [b"isom", b"mp42", b"qt  ", b"M4V "] {
            assert_eq!(video(&ftyp(major, &[])), Some(Video::Mp4), "{major:?}");
        }
    }

    #[test]
    fn another_major_brand_makes_a_movie_once_compatible_with_one() {
        assert_eq!(video(&ftyp(b"3gp4", &[b"3gp4", b"isom"])), Some(Video::Mp4));
        assert_eq!(video(&ftyp(b"XAVC", &[b"mp41"])), Some(Video::Mp4));
        assert_eq!(video(&ftyp(b"XAVC", &[b"iso8"])), None);
    }

    #[test]
    fn pictures_and_sound_are_no_movies() {
        for (major, compatible) in [
            (b"avif", [b"mif1", b"miaf"]),
            (b"avis", [b"iso8", b"isom"]),
            (b"heic", [b"mif1", b"heic"]),
            (b"M4A ", [b"isom", b"mp42"]),
        ] {
            assert_eq!(video(&ftyp(major, &compatible)), None, "{major:?}");
        }
    }

    #[test]
    fn a_box_of_any_size_is_read_as_far_as_it_goes() {
        let mut large = 1_u32.to_be_bytes().to_vec();
        large.extend(b"ftyp");
        large.extend(28_u64.to_be_bytes());
        large.extend(b"XAVC\0\0\0\0mp42");
        assert_eq!(video(&large), Some(Video::Mp4));
        let mut open = ftyp(b"XAVC", &[b"mp42"]);
        open[..4].copy_from_slice(&[0; 4]);
        assert_eq!(video(&open), Some(Video::Mp4));
        let mut cut = ftyp(b"XAVC", &[b"3gp4", b"mp42"]);
        cut[..4].copy_from_slice(&64_u32.to_be_bytes());
        assert_eq!(video(&cut[..28]), Some(Video::Mp4));
        let mut small = ftyp(b"isom", &[]);
        small[..4].copy_from_slice(&12_u32.to_be_bytes());
        assert_eq!(video(&small), None);
        assert_eq!(video(&ftyp(b"isom", &[])[..12]), None);
    }

    fn ebml(doc_type: &[u8]) -> Vec<u8> {
        // Its version, then its document type.
        let mut header = vec![0x42, 0x86, 0x81, 0x01, 0x42, 0x82];
        header.push(0x80 | u8::try_from(doc_type.len()).unwrap());
        header.extend(doc_type);
        let mut bytes = EBML.to_vec();
        bytes.push(0x80 | u8::try_from(header.len()).unwrap());
        bytes.extend(header);
        // A segment follows.
        bytes.extend([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF]);
        bytes
    }

    #[test]
    fn webm_and_matroska_are_known_by_their_document_type() {
        assert_eq!(video(&ebml(b"webm")), Some(Video::WebM));
        assert_eq!(video(&ebml(b"matroska")), Some(Video::Matroska));
        assert_eq!(video(&ebml(b"webm\0\0")), Some(Video::WebM));
        assert_eq!(video(&ebml(b"other")), None);
        assert_eq!(video(&ebml(b"webm")[..8]), None);
    }

    #[test]
    fn other_files_are_no_videos() {
        for other in [
            b"".as_slice(),
            b"GIF89a\x01\x00\x01\x00",
            b"\x89PNG\r\n\x1a\n",
            b"\xFF\xD8\xFF\xE0\x00\x10JFIF",
            b"RIFF\x04\x00\x00\x00WEBP",
            b"<svg/>",
            b"\x1A\x45\xDF\xA3\x00",
        ] {
            assert_eq!(video(other), None, "{other:?}");
        }
    }

    #[test]
    fn a_video_plays_from_a_blob_of_its_type() {
        assert_eq!(Video::Mp4.mime(), "video/mp4");
        assert_eq!(Video::WebM.mime(), "video/webm");
        assert_eq!(Video::Matroska.mime(), "video/x-matroska");
    }

    #[test]
    fn a_quicktime_movie_without_ftyp_is_known_by_its_leading_atoms() {
        // Heads of real files, ftyp stripped, which Chromium and WKWebView both play.
        let wide_then_mdat = b"\0\0\0\x08wide\0\x03\x43\x97mdat";
        let moov = b"\0\0\x0b\x90moov\0\0\0\x6cmvhd";
        let free_then_mdat = b"\0\0\0\x10free\0\0\0\0\0\0\0\0\0\0\x10\0mdat";
        for movie in [wide_then_mdat.as_slice(), moov, free_then_mdat] {
            assert_eq!(video(movie), Some(Video::Mp4), "{movie:?}");
        }
        // An SVG led by a comment whose 4 first bytes would read as a 1 GB atom.
        assert_eq!(video(b"<!--free icon--><svg/>"), None);
    }
}
