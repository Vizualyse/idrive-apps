<!-- SPDX-License-Identifier: GPL-3.0-or-later
     Copyright (C) 2026 Yousaf Khan -->

# Cluster themes (vizualyse-cluster)

Whole-cluster themes for the iDrive 7 instrument cluster (1920x720), drawn
through cluster-render's `panel` target: over BMW's gauges and its bottom
strip, under the car's own warning lights. The car's gear readout shows
through a window in the strip (x 1366-1462, y 665-720): covering it brings
up the KOMBI's black fallback gear box (`theme_core.PANEL`, DESIGNS.md
"The car's panel").
Each comes as a Sport and a Comfort theme, switched by the car's drive mode.
Switching the tool off brings BMW's cluster back.

Chosen on the central screen by touch: the **Cluster themes** iDrive app
([apps/vizualyse_cluster](../../apps/vizualyse_cluster)) opens the tool's
**picker**, a large preview of every theme in Sport and Comfort, with Use,
a 10 s Try on the cluster while parked, Sport or Comfort, and off.

**On the car** (2026-11-13/14): a theme draws on the panel with the demo
drive, the picker works, and the panel's visible shape was measured
(`docs/`). Not yet on a car: the themes refitted to that shape (0.3.0) and
the car's readings (the app's 0.2.0). Built and tested off the car: the
shaders in WebGL 1, every theme's logic and limits, the tool end to end
against a fake cluster-render on the unit's Node 8, the picker against a
fake mgu-render client with scripted touches, the touch reader on
mgu-python's Python.

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
| G20 inspired 1 | `g20i1` | sport | 37 | 11 | 3.90 | 2.08 | 2.30 |
| G20 inspired 1 · Comfort | `g20i1c` | comfort | 36 | 12 | 4.98 | 3.16 | 2.66 |
| G20 inspired 2 | `g20i2` | sport | 37 | 12 | 3.59 | 1.62 | 2.63 |
| G20 inspired 2 · Comfort | `g20i2c` | comfort | 31 | 12 | 2.97 | 0.99 | 3.30 |
| LCI inspired 1 | `lci1` | sport | 37 | 12 | 1.66 | 0.91 | 2.77 |
| LCI inspired 1 · Comfort | `lci1c` | comfort | 38 | 12 | 1.55 | 0.80 | 2.84 |
| LCI inspired 2 | `lci2` | sport | 40 | 10 | 2.62 | 1.59 | 2.46 |
| LCI inspired 2 · Comfort | `lci2c` | comfort | 35 | 12 | 2.19 | 1.17 | 2.18 |
| Performance 1 | `perf1` | sport | 39 | 11 | 1.79 | 1.62 | 2.25 |
| Performance 1 · Comfort | `perf1c` | comfort | 40 | 12 | 1.86 | 1.69 | 2.47 |
| Performance 2 | `perf2` | sport | 39 | 12 | 3.22 | 1.72 | 2.60 |
| Performance 2 · Comfort | `perf2c` | comfort | 38 | 12 | 2.98 | 1.47 | 2.56 |
| Three-dial 1 | `tri1` | sport | 40 | 12 | 2.07 | 0.88 | 2.59 |
| Three-dial 1 · Comfort | `tri1c` | comfort | 38 | 11 | 2.05 | 0.86 | 3.02 |
| Three-dial 2 | `tri2` | sport | 40 | 12 | 3.52 | 2.20 | 2.08 |
| Three-dial 2 · Comfort | `tri2c` | comfort | 31 | 12 | 3.07 | 1.75 | 2.12 |

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

- The refitted themes (0.3.0): the gear window clear, no black box, the
  text sharp (font atlases are now 4-byte aligned: the KOMBI sheared the
  others), and the KOMBI's GPU over a long run (about 40 effect layers,
  2-3.3 Mpx a frame).
- The car's readings, as the app (0.2.0) sends them: each against the
  car's own display; the scalings not yet confirmed (boost, throttle,
  battery %, electric range, the trip computer: the app logs their raw
  values); the drive mode picking Sport or Comfort. Not read yet: the speed
  limit, cruise speed, navigation, electric power; `fuelPct` (the car
  gives litres). Where each comes from: `knowledge/vehicle-signals.md`.
- The picker: how long the first picture takes on the unit's Atom.

Not yet: a phone page (TODO.md).
