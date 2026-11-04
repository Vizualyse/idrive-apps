# CarPlay second screen on the iDrive 7 MGU: status

Status as of 2026-11-04. Addresses and how each finding was established:
[findings-20.40.2.md](findings-20.40.2.md). How to run everything:
[README.md](README.md). Prior work by others: [references.md](references.md).
What's next: [`../TODO.md`](../TODO.md).

## The goal

CarPlay's instrument-cluster map (AirPlay screen stream 111, the "alternate
screen") on this head unit, which runs `carplay` 20.40.2 with Cinemo's
`libNmeCarPlay.so`. That library only supports the main screen. Every patch
or piece of reverse engineering must be testable off the car first.

## Where it stands

**It works.** `hook111` 0.0.6, preloaded into the stock 2020 `carplay`, gets
the phone to stream its cluster view (Google Maps, 1088x480 H.264) next to the
main CarPlay screen, and hands it out on `127.0.0.1:6111`. Confirmed on the
car with navigation running; the main screen kept working and `carplay` never
restarted.

**It is not on the car now.** The hand-installed copy was removed on
2026-11-04; nothing of it is left on the unit (the `carplay` that was running
then keeps it in memory until its next start). How it goes back on (mgu-deploy
from the Store, or by hand) is undecided. It stays out of `native/` until then:
`release.js` publishes every `native/` tool on a full release.

Nothing consumes the stream yet. The next step is vizualyse-cast reading
`6111` instead of grabbing the central screen (TODO.md).

## What's in `re/`

| File | Purpose | Tests |
|---|---|---|
| `pull_unit.sh`, `unit/facts.sh` | Read-only pull from the unit (takes `SSH_KEY`). Never stops or restarts `carplay`. | |
| `docker/Dockerfile` | Analysis image `idrive-re:ghidra-12.1.4` (Ghidra checksum verified, JDK 21, binutils, pyelftools, gcc). | |
| `survey.py` | Each binary's identity and loading, where the second-screen keywords appear; the swap check for another firmware's binaries. | `test/selftest.sh`: 12 |
| `ghidra/*.java` | Keyword and 110/111 export, Apple function names from log strings (345), decompiling. | |
| `harness/Dockerfile` | Ubuntu 18.04 image matching the unit's glibc 2.27 and OpenSSL 1.1 (`ffmpeg.Dockerfile` adds ffmpeg, tests only). | |
| `harness/screen_b.c` | A second screen object inside the real library (`aes`, `chacha`, `chacha-tamper`). | pass |
| `harness/hook111.c` / `.h` | The hook: SETUP, TEARDOWN, `/info`, session commands, frames, the plist log, the mode file, the bench channel. | `setup_b.c`: 52 |
| `harness/annexb.c`, `sink_annexb.c` | Screen B's sink: Annex-B H.264 to `127.0.0.1:6111`, never blocks, reconnects, resumes at an IDR. | `annexb_test.c`: 22 |
| `harness/preload.c` | `libhook111.so`: installs the hook when Cinemo `dlopen`s the plugin. | `preload_test.c`: 23 |
| `deploy/hook111/` | Arm step (busybox ash), units, drop-ins, `component.json` (mgu-deploy, untested), `bench/make_command.py`. | `test/arm_test.sh`: 48 |

Data pulled from the unit stays outside the repository, in
`../idrive-rootfs/20.40.2/` (`facts.txt`, `rootfs.tar`, `nft-ruleset.txt`)
and the docker volume `idrive-rootfs-20.40.2`.

Build: `node release/tool_artifact.js re/deploy/hook111 --out <dir>` gives
`hook111@<version>.tgz`, byte-identical across builds. The library needs
nothing newer than GLIBC_2.17 and exports only `dlopen` and
`hook111_preload_state`.

## What the car showed (2026-11-04)

Phone: iPhone16,2, iOS 26.7.1, AirPlay `sourceVersion` 960.13.1. Wireless
CarPlay.

| Version | Change | On the car |
|---|---|---|
| 0.0.1 | First install, disabled | A stock boot with it installed: no preload, arm step `not armed: disabled`. |
| 0.0.2 | Armed; watcher records a crash at once | The phone refused every session: it read `/info`, then a full TEARDOWN, "connection failed" every 10 s. We had answered `enabledFeatures [altScreen, viewAreas]`. |
| 0.0.3 | Mode file (`off` / `alt` / `full`), fallback to `off` after 3 refusals | `off`: stock behaviour. `alt` (`altScreen` only): the phone set up stream 111 and connected to 6031, but no frame reached the sink. |
| 0.0.4 | Status file, bench channel, cap for noisy commands | **The stream, end to end.** About 16 fps, 6063 frames in 6 minutes. Captured from 6111: 1088x480 H.264 High, 0 decode errors. |
| 0.0.5 | Keyframe requests name the display; the sink reconnects | A fresh consumer got the stream in 0.19 s. But the hook's answer to `suggestUI` cost the main screen. |
| 0.0.6 | `suggestUI` logged, not answered | Main screen and cluster stream both fine, with navigation running. |

