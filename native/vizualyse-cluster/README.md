<!-- SPDX-License-Identifier: GPL-3.0-or-later
     Copyright (C) 2026 Yousaf Khan -->

# Cluster themes (vizualyse-cluster)

Whole-cluster themes for the iDrive 7 instrument cluster (1920x720), drawn
through cluster-render's `panel` target: over BMW's gauges, under the car's
own warning lights and its bottom strip (y 646 and below, never covered).
Each comes as a Sport and a Comfort theme, switched by the car's drive mode.
Switching the tool off brings BMW's cluster back.

Chosen on the central screen by touch: the **Cluster themes** iDrive app
([apps/vizualyse_cluster](../../apps/vizualyse_cluster)) opens the tool's
**picker**, a large preview of every theme in Sport and Comfort, with Use,
a 10 s Try on the cluster while parked, Sport or Comfort, and off.

**Not yet tried on a car.** Built and tested off the car: the shaders in
WebGL 1, every theme's logic and limits, the tool end to end against a fake
cluster-render on the unit's Node 8, the picker against a fake mgu-render
client with scripted touches, the touch reader on mgu-python's Python.

How a theme is drawn (textures sent once, small shaders on the KOMBI,
uniforms while driving) and the rules every theme keeps:
[**THEMES.md**](THEMES.md).

## Themes

