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
- [ ] **Cast 0.3.8 on the car (2026-11-05):** centring and the time/distance
  card work; the **zoom controls do nothing** and the **directions card's
  on/off does nothing** (the card always shows). Changing many settings in a
  row can grey out the map while the cards stay (fixed by reconnecting the
  iPhone; maybe Google Maps itself).
- [ ] **HUD:** the text could be bigger (both views otherwise look fine).

## Moonlight (vizualyse-moonlight, vizualyse_moonlight 0.1.0)

Built and tested off the car against a real Sunshine
([`native/vizualyse-moonlight`](native/vizualyse-moonlight), "Off the car").
Installed from the Store on the car (2026-11-05): pairing over the hotspot,
a stream on the centre console (full screen, black bars, the stop hint),
hold-to-stop, Play / Stop / Quit game / Resume last, sound, the player gone
after a stop, the stream as uplink uid 12998, recmgr-whitelisted. **Never
stop or restart a hand-made unit on the car: recmgr restarts the head unit**
(Learnings, "The head unit").

- [ ] **Controllers on the car:** XInput USB pads are read through usbfs
  (no kernel drivers on the car, its README); passes off the car with a
  USB/IP virtual pad. Next: bump to 0.1.1, release, then on the car the
  Vader 4 Pro in a stream and the quit combo. Later: DualShock/DualSense
  over usbfs (HID reports), pads paired to the phone (Gamepad API).
- [ ] **The cluster and the HUD outputs** on the car (built, tested off the
  car only).
- [ ] whether the Atom decodes 1280x720@60 in software in time (streaming
  from the real PC works); the latency end to end.
- [ ] **Hardware decoding**, if software isn't enough: the Atom's VA-API
  (libva) or what winston-grabber's `h264_msdk` uses, from moonlight-core.

## Carried over

- [ ] **Rotate the Cast phone link's token** (0.3.8 works on the car; the
  token was readable by every Store app before it).


## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above.