The capture shows a real location; it stays off the repository.

## Protocol facts learned on the car

- **`altScreen` alone is enough.** SETUP answers `enabledFeatures
  [altScreen]`, `/info` carries a second display record (1088x480,
  `features=2`, its own `uuid`). No `suggestUI` / `showUI` exchange is needed
  to stream.
- **`viewAreas` breaks it.** Offering it (mode `full`) without the records the
  phone expects made it refuse every session.
- **The stream-111 SETUP:** `{type:111, uuid:<our display's uuid>,
  latencyMs:75, streamConnectionID}`, answered `{type:111, dataPort:6031}`.
  The phone sends AVCC (39 bytes), then frames.
- **Keyframes must name the display.** The stock `forceKeyFrame` (no params)
  never brought an IDR on 111 (167 requests); `forceKeyFrame {uuid}` brings
  one within 0.5 s.
- **`suggestUI {urls: []}` must not be answered with a guess.** `showUI {url,
  uuid}` made the phone hand the main screen back to the car (`modesChanged`
  screen → entity 2, TEARDOWN of 110), then repeat ~39 s sessions without
  it.
- **Noisy commands.** `iAPSendMessage` arrives hundreds of times in minutes;
  it filled the first plist log.
- **The shutdown mark can't be relied on alone.** It was missing at the first
  `systemctl reboot` after the install, and written at later ones (the 11:50
  boot logged "healthy, carplay running at its shutdown"). Hence the
  `hook111-health` watcher, which records a failed run the moment it ends.
  Whether the mark is written at a real switch-off is not yet known.
- **The unit's journal is volatile** and had rotated within 5 minutes; the
  state file and plist log are the record. sshd's host keys are new at every
  boot.

## Open questions

- What `viewAreas` / `safeArea`, `showUI` and `primaryInputDevice` should
  contain.
- Whether the phone keeps streaming 111 while CarPlay isn't on the main
  screen.
- Whether the shutdown mark is written at a real switch-off.
- Long-run stability, and wired CarPlay as well as wireless.
- In parallel: the 22.28.3 `carplay` and Cinemo files from the upstream owners,
  to diff against 20.40.2 and see what Cinemo added.

## Before the next armed boot

- `getcap /usr/bin/carplay` is empty (`carplay` runs as `cia_13002`; file
  capabilities would make glibc ignore the preload).
- `cia_13002` can read `/var/opt/hook111/current/libhook111.so`.
- Nothing else uses 127.0.0.1:6111.
- Install disabled (`hook111-arm.sh disable`), then `enable` and reboot. Never
  restart `carplay` by hand.
- Set the mode with `hook111-arm.sh mode alt`; check with `hook111-arm.sh
  status` and `/run/hook111/log/status`.

## Risks

- **Cluster take-over has broken the cluster before,** until a full car
  restart (`Learnings.md`). Test with navigation running or the cluster's
  central area off.
- **A crash in the hook takes down `carplay`.** The prologue and build-id
  checks refuse anything unexpected; the arm step goes stock after two failed
  starts. That recovery has been tested off-car only.
- **A partial install** (an `mprotect` failing partway) would leave the
  ScreenStream replacements live without the rest. They behave like stock for
  every other context, but this hasn't been tested.

## Corrections along the way

- The 2022 swap was stated as a proven failure; it is untested.
- The Audi approach was first judged not to transfer; it does (same Apple
  code underneath).
- bmw.com/update doesn't serve the iDrive 7 MGU.
- `FUN_00166c40` was a false positive for 110/111 (a hash function).
- The SETUP harness crash was the harness, not the hook (a fake session
  missing constructor state, a fake config item of the wrong size).
- Found by off-car tests before anything reached the car: screen B never torn
  down; the library's accept can't be woken; the arm step never armed without
  a config file; `run.sh harness-annexb` passing over a failed check.
- Found on the car: the `viewAreas` refusal, the keyframe `uuid`, the sink
  never reconnecting after a refused connect, the `showUI` guess.
