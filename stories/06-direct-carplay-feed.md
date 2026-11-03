# 06 · Direct CarPlay feed (no screen grab)

## Why

The map on the cluster whatever the central screen shows, without BMW's
pop-ups. Needs story 03's answer to be "the phone keeps sending in the
background".

## What we know

- `carplay` (BMW, 2020) decodes the phone's H.264 with VA-API (`libva-drm`,
  Intel MSDK) and hands the frames as an ivi-application surface to
  **`wayland-1`**, the compositor inside BMW's HMI (`HmiMain3D`); its env has
  `WAYLAND_DISPLAY=wayland-1`. The HMI draws it into its own 3D scene, which
  is one surface (100) on the main compositor.
- `ivi-screenshot-control --surfaceshot` works only on the main compositor;
  `wayland-1` has no `ivi_controller` ("no ivi_controller interface found").
  One Wayland client cannot read another's buffers. So no stock tool
  captures CarPlay alone.
- The phone's stream itself arrives encrypted (AirPlay screen stream), so
  tapping the network is no use.

## Approach

A small native library preloaded into `carplay` (`LD_PRELOAD`, through a
systemd drop-in on `carplay.service`, as waze-on-cluster does for its
patch), hooking **public libva calls** rather than Cinemo internals:

- note the VA display and the surface each decoded picture lands in
  (`vaEndPicture` / `vaSyncSurface`, or `vaPutSurface`-like export calls);
- at the mirror's rate (8-15 fps) copy that surface with `vaGetImage` (VA
  does the detiling) into NV12, and publish it in a shared-memory ring the
  tool reads (like mgu-render's MGVF file);
- do nothing when no reader is attached; never block the decoder.

The tool then takes frames from the ring instead of the grabber, with the
same layouts (CarPlay's own frame size, likely 1920x720 or its configured
size, not the screen's).

## Work

- Cross-build for the unit (gcc 7.5 x86-64; upstream idrive-apps had the
  Docker toolchain image under `.github/actions/build-image`, in this
  repository's history before the stand-alone commit).
- Find the exact libva calls Cinemo makes (`ltrace` is not on the unit; a
  first hook that only logs calls and arguments).
- Safety: a recovery path that removes the drop-in if `carplay` crash-loops
  (waze-on-cluster's recovery service is the model), and the crash
  handler's whitelist.

## Done when

- The map on the cluster with the central screen on Radio, at 8+ fps, with
  CarPlay unaffected (no added latency or stutter on the central screen).

## Risks

- A bug in the hook crashes CarPlay. Keep the hook minimal and reversible.
- Cinemo may use VA in a way that makes the copy expensive; measure.
- Size L: days of work, not hours.
