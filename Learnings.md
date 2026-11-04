# Learnings

What we found out building Cast to cluster on a BMW iDrive 7 (MGU) bench
head unit: what the unit is, what works, what does not, and why. Measured
on one unit (head unit software `I_21w12.2-1-4`, CarPlay `20.40.2`) unless a
line says otherwise.

## The head unit

- x86-64 Linux, kernel 4.14, Intel Atom A3960 (4 cores), about 5.6 GB RAM,
  Node 8.16 for apps. The root filesystem is read-only; `/var/opt` is
  writable (9 GB free) and is where Store tools live.
- The journal is in RAM (`/var/log` -> `volatile/log`): nothing survives a
  restart, and it can rotate within minutes. Anything you need after a crash
  has to be written to `/var/opt` (or `/run` for one boot).
- A `var-opt-ro` drop-in (run just before `/var/opt` goes read-only) was
  missed at the first `systemctl reboot` after it was installed, and ran at
  later ones. Don't rely on a clean-shutdown mark alone to detect a crash;
  watch the service instead. Whether it runs at a real switch-off is not yet
  checked.
- The debug image regenerates its SSH host key at every boot: expect SSH's
  "host identification has changed" after each restart, and check the new
  fingerprint before accepting it.
- An unlisted program that dumps core can make the crash handler restart the
  head unit. Run hand-started test processes with `RLIMIT_CORE=1`; Store
  tools get it from the deploy tool's drop-in.
- Firewall: nftables `ip filter input` ends in a drop. New ports from the
  phone's hotspot (`wlan0`) need a rule; an inserted rule is in memory only.
- `nft` prints well-known ports by name (`tcp dport ssh`, not `22`). The
  MGU-SSH firewall keeper matched the number, so it added a duplicate rule
  every 15 s (641 per chain); fixed locally to match both spellings.

## Internet (mgu-uplink)

- mgu-uplink puts the head unit on the phone's hotspot, but routes **only
  listed uids** (`/var/opt/mgu-uplink/uids.d/`, a policy-routing table).
  It deliberately ignores uid 0: root never gets the internet.
- The unit's own resolver (127.0.0.1) does not resolve internet names. Use
  the uplink's DNS (the phone, from `/run/mgu-uplink/lease.json`).
- The firmware has no public CA bundle (only BMW's). Node carries its own;
  curl needs one supplied.
- What works: a small proxy running as an allowed uid (12999), resolving
  through the phone's DNS, with ffmpeg pointed at it (`http_proxy`). A Store
  tool declares `"internet": true` and its uids; the Store writes the
  uplink entry.
- iPhone hotspots disappear when idle: keep Settings > Personal Hotspot open
  (and Maximize Compatibility on) while the head unit joins.

## CarPlay on this firmware

- `/usr/bin/carplay` 20.40.2 and Cinemo's `libNmeCarPlay.so` (built Aug
  2020) support **one screen only**: SETUP takes stream type 110 only, and
  none of Apple's `altScreen` / `viewAreas` / `safeArea` keys exist. There is
  no gate to flip.
- **But the second screen can be added.** Cinemo wraps Apple's own AirPlay
  receiver code (`AirPlay/320.17.6`), and a screen is a self-contained object,
  so a hook can create a second one. `hook111` (`native/hook111`, from `re/`), preloaded into the
  stock `carplay`, gets the phone to stream its cluster view as stream 111:
  Google Maps' cluster map, 1088x480 H.264 at about 16 fps, next to the main
  screen. Details: [`re/STATUS.md`](re/STATUS.md).
- What the phone (iOS 26.7.1) needs: `enabledFeatures [altScreen]` and a
  second `/info` display record (`features=2`). Offering `viewAreas` without
  the matching records makes it refuse every session. Keyframe requests for
  111 must name the display (`forceKeyFrame {uuid}`). Answering `suggestUI`
  with a guessed `showUI` makes it give up the main screen.
- Swapping the 2022 `carplay` / `libNmeCarPlay` onto this firmware is
  **untested** (`carplay` loads about 90 libraries, many version-tagged to
  this firmware).
- CarPlay does negotiate `turn_by_turn`: route guidance reaches the car (the
  cluster's own direction list during navigation comes from it).
- `carplay` runs as `cia_13002`. A crash in anything preloaded into it takes
  CarPlay down; never restart it by hand, arm and reboot instead.
- Over the air: no update was offered for this unit. A dealer (ISTA) or
  BMW AOS programming would replace the debug image (and root).

## The cluster and the HUD (cluster-render)

- cluster-render draws apps' layers on three targets: `map` (the centre of
  the cluster, 1088x480), `panel` (the whole cluster, 1920x720, over the
  gauges) and `hud` (800x480).
- **Video layers must be a multiple of 4 wide** (and even high), or the
  renderer refuses the layer and the frames go nowhere.
