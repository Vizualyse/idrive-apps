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

## New apps

- [ ] **A Moonlight client, with controller support.** Stream games from a PC
  running Sunshine (GameStream protocol) to the central screen, parked.
  To find out: whether a Moonlight core (moonlight-common-c) builds for the
  unit and decodes H.264 in hardware there (the libva path, or what
  mgu-render uses); sound through the car's speakers; game controllers over
  Bluetooth (HID) or USB, and whether the unit's kernel has the input drivers
  (`hid-generic`, `xpad`, evdev) or they can be loaded; pairing (the PIN) and
  the host list from the iDrive page or the phone page; the network (the car's
  hotspot with the PC on it, or a phone tethering both). Only while parked.

## Carried over

- [ ] **Control-socket hardening.** `/dev/shm/vizualyse-cast/ctl.sock` is
  0660, group `tm_oap_app`, which every Store app is in: any of them can read
  the phone link with its token and send commands. Accept only the Cast app's
  uid (peer credentials via `/proc/net/unix`, or a tiny native helper), or keep
  the token out of the status; rotate the token on demand.

## Dropped

The old `stories/` (in git history before this file) also had a background
CarPlay test, auto mode for the mirror, the HMI pop-ups over the mirror, a
libva-based CarPlay feed and the grabber's encoder quality. The CarPlay second
screen replaces the mirror and avoids the pop-ups; whether it streams in the
background is the open protocol question above.
