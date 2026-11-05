# TODO

What's left, roughly in order. Background: [`Learnings.md`](Learnings.md);
the CarPlay second screen: [`re/STATUS.md`](re/STATUS.md).

Release rule: every change to what a component ships needs a version bump
(`node release/release.js bump <id> <x.y.z>`); publish with the Release
workflow (Actions > Release, the component ids).

## hook111 (CarPlay's second screen)

- [ ] **On the car:** whether the phone draws the HUD size it is offered
  (1056x384), and how the cluster view looks at that shape.
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

## Moonlight (vizualyse-moonlight, vizualyse_moonlight 0.1.0)

Built and tested off the car against a real Sunshine
([`native/vizualyse-moonlight`](native/vizualyse-moonlight), "Off the car").
Tried on the car (2026-11-05) from a hand-made unit in /run: pairing over
the hotspot, the centre console full screen with black bars, the stop hint,
hold-to-stop (the touch PDUs read passively), audio. **Never stop or
restart a hand-made unit on the car: recmgr restarts the head unit**
(Learnings, "The head unit"); test through a real install.

- [ ] **Install from the Store on the car** (published 2026-11-05; its
  `recmgr` entry whitelists it) and try again there: a stream on the
  console, hold-to-stop, Stop / Quit game, a stop and start of the service,
  and that the audio player is gone after Stop (killed now; it kept playing
  for minutes before).
- [ ] **The uplink uid 12998** (component.json `internet`, `uids`): check the
  Store writes its `uids.d` entry; the car trial borrowed Cast's 12999.
- [ ] **Controllers on the car:** there is no `/dev/input` at all (no HID
  drivers loaded); find whether `xpad` / `hid-*` / `uinput` modules exist.
  The quit combo is untested on the car for that reason.
- [ ] **The cluster and the HUD outputs** on the car (built, tested off the
  car only).
- [ ] whether the Atom decodes 1280x720@60 in software in time (30 ran at
  ~5 % CPU for ffmpeg, a clock desktop); the latency end to end.
- [ ] **Only while parked:** nothing checks the gear or the speed yet; find
  where a root tool can read them, and stop (or refuse) the stream when
  moving.
- [ ] **Hardware decoding**, if software isn't enough: the Atom's VA-API
  (libva) or what winston-grabber's `h264_msdk` uses, from moonlight-core.
- [ ] Finding the PC on its own (mDNS `_nvstream._tcp`) instead of typing
  its address; Wake-on-LAN (serverinfo gives the MAC).
- [ ] Tell mgu-render's author: its touch decode reads iDrive 8's PDU layout;
  on iDrive 7 the fields are 16 bytes later (Learnings, "The central
  screen"), so a CLAIM gets no touch there.
- [ ] `tools/crashwatch.py`: the recorder that found the recmgr restarts;
  maybe a Store tool of its own for debugging on the car.

## Carried over

- [ ] **Cast 0.3.8** (the control-socket fix, published 2026-11-05): install
  it on the car, check the Cast page still works, then rotate the phone
  link's token (it was readable by every Store app until then).


## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above.
