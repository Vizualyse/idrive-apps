<!-- SPDX-License-Identifier: GPL-3.0-or-later
     Copyright (C) 2026 Yousaf Khan -->

# Cluster themes (vizualyse-cluster)

Whole-cluster themes for the iDrive 7 instrument cluster (1920x720), drawn
through cluster-render's `panel` target: over BMW's gauges, under the car's
own warning lights and its bottom strip (y 646 and below, never covered).
Each comes as a Sport and a Comfort theme, switched by the car's drive mode.
Switching the tool off brings BMW's cluster back.

**Not yet tried on a car.** Built and tested off the car: the shaders in
WebGL 1, every theme's logic and limits, the tool end to end against a fake
cluster-render on the unit's Node 8.

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
| G20 inspired 1 | `g20i1` | sport | 37 | 10 | 6.20 | 6.02 | 2.00 |
| G20 inspired 1 · Comfort | `g20i1c` | comfort | 36 | 12 | 6.47 | 6.29 | 2.36 |
| G20 inspired 2 | `g20i2` | sport | 37 | 12 | 7.05 | 5.27 | 2.37 |
| G20 inspired 2 · Comfort | `g20i2c` | comfort | 31 | 12 | 6.65 | 4.86 | 2.60 |
| LCI inspired 1 | `lci1` | sport | 38 | 12 | 6.29 | 5.62 | 2.56 |
| LCI inspired 1 · Comfort | `lci1c` | comfort | 38 | 12 | 6.28 | 5.62 | 2.74 |
| LCI inspired 2 | `lci2` | sport | 40 | 12 | 5.99 | 4.91 | 2.43 |
| LCI inspired 2 · Comfort | `lci2c` | comfort | 34 | 12 | 5.88 | 4.81 | 2.10 |
| Performance 1 | `perf1` | sport | 38 | 11 | 6.21 | 6.08 | 2.17 |
| Performance 1 · Comfort | `perf1c` | comfort | 40 | 11 | 6.17 | 6.04 | 2.40 |
| Performance 2 | `perf2` | sport | 37 | 12 | 6.15 | 6.05 | 2.15 |
| Performance 2 · Comfort | `perf2c` | comfort | 36 | 12 | 6.07 | 5.97 | 2.19 |
| Three-dial 1 | `tri1` | sport | 37 | 12 | 5.84 | 5.49 | 2.26 |
| Three-dial 1 · Comfort | `tri1c` | comfort | 37 | 12 | 5.91 | 5.56 | 2.67 |
| Three-dial 2 | `tri2` | sport | 39 | 12 | 6.69 | 5.63 | 1.96 |
| Three-dial 2 · Comfort | `tri2c` | comfort | 29 | 12 | 6.50 | 5.44 | 1.91 |

(`node tools/theme_table.js` prints this from the built themes.) While
driving, a theme sends 4-20 KB/s of uniforms (`test/themes_test.js`), next to
the link's 5,500 KB/s. `sample` and `samplec` are the pipeline's own check,
not shipped.

## The tool

- Root systemd service, Node 8.16, `/var/opt/vizualyse-cluster/current/`.
  It draws only through cluster-render's socket and needs no network.
- Settings: `/var/opt/vizualyse-cluster/state/settings.json`:
  `enabled`, `theme` (a family: `g20i1` ... `tri2`), `mode` (`auto`: the
  car's drive mode picks Sport or Comfort; `sport`; `comfort`), `source`
  (`car` or `demo`), `bench`.
- **Sources.** `car`: the readings the iDrive app sends; any it doesn't
  send shows as `--`, and the clock is the head unit's. `demo`: the bench
  drive (`src/sim.js`, a Sport and a Comfort lap), only while the car is
  known to stand still (`bench: true`, set by hand on a bench unit, also
  allows an unknown speed); it switches back to `car` as soon as the car
  moves.
- **Control socket** `/dev/shm/vizualyse-cluster/ctl.sock` (the
  vizualyse_cluster app's group only, as the other tools'):
  `{"cmd":"enable"}`, `{"cmd":"disable"}`, `{"cmd":"theme","id":"g20i2"}`,
  `{"cmd":"mode","mode":"auto"}`, `{"cmd":"source","source":"demo"}`,
  `{"cmd":"speed","kmh":N}`, `{"cmd":"signals","rpm":N,"gear":N,"driveMode":"SPORT",...}`;
  status once a second.
- 25 ticks a second; only uniforms that changed are sent. A mode switch
  starts the family's other theme and keeps every texture they share on the
  cluster (at most one switch every 3 s).

| File | |
|---|---|
| `src/server.js` | settings, the source, the mode, the tick, the control socket |
| `src/theme_runtime.js` | a built theme on cluster-render: assets (kept across a switch), effect layers, binds, uniforms; checks the theme and its textures' hashes first |
| `src/theme_core.js` | the logic's output to uniforms, text layout, the limits (shared with the preview) |
| `src/sim.js` | the bench drives (shared with the preview) |
| `src/shaders/*.frag` | the shader library version 2: `art`, `gauge`, `text`, `leds`, `rect` (shipped as `fs_*.frag`) |
| `themes/<id>/` | a theme's source: `theme.src.json` (most written by its `gen.js` from the mockup's geometry), `art.html`, `logic.js`, fonts it adds (OFL) |
| `themes/built/` | the built themes (committed; the kit ships them flat) |
| `themes/fonts/` | Barlow Semi Condensed (OFL), shared |
| `tools/theme_build.js` | builds a theme (headless Chrome for the art and fonts); `--list --prune` keeps component.json's files in step |
| `tools/theme_table.js` | the themes' numbers |
| `tools/preview.html`, `preview_serve.js`, `preview_shot.js` | the off-car preview in WebGL 1 |

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
```

## On the car, still to find out

- Everything: no theme has been on a KOMBI yet. First: the panel shown, a
  theme's start upload (about 6-7 MB) through the governor, and how the
  KOMBI's GPU copes with about 40 effect layers and 2-2.7 Mpx a frame
  (THEMES.md "Not known yet").
- Which readings the head unit can give the app on iDrive 7 (rpm, gear,
  drive mode, temperatures, tyres, power, battery, limit, cruise,
  guidance): until then a theme on `car` shows the speed and the clock.
- Where the glass and the driver camera's cowl hide the screen's edges.

Not yet: the iDrive app (on/off, theme, mode, the readings, the speed) and a
phone page (TODO.md).
