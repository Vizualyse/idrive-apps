<!-- SPDX-License-Identifier: GPL-3.0-or-later
     Copyright (C) 2026 Yousaf Khan -->

# Cluster themes: how they are drawn

A theme is a whole custom cluster (1920x720) drawn through cluster-render's
`panel` target, over BMW's gauges and under the car's warning lights. This
file is the strategy every theme follows: what goes in a texture, what goes
in a shader, what the tool sends while driving, and the limits that keep the
cluster alive. The code is in [`src/`](src), the themes in
[`themes/`](themes), the off-car preview in [`tools/`](tools).

## Where the work happens

The scene is **drawn by the KOMBI**, not by the head unit: cluster-render
builds a RAMSES scene on the head unit and the cluster's own renderer and
GPU draw it every frame. So:

- **Pixels cost the link.** Every byte of an image or texture crosses the
  head unit to cluster link, about **5,500 KB/s shared** by everyone
  (Cast, Moonlight, the HUD). A theme that sends pixels while driving
  starves them and drops frames.
- **Shaders cost the KOMBI's GPU.** A fragment shader runs for every pixel
  of its layer every frame on the cluster's GPU, which also draws BMW's
  scene. Someone else's heavy shader (about 70 uniform vectors) restarted
  the cluster twice on a G21, with brake and stability warnings until the
  car slept ([knowledge/cluster-and-hud.md](../../knowledge/cluster-and-hud.md),
  idrive7-apps' Redline).
- **Uniforms are almost free.** A uniform is a few bytes of JSON, applied in
  the next flush.

So a theme is **textures uploaded once, small shaders that look them up,
and uniforms sent while driving**: no per-frame pixels.

## The three ingredients

### 1. Static art: one image, uploaded once

Everything that never moves (the black background, gauge outlines, scale
ticks and numerals, labels, icons, the car plan) is rendered at build time
into **one RGBA texture** of the drawn area (1920x646), sent once when the
theme starts. About 5 MB raw: roughly one second of the link at start,
then nothing. It is an asset drawn by the `art` shader rather than an
image layer, so the gauge layers can sample it too and **add** their glow
to it (ticks and numerals brighten as the needle passes) at no extra
upload.

### 2. Fields: what a moving part needs to know about each pixel

A sweeping gauge, a lit band, a needle and a glow all depend on *where a
pixel is along the gauge's path* and *how far it is from it*. Working that
out per pixel in a shader means loops over path segments: too heavy for
the KOMBI. So the build tool works it out once and stores it in a
**field texture** (RGBA8, nearest sampling, the size of the gauge's layer):

| Channel | Holds |
|---|---|
| R, G | the position along the path, 0..1 as 16 bits (R high byte, G low) |
| B | the signed distance from the path in pixels, 128 + d (d > 0 inward, -127..127) |
| A | 255 where the pixel belongs to the gauge, 0 elsewhere |

The shader then needs **one texture read** per pixel. With the value along
the path as a uniform, it can:

- fill the band behind the needle (`t <= value` and `d` within the band),
- draw the needle (`|t - value| * length` under its half width, `d` within
  its length),
- glow: a falloff in `d` times a trail behind `value`,
- change colour past the redline (`t > red`).

The same field drives the curved power bars, which are paths too. A field
can be **reused** at no upload: `"mirror": "speed"` in a path is the
speedometer's mirror image about the screen's middle (a rev counter;
`u_pool.w` flips it), `"copy": "speed", "at": [x, y]` the same field moved
(two identical clockwise dials), and `"copy"` with `"flip": true` a mirror
image anywhere (the two arcs of a side ring).

### 3. Fonts: glyph atlases for the numbers that change

Speed, revs, the gear, power figures and tyre values change; they are
drawn by a small text shader over a **glyph atlas** (R8, one row of
equal cells, each glyph from its cell's left edge, built from the theme's
open-licence font at the sizes it uses). The build measures each glyph's
**advance** in Chrome, and the tool lays text out with them (version 2):
up to 16 glyph codes and their left edges go as `vec4` uniforms, aligned
left, right or centre, so `98.7°` takes its own width, not five digits'.
Digits are tabular, so a number keeps its width as it changes.

## The shaders

One library, shared by every theme ([`src/shaders`](src/shaders)), so each
shader is linted and previewed once. Version 2 (2026-11-13) added the
additive glow, the pool, band start and segments, mirrored fields,
proportional text, leaning shift lights and ringed rects:

| Shader | Draws | Uniforms |
|---|---|---|
| `art` | the static art (the theme's first layer) | `u_area` |
| `gauge` | along a path: the band lit from a start to the value (`u_seg.z`; either way, so a bar fills up for drive and down for regen), optionally in segments with gaps (`u_seg.x`, `u_seg.y`: gapped shift lamps or a segmented fuel bar on a curve); the needle; a glow trailing the value plus a pool of light at the needle (`u_pool`), added to the art under it, which it can also brighten (`u_look.y`: grey numerals turn white as the needle passes), with its outward reach (`u_look.x`) and falloff (`u_look.z`) set per layer; the redline colour | 11 `vec4`; reads its field and the art |
| `text` | up to 16 glyphs, proportional, aligned | 10 `vec4`; reads a glyph atlas |
| `leds` | a row of shift lights, filling left to right or from both ends, flashing; leaning (`u_lean.x`), the right half leaning the other way (`u_lean.z`), with a wider gap in the middle (`u_lean.y`) | 8 `vec4` |
| `rect` | a rounded rectangle in a colour with a ring in another (a hollow cold tyre), a dot, a cover over a piece of art | 3 `vec4` |

A gauge layer with the art bound is **opaque over its field**: it draws the
art itself plus its light, so it must sit directly on the art (nothing
between them in z inside its rectangle). `"art": false` on a layer turns
that off (the glow is then blended over whatever is below).

Rules every shader keeps (`test/shader_lint.js` checks them):

- **GLSL ES 1.00**, `precision highp` where available (positions along a
  path need it), `mediump` otherwise.
- **At most 12 uniform vectors** in a layer (the GLES 2 floor is 16 fragment
  vectors; Redline's 70 restarted the cluster). The library's largest,
  `gauge`, has 11.
- **At most 2 texture reads**, **no loops** except constant ones of at most
  4 steps (16 in `text`, whose layers are small: one compare a glyph), no
  `discard`, no derivatives (`GL_OES_standard_derivatives` is not
  promised).
- **No clock-driven animation in the shader.** Flashing is a uniform the
  tool toggles (at most 3 Hz). The renderer's clock (`time: 1`) is
  untested against the KOMBI's.

## Layers

A theme's layers, bottom to top: the art, then effect layers each covering
only its own rectangle (a gauge's field area, a text field, the shift
lights). Small rectangles keep the KOMBI's fill cost down: the
whole-screen art is the only full-size layer.

**Sport and Comfort.** Themes come in families: `"family": "g20i1"` with
`"mode": "sport"` (`g20i1`) and `"mode": "comfort"` (`g20i1c`). The tool's
`mode` setting is `auto` (the car's drive mode picks: SPORT is Sport,
anything else Comfort), `sport` or `comfort`; a switch starts the other
theme of the family (its textures sent again, so at most every 3 s). The
bench drive has a Comfort version too (`sim.at(t, 'comfort')`: a calm
drive in D).

Limits the tool enforces before anything is sent (`src/theme_runtime.js`):

- **No layer reaches y 646 or below**: that strip is the car's warning
  lights and its own information, and is never covered.
- At most **40 layers** and **12 assets** a theme, the art one of them
  (cluster-render allows a client 64 and 16).
- Assets: at most 2048 on a side and one frame message (5.5 MB).
- A theme's whole upload (art, fields, fonts) is reported in its build
  output and shown on the phone page.

## While driving

The tool reads its signals (the car's, from the iDrive app; or the bench
simulation), runs the theme's logic **25 times a second**, and sends only
the uniforms that changed. Each tick is about one or two kilobytes of JSON,
against 5,500 KB/s of link.

- **Needles move smoothly** because the logic smooths values with a
  critically damped spring before sending them. The renderer's own
  uniform animations (`animate`, keys between ticks) could smooth further
  with fewer sends. That path works on the unit's libramses but is
  untested against the KOMBI's clock, so it is off (`smooth: 'renderer'`
  in a theme turns it on for a trial).
- **Shift lights** fill from the theme's shift points and flash at 2.5 Hz
  at the shift point.
- **Only real readings.** A theme lists the signals it shows. With the car
  as the source, a signal the car does not provide shows as `--`, never a
  made-up number. The simulation is for the bench and the preview, and the
  phone page says DEMO while it runs.

## Building a theme

A theme's source lives in `themes/<id>/`:

| File | What it is |
|---|---|
| `theme.src.json` | the layers, paths, fonts, colours and the theme's numbers |
| `art.html` | the static art as a page (SVG/HTML), rendered by headless Chrome |
| `logic.js` | `update(signals, ctx) -> { layer: { value, text, color, ring, lit, flash, visible, x, y, uniforms } }`; `ctx` has the theme's `params`, `fonts` (each font's glyphs, cell and measured advances, for logic that lays out text itself), `state` (kept between ticks), `t`, `dt` and `core` (theme_core: `Spring`, `scale`) |
| `gen.js` (most themes) | writes `theme.src.json` from the mockup's own geometry, so paths, rectangles and text anchors agree with the art |

`node tools/theme_build.js themes/<id>` writes the kit's files into
[`themes/built/`](themes/built) (flat, as the kit wants them): the theme's
JSON, the art, each field and font, gzipped, and the logic. The built files
are committed, so a release needs no Chrome. A texture byte for byte the
same as one its family's other theme already built is not written again:
the theme names that file, so the kit carries it once and the tool keeps it
on the cluster across a mode switch. Each texture carries the SHA-1 of its
pixels; the tool refuses a theme whose shared texture was since rebuilt
under it. `node tools/theme_build.js --list --prune` then lists every
shipped file in `component.json` and removes built files no theme names;
`node tools/theme_table.js` prints every theme's numbers.

Every signal a theme shows must come from the car or show `--`: the logic
gets `null` for a reading the car didn't send (the bench drive sends them
all; `sim.js` lists them).

`node tools/preview_serve.js` then serves [`tools/preview.html`](tools/preview.html),
which draws a built theme in **WebGL 1**, the same GLSL ES 1.00 shaders and
the same textures and rectangles as on the cluster, with the simulation
driving it. A shader that does not compile there will not compile on the
car. Compare it with the theme's mockup before shipping.

## Not known yet (needs the car)

- How the KOMBI's GPU copes with full-screen art plus about 20 effect
  layers: their fill cost, and whether `highp` is there in fragment
  shaders.
- Whether the KOMBI's renderer draws effect layers with straight-alpha
  blending as the test unit does.
- Which of the signals (rpm, gear, oil temperature, tyres, power, battery)
  the head unit can read on iDrive 7.
- Where the cluster glass and the driver camera's cowl hide the screen's
  edges (themes keep their outermost 100 px and the top centre light).