- Upload ceiling about **5500 KB/s** shared: a 1088x422 I420 frame is about
  690 KB, so near full size means about 8 fps; 15 fps needs about 2/3 size.
  The renderer scales a layer up, so a smaller frame shown larger is cheap.
- Layer classes matter: an **overlay** never takes a slot on its own; a
  **content** layer does. `prewarm` asks for the slot before the first frame
  (avoids handing the slot back while ffmpeg starts); `contend` takes it
  from the stock content ("take-over").
- The cluster decides who holds the centre. With its own map up it keeps
  re-mapping it: on this bench a take-over could take ~30 s of retries
  (flicker). With navigation running, or **Instrument cluster > Central
  display area > Off**, the slot is free and ours shows at once.
- The cluster draws some of its own things **over** third-party content:
  the direction list during navigation, a media widget (with sound on the
  CarPlay channel), parts over the whole-panel target. Nothing can be drawn
  above those.
- **Pressing BC while our layer held the centre left the cluster broken
  until a full car restart** (a head-unit reboot did not fix it). Not yet
  understood; suspected: the take-over colliding with the cluster changing
  its content. Treat take-over as risky.
- The cluster map's top and bottom are dimmed by the gauge surround (about
  y 72-440 of 480 is clean).
- The HUD: its top is clipped and its own speed sits at the bottom. The
  visible part is about 25-65 % of the height and 17-83 % of the width.

## The central screen

- **mgu-render** draws on the central display: video through a frame file
  (`/dev/shm/mgu-video-<name>`, a 64-byte "MGVF" header and 3 I420 slots)
  plus a draw op at least once a second. Root clients are exempt from its
  foreground gate. Worked on this unit (its docs listed iDrive 7 video as
  untested).
- An iDrive app page shows a PNG through `LT_Label_1Graphic_Scalable`: write
  it world-readable in `/dev/shm`, `createResourceHandles`, then
  `setValue(0, 'Graphic', file, 'ResourceId')`; a new file name for each new
  image.
- **BMW's `winston-grabber`** captures the composited central screen
  (`--screen center`, 1920x720 @ 60 Hz) and encodes it in hardware
  (`h264_msdk`), to a file, JPEG, or MPEG-TS over UDP (`udp://` pipeline).
  That is the mirror: grab, then ffmpeg cuts out what goes to the cluster.
  It mirrors what the screen shows, so CarPlay must be in front, and BMW's
  pop-ups come along. The CarPlay second screen (above) replaces it.
- Google Maps in CarPlay (dock on the right): the direction card at about
  x 1112-1762, y 4-206; the arrival / time / distance card at about y
  576-716; the clean map between Google's buttons (x < 125) and its cards
  (x > 1110). The map is as zoomed out as Google Maps draws it: zoom in
  Google Maps to see more.
- Two ffmpegs on one UDP port fail: a mirror replacing another must use
  another port (ffmpeg's "Inappropriate ioctl for device" is a failed bind).

## Sound

- Every source writes to a named SmartXbar input (`smartx:<name>`); the
  audio manager decides which reaches the speakers. `CarPlayMain_CF_48_STEREO`
  plays while CarPlay is (or nothing else is) the source.
- No `aplay` on the unit: Python (mgu-python 3.12) with ctypes and
  libasound works with nothing to compile.
- The first open of an input after boot can take a long time to connect
  (2 s of audio took 52 s once); after that it is real time.

## Video and decoding

- No usable decoder on the unit for arbitrary streams: a static ffmpeg
  (John Van Sickle's 7.0.2 build) runs fine and decodes in software at low
  CPU for these sizes (about 4-5 % for the mirror at 8 fps).
- I420 to cluster-render's 4:2:0 atlas: the Y plane, then each chroma row as
  its U half followed by its V half.
- Raw H.264 (`-f h264`, e.g. from a TCP listener) with **`-fflags nobuffer`**
  gives **no frames at all** through an `fps` filter (ffmpeg 7.0.2). For a
  fast start use a small probe instead (`-probesize 32768 -analyzeduration
  0`): the first frame within a second, where default probing held it back
  3 s.

## The Store

- Tools need a **Releases catalog**: a repo tree only takes tools committed
  prebuilt. The **Branch** channel reads `mgu-repo.json`; **Tags** reads the
  highest tag (a fork's inherited tags point at the upstream's commit).
- An app's `package.json` `files` must all exist in the package, or the
  build on the unit refuses it ("files[] names CHANGELOG.md, which is
  missing").
- Publishing runs only in GitHub Actions (`release.js` refuses elsewhere).
  Builds are reproducible: two clean builds give the same bytes.
- Store sources: the head unit fetches only while the uplink is online; with
  no network the updater answers from what it already has.

## Working on the bench

- Test frames and filter graphs on a PC first: a still from
  `winston-grabber -n 1 x.jpg` or a few seconds of its UDP stream through the
  same ffmpeg build in a Linux container, then the unit.
- Looped or generated ffmpeg inputs never end: a test with them can write
  gigabytes; bound every test run.