Eight families, each a Sport and a Comfort theme, ported from mockups
(made with the impeccable skill; the Sport ones by Fable 5.2 and Opus 5.5,
the Comfort ones by Fable 5.2): [Sport designs](https://claude.ai/artifact/Vf25Jm1QRZ87dGBo8ZTy6A)
(private). They echo the look of BMW's G20 and LCI clusters, of a
three-dial cluster and of a performance cluster; no BMW or Porsche marks or
typefaces (THIRD-PARTY.md).

| Theme | Id | Mode | Layers | Textures | MB at start | MB on a mode switch | Mpx a frame |
|---|---|---|---|---|---|---|---|
| G20 inspired 1 | `g20i1` | sport | 37 | 10 | 2.99 | 2.82 | 1.98 |
| G20 inspired 1 · Comfort | `g20i1c` | comfort | 36 | 12 | 2.99 | 2.81 | 2.33 |
| G20 inspired 2 | `g20i2` | sport | 37 | 12 | 3.11 | 1.43 | 2.29 |
| G20 inspired 2 · Comfort | `g20i2c` | comfort | 31 | 12 | 2.60 | 0.92 | 2.51 |
| LCI inspired 1 | `lci1` | sport | 38 | 12 | 2.09 | 1.44 | 2.52 |
| LCI inspired 1 · Comfort | `lci1c` | comfort | 38 | 12 | 2.09 | 1.43 | 2.70 |
| LCI inspired 2 | `lci2` | sport | 40 | 12 | 2.27 | 1.22 | 2.40 |
| LCI inspired 2 · Comfort | `lci2c` | comfort | 34 | 12 | 2.04 | 0.98 | 2.09 |
| Performance 1 | `perf1` | sport | 38 | 11 | 1.71 | 1.62 | 2.09 |
| Performance 1 · Comfort | `perf1c` | comfort | 40 | 11 | 1.72 | 1.63 | 2.32 |
| Performance 2 | `perf2` | sport | 37 | 12 | 2.52 | 2.43 | 2.12 |
| Performance 2 · Comfort | `perf2c` | comfort | 36 | 12 | 2.39 | 2.31 | 2.16 |
| Three-dial 1 | `tri1` | sport | 37 | 12 | 1.69 | 1.36 | 2.22 |
| Three-dial 1 · Comfort | `tri1c` | comfort | 37 | 12 | 1.74 | 1.41 | 2.63 |
| Three-dial 2 | `tri2` | sport | 39 | 12 | 2.85 | 1.80 | 1.94 |
| Three-dial 2 · Comfort | `tri2c` | comfort | 29 | 12 | 2.66 | 1.61 | 1.89 |

(`node tools/theme_table.js` prints this from the built themes.) While
driving, a theme sends 4-20 KB/s of uniforms (`test/themes_test.js`), next to
the link's 5,500 KB/s. `sample` and `samplec` are the pipeline's own check,
not shipped.

## The tool

- Root systemd service, Node 8.16, `/var/opt/vizualyse-cluster/current/`.
  It draws through cluster-render's socket (the cluster) and mgu-render's
  (the picker on the central screen), and needs no network.
- Settings: `/var/opt/vizualyse-cluster/state/settings.json`:
  `enabled`, `theme` (a family: `g20i1` ... `tri2`), `mode` (`auto`: the
  car's drive mode picks Sport or Comfort; `sport`; `comfort`), `cover`
  (black over the car's own strip under the theme), `source` (`car` or
  `demo`), `bench`.
- **Sources.** `car`: the readings the iDrive app sends; any it doesn't
  send shows as `--`, and the clock is the head unit's. Until the app sends
  readings, the speed it sends once a second (for the parked gate) is the
  theme's speed too. `demo`: the bench
  drive (`src/sim.js`, a Sport and a Comfort lap), only while the car is
  known to stand still (`bench: true`, set by hand on a bench unit, also
  allows an unknown speed); it switches back to `car` as soon as the car
  moves.
- **Control socket** `/dev/shm/vizualyse-cluster/ctl.sock` (the
  vizualyse_cluster app's group only, as the other tools'):
  `{"cmd":"enable"}`, `{"cmd":"disable"}`, `{"cmd":"theme","id":"g20i2"}`,
  `{"cmd":"use","id":"g20i2"}` (that family, and on),
  `{"cmd":"mode","mode":"auto"}`, `{"cmd":"cover","on":true}`,
  `{"cmd":"source","source":"demo"}`, `{"cmd":"picker","on":true}`,
  `{"cmd":"try","id":"g20i2c"}`,
  `{"cmd":"speed","kmh":N}`, `{"cmd":"signals","rpm":N,"gear":N,"driveMode":"SPORT",...}`;
  status once a second (with `picker`, `trying`, `canTry`, `look`: the
  mode the cluster shows now).
- 25 ticks a second; only uniforms that changed are sent. A mode switch
  starts the family's other theme and keeps every texture they share on the
  cluster (at most one switch every 3 s). A theme already on the cluster is
  not started again (a mode setting that picks the same one).
- **Try** (`try`): one theme (a Sport or a Comfort id) on the cluster for
  10 s with the bench drive, only while the car is known to stand still,
  then what was there before (the chosen theme, or the car's own cluster).
  Moving, a command that shows another theme, or off ends it early.

### The picker on the central screen

The app opens its empty screen state, then sends `{"cmd":"picker","on":true}`;
BACK, HOME, another app or a pop-up make it send `on: false`. The picker
shows only while the car is not known to move (hidden above 3 km/h, as
Browser and Steam).

- **The picture** (`src/picker.js`, `src/picker_view.js`, `src/ui_draw.js`):
  one opaque RGBX pixmap the size of mgu-render's app area (1790x638 at
  +108+82: the HMI's title bar and its left strip with the back arrow stay
  the HMI's), drawn in JS from the previews and glyph atlases built off the
  car (`picker.*`, `tools/picker_build.js`): a large preview of the chosen
  family (swipe it or press < >), the eight families as tiles, Preview Sport
  / Comfort, Use, Try, Auto / Sport / Comfort, Turn themes off. Only the
  regions that change go to mgu-render again (a press: about 27,000 px; a new
  preview: the preview's 470,000); an IMAGE op at least once a second keeps it
  up. About 8 ms a picture on a desktop once the previews are decoded
  (16 PNGs, 2.3 MB in the kit, decoded as first shown).
- **Touch** (`src/touch_reader.py`, mgu-python): an AF_PACKET copy of the
  display's touch PDUs on vlan73, the platform's `native/touch` decoding in
  Python, so the tool needs nothing compiled; the socket opened as root,
  then the reader drops to `nobody`. Nothing is claimed (a claim through
  mgu-render restarted the unit); the HMI gets every touch too, on an empty
  state. A tap is a down and an up on the same target within 24 px; a swipe
  of 80 px across the large preview goes to the next family. Targets are 50
  px or more (`test/picker_test.js` checks).
- The iDrive controller works the app's own page (a row per family, Sport or
  Comfort, the strip, on / off), not the picker: the knob reaches only RHMI
  states (knowledge/input.md).

| File | |
|---|---|
| `src/server.js` | settings, the source, the mode, the tick, Try, the control socket |
| `src/picker.js` | the picker: its state, mgu-render (one pixmap, the changed regions), the touch reader, taps and swipes |
| `src/picker_view.js` | the picker's layout, what it draws for a model, what a touch hits (pure) |
| `src/ui_draw.js` | a small RGBX canvas: rounded rectangles, pictures, atlas text, resizing |
| `src/png.js` | a PNG reader (the previews) and writer (checks) |
| `src/touch_reader.py` | the display's touches, read passively (mgu-python) |
| `picker/` | the picker's previews (`<id>.png`, `<id>.thumb.png`) and fonts (`fonts.json`, `f*.font.gz`), built by `tools/picker_build.js` (committed; shipped as `picker.*`) |
| `src/theme_runtime.js` | a built theme on cluster-render: assets (kept across a switch), effect layers, binds, uniforms; checks the theme and its textures' hashes first |
| `src/theme_core.js` | the logic's output to uniforms, text layout, the limits (shared with the preview) |
| `src/sim.js` | the bench drives (shared with the preview) |
| `src/shaders/*.frag` | the shader library version 2: `art`, `gauge`, `text`, `leds`, `rect` (shipped as `fs_*.frag`) |
| `themes/<id>/` | a theme's source: `theme.src.json` (most written by its `gen.js` from the mockup's geometry), `art.html`, `logic.js`, fonts it adds (OFL) |
| `themes/built/` | the built themes (committed; the kit ships them flat) |
| `themes/fonts/` | Barlow Semi Condensed (OFL), shared |
| `tools/theme_build.js` | builds a theme (headless Chrome for the art and fonts); `--list --prune` keeps component.json's files in step |
| `tools/tiles.js` | the static art as its distinct tiles and their map, one texture (THEMES.md "Static art") |
| `tools/theme_table.js` | the themes' numbers |
| `tools/preview.html`, `preview_serve.js`, `preview_shot.js` | the off-car preview in WebGL 1 |
| `tools/picker_build.js` | the picker's previews (a `preview_shot.js` of each theme at 9.5 s, cut to size) and fonts (headless Chrome), listed in component.json |

## Off the car

```sh
cd native/vizualyse-cluster
node themes/g20i2/gen.js                        # a theme's source from its mockup's geometry (if it has one)
node tools/theme_build.js themes/g20i2          # needs Chrome or Edge
node tools/theme_build.js --list --prune        # component.json's files
node tools/preview_serve.js                     # http://127.0.0.1:8770/?theme=g20i2
node tools/preview_shot.js g20i2 9.5 shot.png   # one moment, as a PNG
node test/shader_lint.js                        # the shader rules
node test/themes_test.js                        # every theme: limits, hashes, logic on both drives and with no signals
node test/tool_test.js                          # the tool against a fake cluster-render
node tools/picker_build.js                      # the picker's previews and fonts (after a theme changes)
node test/picker_test.js [out.png]              # the picker: its look, then the tool with scripted touches
python3 test/touch_reader_test.py               # the touch reader (as root in a container: it drops to nobody)
```

## On the car, still to find out

- Everything: no theme has been on a KOMBI yet. First: the panel shown, a
  theme's start upload (about 1.7-3.1 MB) through the governor, and how the
  KOMBI's GPU copes with about 40 effect layers and 2-2.7 Mpx a frame
  (THEMES.md "Not known yet").
- Which readings the car actually sends. Our firmware's SOME/IP catalog has
  these, the same fields idrive7-apps reads on its cars
  (`knowledge/vehicle-signals.md`): speed, rpm, gear (P R N, 1-9), gear mode
  (S / M), drive mode, oil, coolant and outside temperatures, fuel (litres)
  and range, odometer, boost, tyre pressures and temperatures, g, engine
  power, trip averages, and BMW navigation's next turn, road, distance and
  ETA. Their scaling still needs checking on the car: battery charge,
  electric range and power, instant consumption. Speed limit and cruise set
  speed are only candidates, not read by any app yet; the 12 V voltage isn't
  a signal (only its charge %). Until the app reads them, a theme on `car`
  shows the speed and the clock.
- Where the glass and the driver camera's cowl hide the screen's edges.
- The picker: that mgu-render takes the RGBX pixmap and its regions on our
  version (0.6.11 or later) and shows it in the app area over the app's empty
  state; that the AF_PACKET reader sees the display's touches under mgu-python
  (as the C readers of Browser and Steam do); how long the first picture
  takes on the unit's Atom (16 PNGs decoded) and a press after.

Not yet: the readings beyond the speed (the app sends `speed` only), a
phone page (TODO.md).
