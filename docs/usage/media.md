# Images and videos

Drop files or images from a web page on the board, paste them, or use Add images. Planche keeps the name of a file added from disk, without its path, and the web address of an image brought from a page. Open source opens that address again.

When a page hands over only an image's address, Planche downloads it. If that fails, copy the image in the browser and paste it, or save it and drop the file.

## Formats

Planche shows what the platform can decode, so HEIC shows only on Apple platforms. SVGs draw as images do, so their scripts never run and they load nothing from elsewhere, such as fonts or linked images. Animated GIF, PNG, and WebP files play. Videos play in MP4, QuickTime, WebM, and Matroska files, with the codecs the platform has.

- On Linux, the desktop app needs `gst-libav` to play H.264. The AppImage brings it, and the deb recommends it.
- On Windows, HEVC videos may stay blank without saying why.
- A video over 300 MB, or over 4096 pixels a side, is refused.

An image or video that this machine cannot show is crossed out. It stays on the board and shows on a machine that can.

## Playback

Animated images and videos play muted and on a loop while they show. With reduced motion turned on in the system, they stay on their first frame. Play videos on hover, in Settings, plays a video only while the pointer is on it, until you play it yourself. At most eight videos play at once, the selected one first and then the largest on screen. A hidden window pauses them all.

Select a lone animated image or video to play or pause it, step through its frames, change its speed, trim it to the part that loops, and turn its sound on or off. Trim and speed are saved in the board and shared by every copy of the same file on it. Its position, whether it is paused, and its sound last until the board closes.

## Known gaps

- Images show at most 2048 pixels on their longest side for now, so a larger photo softens when you zoom in close. PNG exports and agents' pictures draw it from the full file.
- Animated images over 2048 pixels a side, or turned or flipped by their metadata, stay still.
- An animated PNG with a colour profile may shift colours after its first frame, and so may an animated WebP in the macOS app.
- A video whose frame size changes partway, as a screen recording of a resized window may, stops at the last frame of its first size until the board opens again.
