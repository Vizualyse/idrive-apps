# vizualyse-cast

A tech demo for the iDrive 7 head unit: play a stream URL from your phone on
the instrument cluster or the HUD, with its sound through the speakers.

1. The head unit is on your phone's hotspot (mgu-uplink).
2. While idle, the cluster shows a QR code: scan it with the phone.
3. On the page: paste a URL (a file, HLS `.m3u8`, `rtsp://`, `rtmp://`),
   pick **Cluster map**, **HUD**, **Media console** or **Audio only**, sound
   on or off and the volume, then **Play**.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | the page on port 8480 (token in the QR link), the QR code and the video layer through cluster-render, starts ffmpeg and the audio player |
| `proxy.js` | uid 12999 | an HTTP/CONNECT proxy on 127.0.0.1:8481; mgu-uplink routes this uid (never root) through the phone, and names resolve through the uplink's DNS, since the head unit's own resolver does not resolve internet names |
| `ffmpeg` | root | static build, reads the stream through the proxy and writes I420 frames (stdout) and S16LE 48 kHz stereo (fd 3) |
| `pcm_play.py` | root, mgu-python | plays the audio into SmartXbar's `CarPlayMain_CF_48_STEREO` source |
| `console_out.js` | root | the media console output: frames into mgu-render's frame file `/dev/shm/mgu-video-vizualyse_cast` (MGVF, 3 slots), drawn by an mgu-render client in layer mode in the screen's app area |
| `firewall.js` | root | one in-memory nftables rule letting the phone reach port 8480 on `wlan0`; added at start, removed at stop and by the tool's `deactivate` |

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
(native/cluster-render). `qrcode.js` is Kazuhiko Arase's QR Code Generator,
MIT. The bundled ffmpeg is John Van Sickle's static build, GPLv3
(`ffmpeg-GPLv3.txt`; source at https://ffmpeg.org).
