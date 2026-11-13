#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// A rounded rectangle filling the layer, in a colour the tool sets: a tyre
// chip, an indicator, a dot (radius half the size). Version 2: a ring in its
// own colour around the fill (u_ring.a 0: no ring), so a cold tyre can be
// drawn hollow (fill transparent, ring coloured).
precision mediump float;
uniform vec4 u_color;
uniform vec4 u_shape;   // x layer width px, y layer height px, z corner radius px, w ring width px (0: no ring)
uniform vec4 u_ring;    // the ring's colour
varying vec2 v_uv;

void main() {
    vec2 p = (v_uv - 0.5) * u_shape.xy;
    vec2 q = abs(p) - (u_shape.xy * 0.5 - u_shape.z);
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_shape.z;
    float inside = clamp(0.5 - sd, 0.0, 1.0);
    float ring = u_shape.w > 0.0 ? inside * clamp(sd + u_shape.w + 0.5, 0.0, 1.0) : 0.0;
    vec4 col = mix(u_color, u_ring, ring * u_ring.a);
    float a = max(inside * u_color.a * (1.0 - ring * u_ring.a), ring * u_ring.a);
    gl_FragColor = vec4(col.rgb, a);
}
