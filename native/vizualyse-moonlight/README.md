# vizualyse-moonlight

**Moonlight** for the iDrive 7 head unit: games streamed from a PC running
[Sunshine](https://github.com/LizardByte/Sunshine) (the GameStream protocol)
to the central screen, with their sound through the car's speakers and game
controllers. Only while parked (the iDrive app tells it the car's speed).
Experimental: tested off the car against a real Sunshine (below), and on a
car (0.1.x, decoding in software).

1. On the PC: install and run Sunshine, and put the PC on the same Wi-Fi as
   the car (the phone's hotspot, which the head unit is on through
   mgu-uplink).
2. Open **Moonlight** (the iDrive app, [apps/vizualyse_moonlight](../../apps/vizualyse_moonlight))
   and scan its QR code with the phone.
3. On the phone page: **Add** the PC's address, then **Pair**. The page shows
   a 4-digit PIN. On the PC open Sunshine's page (https://localhost:47990),
   go to **PIN**, pick the request from **iDrive** and type the PIN.
4. Pick a game, the resolution and frame rate (the bitrate follows them,
   or set it by hand), and **Play**.
   **Stop** leaves the game running on the PC (Play then resumes it); **Quit
   game** closes it.

Controllers: a wired Xbox 360-style (XInput) USB pad plugged into the car,
read straight through usbfs (hot-plugged), evdev gamepads where the kernel
has them (not on the car), and the phone page's own on-screen pad while a
stream runs. Up to four.

On the car, the kernel (4.14.147-apl, its config in `configs.ko`) has no
evdev, HID, uinput, joydev or Bluetooth HID, and `CONFIG_MODULE_SIG_FORCE=y`
refuses any module not signed by BMW: no gamepad driver can be added. But the
USB port is in host mode and usbfs is there (seen 2026-11-05): a wired
Flydigi Vader 4 Pro enumerates as an Xbox 360 pad (`045e:028e`, one
interface `ff/5d/01`, interrupt IN `0x81` / OUT `0x05`, 1 ms), no driver
bound, its node `/dev/bus/usb/001/NNN` `root:mgu_usb 0660`. It shows up as
`04b4:2412` for ~11 s first, then re-enumerates as the 360 pad. Read by
hand, its interface gave the standard 20-byte XInput reports, and the LED
command `01 03 06` on `0x05` was accepted. moonlight-core does the same
while streaming: any `ff/5d/01` interface no driver holds is claimed, its
LED set to the player, its reports read with one interrupt URB at a time.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | the phone page on port 8490 (token in the QR link); the PCs, pairing and the games; starts the stream's processes; the iDrive app's socket |
| `gamestream.js` | root | GameStream over HTTP / HTTPS: serverinfo, PIN pairing, the app list, launch / resume, quit. The host's certificate from pairing is pinned on every HTTPS request after |
| `moonlight-core` | root | C, on [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c): the stream itself (RTSP, the control stream, video and audio over UDP with FEC). Decodes the video itself (`core/decode.h`) straight into an mgu-render frame file: on the GPU through the unit's Intel Media SDK (`core/decode_msdk.c`, ported from upstream's waze-on-cluster), else FFmpeg 6.1.2's H.264 decoder built in (`core/decode_av.c`). A frame gets no picture while more wait behind it, so a late one is replaced, never queued. Audio decoded (Opus) to S16LE 48 kHz stereo on fd 3, events as `@{json}` lines on stderr (`stats` every second: frames in, pictures out, skipped, ms per decode), commands (the phone pad, keys, quit) on stdin. Reads the gamepads itself, from evdev and XInput USB pads through usbfs (`core/pads.c`). `gencert` makes the client certificate |
| `console_out.js` | root | makes mgu-render's frame file `/dev/shm/mgu-video-vizualyse_moonlight` and shows it over the whole screen, black bars at the sides; the stop hint as a picture over it for 10 s (`hint.rgba`, drawn at build time). For the cluster and the HUD, a small frame file in `/dev/shm/vizualyse-moonlight/` that `server.js` packs for cluster-render |
| `pcm_play.py` | root, mgu-python | the audio into SmartXbar's `CarPlayMain_CF_48_STEREO` (heard only while CarPlay is the source: knowledge/sound.md). Makes the stream's lock as the system does (`ent_alsa:mgu_alsa` 0660) before opening: opened first by root it was root's, and CarPlay went silent until a restart (0.2.1) |
| `firewall.js` | root | in-memory nftables rules: the page's TCP 8490 on `wlan0` while on; UDP from the PC being streamed (47998-48000) while streaming |
| `control.js` | root | the iDrive app's socket, `/dev/shm/vizualyse-moonlight/ctl.sock`: status, enable, disable, stop, quit, resume, output, speed (above 3 km/h a stream stops and none starts) |

State in `/var/opt/vizualyse-moonlight/state`: the page token, the settings,
the client's identity (`identity/`: certificate, key, unique id; the key
0600) and the paired PCs (`hosts.json`, with each PC's certificate).

## Off the car

`sh build.sh` builds `build/moonlight-core` in `image/Dockerfile` (Ubuntu
18.04, gcc 8: the unit's glibc 2.27 and OpenSSL 1.1; libopus and FFmpeg's
H.264 decoder linked in; the Media SDK and libva loaded at run time) and
runs `core/pads_test.c` (the evdev mapping: xpad and Bluetooth layouts,
sticks, triggers, the hat; the XInput reports, as read on the car) first. It
refuses a binary needing a newer glibc or a library the unit lacks.

The unit's own decoder libraries, for the tests: `sh test/firmware/extract.sh`
takes them from a copy of its root filesystem (`../idrive-rootfs`, not in
git) into `test/firmware/lib` (ignored). `sh test/run_decode_test.sh` then
decodes a busy 1280x720@60 pattern (fresh noise every frame) with the unit's
software Media SDK (the GPU path's code, VPP and all) and the built-in
FFmpeg: every picture equal to ffmpeg's, also with pictures for every 3rd
frame only, and scaled to the cluster's and the HUD's sizes; and the unit's
GPU library and libva load with every symbol the decoder uses.

`sh test/run_sunshine_test.sh` runs the tool against a real Sunshine
(`test/sunshine`: LizardByte's image on Xvfb, software x264, PulseAudio on a
null sink) from the head unit in a box (`test/unit`: Ubuntu 18.04 with Node
8.16.2, the unit's versions):

- `test/sunshine_test.js`: the client certificate; a wrong PIN refused; PIN
  pairing; HTTPS with the pinned certificate (and another refused); the app
  list; a launch and a 10 s stream decoded by moonlight-core on the unit's
  software Media SDK into a frame file (300 pictures at 1280x720@30, BT.709
  in its header, audio decoded); stop; resume, decoded by the built-in
  FFmpeg and scaled to 640x360 at 15 pictures a second; quit.
- `test/server_test.js`: `server.js` through the phone page's API and the
  iDrive app's socket, with stand-ins for mgu-render and the speakers
  (`test/fake`): add, pair, the bitrate on auto by size and rate, the
  output from the iDrive app, play (decoded into the frame file, the stop
  hint drawn over it for 10 s, audio to the player), the phone pad, stop,
  resume, quit, off / on; stopped by the car's speed above 3 km/h and
  refused while moving; with virtual
  gamepads: an evdev one (`test/uinput_pad.c`, through `/dev/uinput`) and
  an XInput USB one as the car's (`test/usbip_pad.c`: a USB/IP device on
  the kernel's `vhci_hcd`, so a real `/dev/bus/usb` node with no driver,
  read through usbfs): found while idle, announced to the PC while
  streaming (the USB pad's LED set), the quit combo held on the USB pad,
  unplugged mid-stream.

What the off-car tests found:

- Sunshine 2026 lists pairing requests on its PIN page: the PIN is typed for
  a chosen request (`pairing_id`). The client's side of pairing is
  unchanged.
- Sunshine fails a resumed TLS session with an internal-error alert (Node
  8's OpenSSL 1.0.2): every HTTPS request makes a new session.
- A launch nobody connected to stays queued in Sunshine, and the next RTSP
  connection is matched to it ("Failed to verify RTSP message tag"). That
  consumes it: the tool launches once more when the RTSP handshake fails
  before any frame.
- Sunshine's audio starts a couple of seconds into a stream.

## On the car, still to find out

- Decoding on the GPU (0.2.0): that the session and VPP start on the car as
  uid 12998 after the render node was opened as root (otherwise the core
  falls back to software after 5 failed frames and says so), whether GPU
  copy (the CM runtime) works, and the cost and latency at 720p60.
- The speed: that the app's read of `Vehicle2.statusCarSpeed2` works on our
  firmware (the getter is in its catalog) and stops a stream when driving
  off.
- The output drop-down on the iDrive page.
- Pads that are not XInput (DualShock / DualSense: HID reports, readable
  through usbfs too) are not read yet; Bluetooth pads can't be (no HID in
  the kernel).

## Build and install

`sh build.sh` (the tool's `build`) builds moonlight-core and draws the stop
hint. No ffmpeg ships any more (0.2.0); `tools/fetch_ffmpeg.js` fetches the
pinned static one for the tests only. `release/release.js` packs
the kit and publishes it with the catalog; install **Moonlight** (the app)
from the Store, which installs this tool first. It requires mgu-python and
mgu-render.

## Licenses

GPL-3.0-or-later (`LICENSE`). moonlight-common-c is GPL-3.0, ENet and nanors
MIT, Opus BSD-3-Clause, FFmpeg's decoder LGPL-2.1+ (`ffmpeg-LGPL-2.1.txt`),
the Media SDK headers MIT.
[THIRD-PARTY.md](THIRD-PARTY.md), shipped in the kit, names the exact
versions and where their source is.
