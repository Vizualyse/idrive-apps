# vizualyse-cast

A tech demo for the iDrive 7 head unit: play a stream URL from your phone on
the instrument cluster or the HUD, with its sound through the speakers.

1. The head unit is on your phone's hotspot (mgu-uplink).
2. Open **Cast** (the iDrive app, apps/vizualyse_cast) and scan its QR code
   with the phone. The cluster can show the QR code while idle too (off by
   default: with navigation up the cluster's direction list covers it).
3. On the page, either a **Stream URL** (a file, HLS `.m3u8`, `rtsp://`,
   `rtmp://`) to **Cluster map**, **HUD**, **Media console** or **Audio only**,
   with sound on or off and the volume; or the **Central screen**, mirrored to
   the cluster map or the HUD. Then **Play**.

**Cast to cluster: on / off** on the iDrive page turns the whole service off
(nothing plays, no QR code, the phone page closed) and is kept across restarts.

## Mirroring the central screen

BMW's own `winston-grabber` encodes the central screen (`center`, 1920x720)
in hardware at full size, at the mirror's frame rate, and sends MPEG-TS to a
local UDP port (each mirror the next of 8482-8489, so one never waits for the
one it replaces); ffmpeg reads it with no buffering, cuts out a layout and
scales it for the target.

| Layout | What goes out |
|---|---|
| CarPlay map | the CarPlay screen right of its dock, at the cluster map's 2.27:1 |
| Whole screen | everything, letterboxed |
| Google Maps (cluster) | CarPlay with Google Maps, for the cluster map: the clean map around the car (right of Google's buttons, left of its cards, down to the street-name card under the car) fills the frame; the direction card and the arrival / time / distance card ride on it, one height, side by side, centred along the top. Nearly full size (1052x410) at 8 fps, inside cluster-render's 5500 KB/s |
| Google Maps (HUD) | the direction card over the readouts on the left, the map on the right, inside the HUD's visible band (25-65 % of its height, 17-83 % of its width), at 15 fps |

A layout is either an overlay (a base region filling the frame, cards on
it) or columns side by side at one height, each a stack of regions (`CROPS`
in server.js, in screen pixels). Every frame is a multiple of 4 wide, as
cluster-render requires of a video layer. On the cluster map a mirror keeps
to 8-96 % of the height, clear of the gauge surround's fade. The page's preview is a
snapshot of the central screen (`/api/screen.jpg`) with the regions outlined.
It mirrors what the central screen shows: open CarPlay first.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | the page on port 8480 (token in the QR link), the QR code and the video layer through cluster-render, starts ffmpeg and the audio player |
| `proxy.js` | uid 12999 | an HTTP/CONNECT proxy on 127.0.0.1:8481; mgu-uplink routes this uid (never root) through the phone, and names resolve through the uplink's DNS, since the head unit's own resolver does not resolve internet names |
| `ffmpeg` | root | static build, reads the stream through the proxy and writes I420 frames (stdout) and S16LE 48 kHz stereo (fd 3) |
| `pcm_play.py` | root, mgu-python | plays the audio into SmartXbar's `CarPlayMain_CF_48_STEREO` source |
| `console_out.js` | root | the media console output: frames into mgu-render's frame file `/dev/shm/mgu-video-vizualyse_cast` (MGVF, 3 slots), drawn by an mgu-render client in layer mode in the screen's app area |
| `firewall.js` | root | one in-memory nftables rule letting the phone reach port 8480 on `wlan0`; added at start (while on), removed at stop, when turned off and by the tool's `deactivate` |
| `control.js` | root | the iDrive app's socket, `/dev/shm/vizualyse-cast/ctl.sock` (group tm_oap_app): status, stop, replay, mirror, enable, disable, the cluster QR code |
| `winston-grabber` | root | the head unit's own screen grabber, for the central-screen source |

Frame sizes keep within cluster-render's 5500 KB/s upload ceiling:
512x288 at 15 fps on the map, 480x270 at 15 fps on the HUD, there in the band between its clipped top and the
car's speed (25 % to 65 % of the height). ffmpeg decodes in software on the
Atom A3960's four cores.

Sound reaches the speakers while the audio manager has `CarPlayMain`
connected (CarPlay the source, or nothing else playing); the first play
after the head unit starts can take a while to connect.

## Build and install

`node tools/fetch_ffmpeg.js` (the tool's `build`) downloads the pinned
static ffmpeg into `build/`. `release/release.js` packs the tool kit and
publishes it in the fork's `catalog` release; add the fork as a Store source
on **Releases** and install **Cast to cluster**. It requires cluster-render,
mgu-python and mgu-uplink.

## Licenses

GPL-3.0-or-later (`LICENSE`). `cluster_render_client.js` is MPL-2.0
(`LICENSES/MPL-2.0.txt`), Robert Nisipeanu's client for
[cluster-render](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render). `qrcode.js` is Kazuhiko Arase's QR Code Generator,
MIT. The bundled ffmpeg is John Van Sickle's static build, GPLv3
(`ffmpeg-GPLv3.txt`; source at https://ffmpeg.org).
