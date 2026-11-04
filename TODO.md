# TODO

What's left, roughly in order. Background: [`Learnings.md`](Learnings.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

## hook111 (CarPlay's second screen)

- [x] **Into the Store.** `native/hook111` 0.1.0, published with the
  catalog; `release.js` publishes it on every full release from now on.
- [ ] **First install from the Store on the car.** Untested: mgu-deploy's
  install (recmgr entries for `hook111-arm` / `hook111-health`), and
  `systemd-analyze verify` of the units on the unit. Then `mode alt`.
  Checklist: re/STATUS.md, "Before the next armed boot".
- [x] **Display size per target (0.0.7).** hook111 reads `/run/hook111/display`
  (`WxH@fps`, written by vizualyse-cast: 1088x480@30 for the cluster map,
  1056x384@30 for the HUD) at each `/info`, validated, and reports what it
  offered (`display=` in its status). `setup_b.c`: 57 checks.
- [ ] **On the car:** whether the phone draws the HUD size it is offered
  (1056x384), and how the cluster view looks at that shape.
- [x] **The cluster view (style), a switch** (hook111 0.1.2, vizualyse-cast
  0.3.4, vizualyse_cast 0.3.2). Map and directions / map only / directions
  only. It goes into `/info`'s `initialURL` (`maps:/car/instrumentcluster`,
  `…/map`, `…/instructioncard`) from `/run/hook111/view`, read at each
  `/info`; `view=` in the status. `setup_b.c`: 76 checks.
- [x] **On the car:** the phone follows `initialURL` ("map only" dropped the
  card, 2026-11-04).
- [x] ~~Shape and vignette~~ (vizualyse-cast 0.3.5): tried on the car,
  removed in 0.3.6. The squeezed taller shape looked squashed, and no shape
  moved Google Maps' layout; the safe area does.
- [x] **The cluster map wider, at native size** (vizualyse-cast 0.3.4, then
  0.3.6): 984x480 at x 52-1036, sent as drawn at up to 20 fps;
  cluster-render's governor keeps the link to the cluster within its 5500
  KB/s cap (tried on the car at 936x480: ~14.5 fps, no budget holds).
- [x] **View areas, and centring baked in** (hook111 0.1.4, vizualyse-cast
  0.3.6, vizualyse_cast 0.3.4). Found on the car with trial files (hook111
  0.1.3, hand-installed, removed again): on 936x480, 340x330 at 298,80
  centred the car with the card above it; at y 40 both 40 px higher (the
  default now); a taller area (h 400) pushed the car down. Now a `safearea`
  file; the tool writes it, centred, behind "Centre the map" (on by default).
  The HUD shows the cluster's centred picture, or in its alternate mode the
  wide 1056x384 with no safe area. Shape and vignette removed.
