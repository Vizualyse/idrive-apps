# TODO

What's left, roughly in order. Background: [`Learnings.md`](Learnings.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

## hook111 (CarPlay's second screen)

- [ ] **Decide how it gets onto the car.** It's off the car now. Either an
  mgu-deploy install from the Store (move `re/deploy/hook111` into `native/`;
  `release.js` then publishes it on every full release; `component.json`'s
  recmgr entries and `systemd-analyze verify` of the units are untested), or
  by hand as before. Checklist: re/STATUS.md, "Before the next armed boot".
- [ ] **Display size per target (0.0.7).** Let the advertised second-screen
  size change, so the cluster (`map`, 1088x480) and the HUD (800x480) can each
  get their own resolution.
- [ ] **Open protocol questions:** what `viewAreas`, `showUI` and
  `primaryInputDevice` should contain; whether the phone keeps streaming 111
  while CarPlay isn't on the main screen.
- [ ] **On the car:**
  - whether the shutdown mark is written at a real switch-off (one ignition
    cycle, disabled);
  - long-run stability (a long drive, armed);
  - wired CarPlay as well as wireless.

## Cast to cluster (tool and app)

- [ ] **The CarPlay second screen as a source.** A "CarPlay second screen"
  source for the cluster and the HUD: ffmpeg reading
  `tcp://127.0.0.1:6111?listen` (H.264), scaled to stay under
  cluster-render's ~5500 KB/s upload and a multiple of 4 wide.
- [ ] **Remove the central-screen mirror** (winston-grabber, the Google Maps
  layouts).
- [ ] Update the app's buttons and the page tests.
- [ ] Bump the versions, from `vizualyse-cast` 0.2.1 and `vizualyse_cast`
  0.2.0 (the app's `requires` follows the tool's new version).

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
