# Platform changelog

Each version is frozen once a newer one exists. A component moves to a new
version with `node platform/platform.js use <version>`.

## 1.0.0

The files every tool and app had copied from each other, taken as they were
on main at 68aa156 (byte for byte, but for a comment in `native/frame_out.h`):

| File | Was in |
|---|---|
| `tool/pcm_play.py` | vizualyse-moonlight, vizualyse-steam (and an older one in vizualyse-cast) |
| `tool/cluster_render_client.js` (MPL-2.0) | vizualyse-cast, vizualyse-moonlight |
| `common/qrcode.js` (MIT) | every app, vizualyse-cast |
| `app/qr_png.js` | every app |
| `app/vehicle_speed.js` | vizualyse_moonlight, vizualyse_chromium, vizualyse_steam |
| `native/frame_out.{c,h}` | vizualyse-moonlight, vizualyse-chromium, vizualyse-steam |
| `native/touch.{c,h}` | vizualyse-moonlight, vizualyse-chromium |
| `native/wayland-drm.xml` (Mesa's notice) | vizualyse-chromium, vizualyse-steam |
| `test/pcm_play_test.py` | vizualyse-moonlight |

vizualyse-cast's own `pcm_play.py` predated the SmartX lock fix (2026-11-05:
a lock first made by root silenced CarPlay until a restart); on this version
it plays through the fixed one.
