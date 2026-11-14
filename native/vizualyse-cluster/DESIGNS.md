<!-- SPDX-License-Identifier: GPL-3.0-or-later
     Copyright (C) 2026 Yousaf Khan -->

# Cluster designs: a theme as one HTML page

A theme can be written as **one page**, `themes/<id>/design.html`: plain
HTML/SVG of the whole cluster, with marker attributes on the parts that
move. `node tools/design_build.js themes/<id>` turns it into the theme's
`theme.src.json`, `art.html`, sprites and `logic.js` (all generated: edit
the design, not those) and runs `tools/theme_build.js`. How themes are
drawn and their limits: [THEMES.md](THEMES.md). The proof:
[`themes/g20i1d/design.html`](themes/g20i1d/design.html).

## The page

- **Canvas:** 1920 x 720 at (0, 0), black background (`body { margin: 0;
  background: #000 }`, an `<svg width="1920" height="720">`). The theme
  covers the old bottom strip (`"bottom": 720`); the car's warning lights
  draw over it anyway.
- **Top keep-clear zone:** nothing important in the top **40 px** (the
  cluster's frame hides some of it). One number, `<meta name="safe-top"
  content="40">`: a marked part starting above it is an error; unmarked art
  there is a warning unless it carries `data-bleed` (washes, glows).
- **Everything not marked is static art**, rendered once by headless Chrome
  (fonts via `@font-face` with local files; scripts may draw ticks and
  numerals, the build measures after they ran).
- `data-guide` on anything: shown in the design, never drawn by the theme.

| In `<head>` | |
|---|---|
| `<meta name="theme-id" content="g20i1d">` | default: the folder's name; `[a-z0-9]+` |
| `theme-title`, `theme-family`, `theme-mode` (`sport`/`comfort`), `theme-ship` (`false` keeps it out of the kit) | |
| `theme-bottom` | 720 (default), or 646 to leave the strip to the car |
| `safe-top` | 40 |
| `<meta name="let:cue" content="rpm >= P.shiftRpm && throttle > 0.5">` | a shared value, evaluated each tick before the layers, usable by name |
| `<script type="application/json" id="theme-params">{...}</script>` | `P`, the theme's numbers |
| `:root { --sport: #ff2b1c; ... }` | every colour custom property is `C.sport` (`C.barTrack` for `--bar-track`) |

## Marked elements become layers

A marked element is **removed from the art** (hidden) and becomes a layer,
in document order (later is on top). Names are letters and digits, unique;
marked elements don't nest. Geometry is always the element's **real
on-screen geometry** (through its transforms), measured in Chrome.

### `data-gauge="<name>"`: along a path (gauge shader)

On an SVG shape (`path`, `line`, `polyline`, `circle`...). Its path, sampled
every 2 px with `getPointAtLength` through `getScreenCTM`, is the field's
path, in the path's direction (value 0 at its start). `data-keep` keeps the
element in the art (an outline that is also the gauge's path).

| Attribute | Means (d: px from the path, > 0 inward) | Default |
|---|---|---|
| `data-value` | binding, 0..1 along the scale | |
| `data-start`, `data-end` | px along the path where 0 sits, px before its end where 1 sits | 0, 0 |
| `data-band="in out"` | the lit band's d range | the element's stroke: ±width/2 |
| `data-band-color` | colour (binding allowed) | the stroke colour |
| `data-from` | where the band starts, 0..1 (binding allowed: drive up, regen down) | 0 |
| `data-segments="count gap"` | band in segments, gap px | one band |
| `data-needle="in out width [outerWidth]"`, `data-needle-color` | needle d range and width | none |
| `data-glow="depth trail wash"`, `data-glow-color` (alpha = strength) | glow depth px, trail px behind the value, wash 0..1 | none |
| `data-pool="radius strength d"` | light at the needle | none |
| `data-look="reach brighten falloff"` | outward reach (x depth), art brightened x(1 + k glow), falloff power | `0.25 0 2` |
| `data-red`, `data-red-color` | redline, 0..1 of the scale | none |
| `data-inward` | `left`/`right` of travel, `auto` (toward the shape's middle) | auto |
| `data-maxd` | how far the field reaches, px (<= 127) | from band, needle, glow, pool |
| `data-ends` | keep the round ends (short bars) | |
| `data-art="off"` | glow blended over what's below instead of drawn into the art (no art under the field) | on |
| `data-reuse="<gauge>"` | reuse that gauge's field: the build checks this path is its **mirror about the middle**, a **copy moved**, or a **copy flipped** (1.5 px), else an error | |

The field's rectangle is the path's normals from the outward to the inward
reach. A gauge with the art on is opaque over its field: put sprites after it.

### `data-text="<name>"`: changing text (text shader)

On an SVG `<text>` (or an HTML element). Font family, weight, size,
letter-spacing, tabular or proportional figures, colour (fill x opacity),
the anchor (`text-anchor`/`text-align`) and the baseline are measured. One
atlas per distinct font (family, weight, size, tracking, figures).

| Attribute | |
|---|---|
| `data-text-expr` | binding: what it shows |
| `data-color` | colour binding (default: the element's) |
| `data-null` | what a null shows (default `--`) |
| `data-glyphs` | characters it may show that the bench drive never does (`PRND`) |
| `data-width`, `data-cells`, `data-align` | override the measured ones |

The build runs the logic over both bench drives (and with the car giving
little or nothing) and records every string each text shows: that picks the
atlas's glyphs and the layer's width. **The placeholder text counts too:
make it the widest value** (`100` for a percentage).

### `data-leds`, `data-rect`, `data-sprite`, `data-map`

| Marker | On | Attributes |
|---|---|---|
| `data-leds="<name>"` | any element; its box is the layer (put a `fill="none"` rect in a group to set it) | `data-count`, `data-lit` (binding: steps lit), `data-flash` (binding: true = all `c2`), `data-mode` (`fill` / `ends`), `data-light="w h"`, `data-split="a b"` (c0 below a, c1 below b, else c2), `data-radius`, `data-halo`, `data-lean="px gap chevron"`, `data-c0`/`c1`/`c2`/`off` colours |
| `data-rect="<name>"` | `rect`, `circle`, HTML box | fill = `u_color`, `rx` = radius (circle: a dot), stroke = ring (`data-ring` width); `data-color`, `data-ring-color` bindings |
| `data-sprite="<name>"` | a static group | rendered **over the art under it**, cropped to its box (+`data-pad`, 4 px): a small texture on an art layer, shown by `data-show`. Hidden, the plain art shows. |
| `data-map` | a rect | **the theme's map slot (used by a later map integration)**: recorded as `"map": {x, y, w, h, radius}` in the built theme; at most one; it stays plain art, no layer |

Any layer also takes `data-show` (binding; false or null hides it),
`data-dx`/`data-dy` (bindings: px moved from the design's position) and
`data-rate` (Hz: evaluate at most this often; 10 for second-glance numbers
keeps the uniform traffic down).

## Bindings

A binding is a JavaScript expression, compiled into `logic.js` (they come
from our own repo and run only at build and tool time). In scope:

- **Signals** by name (`src/sim.js`): `kmh`, `rpm`, `gear`, `gearMode`,
  `throttle`, `engineHp`, `elecHp`, `socPct`, `fuelPct`, `oilC`, `tyres[i].bar`...
  A misspelt name is a build error listing them.
- **Helpers:** `mph(kmh)`, `miles(km)`, `psi(bar)`, `fmt(v, decimals, '+')`,
  `round(v, step)`, `clamp(x, a = 0, b = 1)`, `when(cond, a, b)`,
  `step(v, c0, t1, c1, t2, c2...)` (thresholds), `ok(v)`, `alpha(colour, a)`,
  `rgb(r, g, b, a)`, `abs min max floor ceil`, `Math`; stateful:
  `smooth(x, omega = 14)` (a spring), `latch(set, reset)`, `flash(hz, on)`;
  `t`, `dt`; `C.<colour>`, `P.<param>`, the lets.
- **Colours:** `#rrggbb` written bare, `var(--name)`, `C.name`, `rgb(...)`.
- **Null:** a missing reading is `undefined` in the expression, so arithmetic
  gives NaN. A result that is undefined, NaN, contains `undefined`/`NaN`, or
  throws is **null**: a text shows `--` (`data-null`), a gauge, leds, rect
  or sprite hides; a null colour keeps the last one.
- A constant (no signals, lets or stateful helpers) is evaluated at build
  time into the layer's uniforms.
- Stateful helpers keep their state per call site, in call order: don't put
  them behind `?:` or `&&` (`when()` evaluates both sides, so it's safe).

**`logic.extra.js`** (optional), for what attributes can't say:
`module.exports = { update(sig, ctx, out, { lets, P, C, DR }) { ... } }`
runs after the bindings; change `out` (or return a new one). It is inlined
into `logic.js` (one file, Node 8).

## Checks

Errors name the element and its line in design.html: unknown names,
syntax, a reuse whose path doesn't match, a part outside 0..1920 or past the
theme's bottom, in the keep-clear zone, more than 40 layers (the art is
one), more than 12 textures (the art, each field not reused, each font, each
sprite), a text that can show more than 16 characters, an atlas wider than
2048, a font without an `@font-face`. `theme_build` then checks the built
theme (`theme_core.check`: uniform vectors, asset sizes), and
`node test/themes_test.js` runs its logic.

## Worked example

```html
<meta name="theme-id" content="demo1"><meta name="theme-title" content="Demo">
<meta name="safe-top" content="40">
<meta name="let:v" content="smooth(mph(kmh), 14)">
<script type="application/json" id="theme-params">{ "maxMph": 160, "shift": 6000 }</script>
<style>
  @font-face { font-family: Barlow; font-weight: 500; src: url(../fonts/BarlowSemiCondensed-500.woff2); }
  :root { --ink: #f6efe8; --red: #ff2b1c; --track: #2c2624; }
  body { margin: 0; background: #000 } text { font: 500 30px Barlow; fill: var(--ink); font-variant-numeric: tabular-nums }
</style>
<svg width="1920" height="720">
  <!-- the dial: its track is art; the arc is the gauge (band from its stroke) -->
  <circle cx="480" cy="380" r="260" fill="none" stroke="var(--track)" stroke-width="20"/>
  <path d="M296 564 A260 260 0 1 1 664 564" fill="none" stroke="var(--red)" stroke-width="20"
        data-gauge="speed" data-value="v / P.maxMph" data-needle="-14 40 4" data-needle-color="#fff"/>
  <text x="480" y="400" text-anchor="middle" style="font-size:120px"
        data-text="speedText" data-text-expr="fmt(v)">160</text>
  <!-- the same dial for revs, the speedometer's mirror image: no second field -->
  <path d="M1624 564 A260 260 0 1 0 1256 564" fill="none" stroke="var(--red)" stroke-width="20"
        data-gauge="tach" data-reuse="speed" data-value="smooth(rpm, 16) / 8000"/>
  <g data-sprite="shiftUp" data-show="rpm >= P.shift"><path d="M1420 300 l30 -32 l30 32" stroke="var(--red)" stroke-width="7" fill="none"/></g>
  <circle cx="960" cy="380" r="8" fill="var(--red)" data-rect="dot" data-show="flash(2.5, rpm >= P.shift)"/>
  <text x="960" y="690" text-anchor="middle" data-text="oil" data-text-expr="fmt(oilC) + '°'"
        data-color="step(oilC, C.ink, 120, C.red)" data-rate="10">120°</text>
  <rect data-map x="760" y="120" width="400" height="400" rx="16" fill="none"/>
</svg>
```

`node tools/design_build.js themes/demo1`, then
`node tools/preview_shot.js demo1 9 out.png`.