- [x] **On the car (2026-11-04, hook111 0.1.4, vizualyse-cast 0.3.6) with
  the bench channel** (findings, "The cluster scene: showUI and its URL"):
  - the time / distance card: `showUI {uuid, url}` with `showETA=yes`
    (`initialURL` options are ignored); the directions card stays unless a
    `maneuverLayout` is named on the narrow area; all four card combinations
    switch live;
  - zoom in / out: `changeMapZoomLevel {uuid, zoomDirection 0 / 1}`, live;
  - layout switching: `updateViewArea {uuid, viewAreaIndex,
    adjacentViewAreas, animationDurationMillis}` with two view areas, live;
  - the layout the owner settled on: safe area 340x435 at y 20 (984x480);
  - HUD: the default (the cluster's picture) looks fine; the wide alternate
    mode is better with the time / distance card only, bottom right
    (`/map?showETA=yes`);
  - no effect: the declared physical size (150 vs 180 mm) on the card size;
    `showCompass=yes` (Google Maps draws none).
- [x] **Build it in** (hook111 0.1.5, vizualyse-cast 0.3.7, vizualyse_cast
  0.3.5): the hook sends `showUI` with the tool's URL when the stream starts
  and on a change, zoom requests, and the view area (centred / Maps' own)
  live; the tool's directions / time-distance switches and zoom buttons.
- [ ] **On the car (still to test):**
  - the speed-limit sign (`showSpeedLimit=yes`) while driving on a road with
    a known limit (none showed parked on a residential street);
  - the native-size map while driving (packed frames when it moves fast?);
  - the built-in version of the above after the next release.
- [ ] **30 fps from Maps** (now ~16-17 fps): the iAP2 IdentificationInformation
  profile ID `bf889dfdaea54096` (`mapsRefreshRate=30`, luka-dev/mib2q-carplay-rgi
  `docs/altscreen-and-video/MAPS_30FPS_PROFILE.md`). Find where our `carplay`
  sends the identification (Cinemo's iAP2 stack), add the parameter in the
  harness first.
- [ ] **Open protocol questions:** what `primaryInputDevice` should contain.
- [ ] **The session drops every ~40 s while the iDrive shows its own screen.**
  Seen on the car (2026-11-04, hook111 0.1.0, mode alt): with 111 the only
  stream (no 110 main screen, no 102 audio) the phone starts a new session every
  39-40 s (same `sessionCorrelationUUID`, new `sessionUUID`, no TEARDOWN: the
  connection just ends); the cluster stalls ~3.5 s each time. It stopped as soon
  as 110 was set up; the first session died ~28 s after its last stock stream
  (102) ended. No refusals, no fallback, `carplay` not restarted. Guess: the
  session's idle / keep-alive tracking (`_ControlIdleStateTransition`
  `0x17c0e0`; the phone sends `keepAliveLowPower`) doesn't count screen B, so
  the session is taken as idle and times out.
  - [x] **Cause found, fix tested off-car (hook111 0.1.1).** The guess was
    right. Idle, the library waits for keep-alive beacons that the phone,
    busy streaming 111, never sends, and ends the session after 30 s. hook111
    now counts screen B as a screen in the idle transition (findings, "The
    session's idle state"). `setup_b.c`: 69 checks, including the car's
    sequence; the new checks fail with the wrapper disabled.
  - [ ] **On the car (0.1.1, shipping in 0.1.2):** with 111 up, let the iDrive show its own
    screen for several minutes. Expect `sessionUUID` unchanged,
    `idle_held` > 0 and `idle_rc=0` in the status, and no cluster stall.
    Also check that the main screen still comes back.
- [ ] **On the car:**
  - whether the shutdown mark is written at a real switch-off (one ignition
    cycle, disabled);
  - long-run stability (a long drive, armed);
  - wired CarPlay as well as wireless.

## Cast to cluster (tool and app)

- [x] **The CarPlay second screen as a source** (vizualyse-cast 0.3.0): ffmpeg
  listening on `127.0.0.1:6111`; cluster map 816x360 at 12 fps, HUD 528x192 at
  15 fps in its band; the size the phone should draw written to
  `/run/hook111/display`. `test/carplay_test.js`, in CI.
- [x] **The central-screen mirror removed** (winston-grabber, the layouts).
- [x] The app's buttons (CarPlay map on the cluster / on the HUD) and the page
  test (vizualyse_cast 0.3.0, requires vizualyse-cast 0.3.0).
- [x] **The second screen's switch** (vizualyse-cast / vizualyse_cast 0.3.1):
  "CarPlay second screen: on / off" on the iDrive page and the phone page sets
  hook111's mode (`alt` / `off`) now through its arm step and saves
  `HOOK111_MODE` in its config for later starts. `carplay_test.js` covers it,
  including against the real `hook111-arm.sh`.
- [ ] **On the car:** the tool and the app, with hook111 armed in mode `alt`
  (set with the switch):
  the cluster map and the HUD, a reconnect, a phone that disconnects
  mid-stream.

## Carried over

- [ ] **No take-over on the cluster (the BC crash).** With a layer holding the
  cluster's centre, pressing BC left the cluster broken until a full car
  restart. Suspect: cluster-render's take-over (`contend: true`). Make
  `contend: false` the default for every layer (or an option, off, named for
  the risk); when a target is `parked (holder stock)`, both pages say "The
  cluster is using its centre: start navigation or set Central display area to
  Off". Then try BC 10 times with logs on. Done when no layer takes over by
  default and BC doesn't break the cluster.
- [ ] **Logs that survive a restart.** The tool's log in
  `/var/opt/vizualyse-cast/log/cast.log` (rotated at ~1 MB, 3 files), plus
  cluster-render's `dcsm` / target / take-over / refused lines from
  `journalctl -f -u cluster-render` in `render.log`. A header per start (boot
  id, versions, settings); a token-protected "Logs" link on the phone page;
  the last lines on the iDrive page. Under ~8 MB.
- [ ] **The cluster's own direction list over our layer.** With navigation
  running the cluster draws its turn list over the centre. Look for an iDrive
  setting to turn it off; otherwise an `x`/`y`/size placement per layout to
  avoid it, or prefer the HUD while navigating.
- [ ] **Control-socket hardening.** `/dev/shm/vizualyse-cast/ctl.sock` is
  0660, group `tm_oap_app`, which every Store app is in: any of them can read
  the phone link with its token and send commands. Accept only the Cast app's
  uid (peer credentials via `/proc/net/unix`, or a tiny native helper), or keep
  the token out of the status; rotate the token on demand.
- [ ] **Repository housekeeping** (needs the owner's go-ahead):
  - delete the 24 inherited tags (`waze-on-cluster@*`, `cluster-render@*`,
    `robertn_waze_cluster@*`):
    `git push origin --delete $(git tag -l 'waze-on-cluster@*' 'cluster-render@*' 'robertn_waze_cluster@*' | sed 's#^#refs/tags/#')`;
  - leave the fork network (GitHub Support, "Detach fork"; keeps the URL and
    releases);
  - enable Actions so tests run on push;
  - upstream's commits stay in history unless rewritten.

## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above.
