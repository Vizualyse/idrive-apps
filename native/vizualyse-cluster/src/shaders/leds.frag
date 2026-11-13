#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// A row of shift lights, drawn from uniforms alone: n equal cells across the
// layer, each a rounded rectangle with a soft halo when lit. They fill left
// to right (mode 0) or from both ends inward in pairs (mode 1); colours
// change at two steps of the fill. Version 2: the lights lean (a shear) and
// the row can have a wider gap in its middle. Flashing is the tool's toggle,
// not a clock here.
precision mediump float;
uniform vec4 u_led;     // x count n, y lit (steps of the fill), z 0 normal / 1 all flash colour / 2 all off, w mode
uniform vec4 u_geom;    // x layer width px, y layer height px, z light width px, w light height px
uniform vec4 u_split;   // x first step in u_c1, y first step in u_c2, z corner radius px, w halo px
uniform vec4 u_lean;    // x lean px (the top's offset to the right of the bottom), y extra gap px in the middle, z 1: the right half leans the other way (a chevron)
uniform vec4 u_c0;
uniform vec4 u_c1;
uniform vec4 u_c2;
uniform vec4 u_off;
varying vec2 v_uv;

void main() {
    float n = u_led.x;
    float w = u_geom.x - u_lean.y - abs(u_lean.x);
    /* the row's own x: the top sits u_lean.x to the right of the bottom */
    float lean = u_lean.z > 0.5 && v_uv.x > 0.5 ? -u_lean.x : u_lean.x;
    float x = v_uv.x * u_geom.x - abs(u_lean.x) * 0.5 - lean * (0.5 - v_uv.y);
    float mid = w * 0.5;
    float gapped = x > mid + u_lean.y ? x - u_lean.y : (x > mid ? -1.0 : x);
    float cw = w / n;
    float i = clamp(floor(gapped / cw), 0.0, n - 1.0);
    /* a chevron: each half draws only its own lights (the lean must not carry
     * a light across the middle) */
    if (u_lean.z > 0.5) i = v_uv.x > 0.5 ? max(i, ceil(n * 0.5)) : min(i, floor(n * 0.5) - 1.0);
    float step_ = u_led.w > 0.5 ? min(i, n - 1.0 - i) : i;
    vec2 p = vec2(gapped - (i + 0.5) * cw, (v_uv.y - 0.5) * u_geom.y);
    vec2 half_ = vec2(u_geom.z, u_geom.w) * 0.5 - u_split.z;
    vec2 q = abs(p) - half_;
    float sd = gapped < 0.0 ? 99.0 : length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_split.z;
    float body = clamp(0.5 - sd, 0.0, 1.0);

    bool lit = step_ < u_led.y;
    vec4 c = step_ < u_split.x ? u_c0 : step_ < u_split.y ? u_c1 : u_c2;
    if (u_led.z > 1.5) lit = false;
    else if (u_led.z > 0.5) { lit = true; c = u_c2; }

    vec4 col = lit ? c : u_off;
    float halo = lit ? clamp(1.0 - sd / max(u_split.w, 1.0), 0.0, 1.0) : 0.0;
    float a = max(body * col.a, halo * halo * 0.45 * c.a);
    gl_FragColor = vec4(col.rgb, a);
}
