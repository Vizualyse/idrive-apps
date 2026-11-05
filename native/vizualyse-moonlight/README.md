# vizualyse-moonlight

**Moonlight** for the iDrive 7 head unit: games streamed from a PC running
[Sunshine](https://github.com/LizardByte/Sunshine) (the GameStream protocol)
to the central screen, with their sound through the car's speakers and game
controllers. For use while parked. Experimental: tested off the car against
a real Sunshine (below), not yet on a car.

1. On the PC: install and run Sunshine, and put the PC on the same Wi-Fi as
   the car (the phone's hotspot, which the head unit is on through
   mgu-uplink).
2. Open **Moonlight** (the iDrive app, [apps/vizualyse_moonlight](../../apps/vizualyse_moonlight))
   and scan its QR code with the phone.
3. On the phone page: **Add** the PC's address, then **Pair**. The page shows
   a 4-digit PIN. On the PC open Sunshine's page (https://localhost:47990),
   go to **PIN**, pick the request from **iDrive** and type the PIN.
4. Pick a game, the resolution, frame rate and bitrate, and **Play**.
   **Stop** leaves the game running on the PC (Play then resumes it); **Quit
   game** closes it.

Controllers: a USB or Bluetooth gamepad connected to the car (found through
`/dev/input`, hot-plugged), and the phone page's own on-screen pad while a
stream runs. Up to four.

## How it works

| Part | Runs as | Does |
|---|---|---|
| `server.js` | root | the phone page on port 8490 (token in the QR link); the PCs, pairing and the games; starts the stream's processes; the iDrive app's socket |
| `gamestream.js` | root | GameStream over HTTP / HTTPS: serverinfo, PIN pairing, the app list, launch / resume, quit. The host's certificate from pairing is pinned on every HTTPS request after |
| `moonlight-core` | root | C, on [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c): the stream itself (RTSP, the control stream, video and audio over UDP with FEC). H.264 Annex B on stdout, audio decoded (Opus) to S16LE 48 kHz stereo on fd 3, events as `@{json}` lines on stderr, commands (the phone pad, keys, quit) on stdin. Reads the gamepads from evdev itself (`core/pads.c`). `gencert` makes the client certificate |
| `ffmpeg` | root | the same static build as Cast's, decoding the H.264 in software (4 slices a frame, decoded on 4 threads) to I420 |
| `console_out.js` | root | the frames into mgu-render's frame file `/dev/shm/mgu-video-vizualyse_moonlight`, shown centred in the screen's app area (as Cast's media console) |
| `pcm_play.py` | root, mgu-python | the audio into SmartXbar's `CarPlayMain_CF_48_STEREO` |
| `firewall.js` | root | in-memory nftables rules: the page's TCP 8490 on `wlan0` while on; UDP from the PC being streamed (47998-48000) while streaming |
| `control.js` | root | the iDrive app's socket, `/dev/shm/vizualyse-moonlight/ctl.sock`: status, enable, disable, stop, quit, resume |

State in `/var/opt/vizualyse-moonlight/state`: the page token, the settings,
the client's identity (`identity/`: certificate, key, unique id; the key
0600) and the paired PCs (`hosts.json`, with each PC's certificate).

## Off the car

`sh build.sh` builds `build/moonlight-core` in `image/Dockerfile` (Ubuntu
18.04, gcc 8: the unit's glibc 2.27 and OpenSSL 1.1; libopus linked in) and
runs `core/pads_test.c` (the evdev mapping: xpad and Bluetooth layouts,
sticks, triggers, the hat) first. It refuses a binary needing a newer glibc
or a library the unit lacks.

`sh test/run_sunshine_test.sh` runs the tool against a real Sunshine
(`test/sunshine`: LizardByte's image on Xvfb, software x264, PulseAudio on a
null sink) from the head unit in a box (`test/unit`: Ubuntu 18.04 with Node
8.16.2, the unit's versions):

- `test/sunshine_test.js`: the client certificate; a wrong PIN refused; PIN
  pairing; HTTPS with the pinned certificate (and another refused); the app
  list; a launch and a 10 s stream through moonlight-core and ffmpeg (about
  300 frames at 1280x720@30 decoded, audio decoded); stop, resume, quit.
- `test/server_test.js`: `server.js` through the phone page's API and the
  iDrive app's socket, with stand-ins for mgu-render and the speakers
  (`test/fake`): add, pair, play (frames in the frame file, audio to the
  player), the phone pad, stop, resume, quit, off / on; with a virtual USB
  gamepad (`test/uinput_pad.c`, through `/dev/uinput`): found while idle,
  announced to the PC while streaming, unplugged mid-stream.

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

- Whether the Atom A3960 decodes 1280x720@60 in software in time (720p30 is
  the default), and the latency end to end.
- Whether the head unit reaches the PC on the hotspot (root has no route to
  the internet through mgu-uplink, but the hotspot's own subnet should be on
  `wlan0`), and whether the stream's UDP gets in (the host rule above).
- Which gamepad drivers the unit's kernel has (`xpad`, `hid-microsoft`,
  `hid-sony`, `hid-generic`), and pairing a Bluetooth pad with the car.
- Only while parked: nothing checks the gear or the speed yet.
- The control socket is open to every Store app, as Cast's (TODO.md).

## Build and install

`sh build.sh` (the tool's `build`) builds moonlight-core and fetches the
pinned ffmpeg (`tools/fetch_ffmpeg.js`, as Cast). `release/release.js` packs
the kit and publishes it with the catalog; install **Moonlight** (the app)
from the Store, which installs this tool first. It requires mgu-python and
mgu-render.

## Licenses

GPL-3.0-or-later (`LICENSE`). moonlight-common-c is GPL-3.0, ENet and nanors
MIT, Opus BSD-3-Clause, the bundled ffmpeg GPLv3 (`ffmpeg-GPLv3.txt`).
[THIRD-PARTY.md](THIRD-PARTY.md), shipped in the kit, names the exact
versions and where their source is.
