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

- [ ] **Release it** (both at 0.1.0, not yet published).
- [ ] **On the car:**
  - the head unit reaching the PC on the hotspot (pairing, then a stream:
    does UDP 47998-48000 get in with the host rule);
  - the picture on the central screen (mgu-render), and whether the Atom
    decodes 1280x720@60 in software in time (720p30 is the default); the
    latency end to end;
  - the sound through SmartXbar;
  - controllers: which drivers the kernel has (`xpad`, `hid-microsoft`,
    `hid-sony`, `hid-generic`), a USB pad, pairing a Bluetooth pad with the
    car; the phone pad's latency;
  - the iDrive page (the tile next to Cast's, the QR code, the buttons).
- [ ] **Only while parked:** nothing checks the gear or the speed yet; find
  where a root tool can read them, and stop (or refuse) the stream when
  moving.
- [ ] **Hardware decoding**, if software isn't enough: the Atom's VA-API
  (libva) or what winston-grabber's `h264_msdk` uses, from moonlight-core.
- [ ] Finding the PC on its own (mDNS `_nvstream._tcp`) instead of typing
  its address; Wake-on-LAN (serverinfo gives the MAC).

## Carried over

- [ ] **Control-socket hardening** (Cast's, and Moonlight's
  `/dev/shm/vizualyse-moonlight/ctl.sock` the same way; to do when Moonlight
  is tested on the car). `/dev/shm/vizualyse-cast/ctl.sock` is
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
