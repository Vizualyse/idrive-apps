#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// A gauge along a path (version 2): the band lit between a start and the
// value (optionally in segments with gaps), a needle across the path at the
// value, a glow trailing the value plus a pool of light around it, and the
// band's colour past the redline. Everything about the path comes from the
// field texture (THEMES.md "Fields"): R,G the position along it (16 bits),
// B the signed distance from it (128 + d, d > 0 inward), A whether the pixel
// belongs to the gauge. With the theme's art bound (u_area.z > 0) the glow is
// ADDED to the art under it, so ticks and numerals brighten as the needle
// passes; the layer is then opaque over its field and must sit directly on
// the art. Two texture reads, no loops.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_field;
uniform sampler2D u_art;
uniform vec4 u_v;       // x value (0..1 along the path), y path length px, z redline start (0..1, >1 none), w glow trail (0..1 of the path)
uniform vec4 u_band;    // x, y the band's inner and outer d (px); z, w the needle's
uniform vec4 u_shape;   // x glow depth px (inward; a quarter of it outward), y needle half width at its inner end, z at its outer end, w wash (glow along the whole swept part, 0..1)
uniform vec4 u_fill;    // band colour, a = opacity
uniform vec4 u_red;     // band colour past the redline
uniform vec4 u_glow;    // glow colour, a = strength
uniform vec4 u_needle;  // needle colour, a = opacity (0: no needle)
uniform vec4 u_seg;     // x segments (0: one band), y gap px between them, z where the band starts (0..1; lit from here to the value, either way), w where the segments end
uniform vec4 u_pool;    // x radius px of the light at the needle, y its strength, z its centre d px, w 1: the field is mirrored left to right
uniform vec4 u_area;    // this layer's rectangle within the art, 0..1 (x, y, w, h); w 0: no art bound
uniform vec4 u_look;    // x outward reach (a fraction of the depth; 0 none), y brighten (the art x (1 + y * glow): grey numerals turn white), z falloff curve (1 linear, 2 squared; 0: 2), w unused
varying vec2 v_uv;

void main() {
    vec2 fuv = u_pool.w > 0.5 ? vec2(1.0 - v_uv.x, v_uv.y) : v_uv;
    vec4 f = texture2D(u_field, fuv);
    bool art = u_area.z > 0.0;
    if (f.a < 0.5) { gl_FragColor = vec4(0.0); return; }
    vec3 base = art ? texture2D(u_art, u_area.xy + v_uv * u_area.zw).rgb : vec3(0.0);

    float t = (floor(f.r * 255.0 + 0.5) * 256.0 + floor(f.g * 255.0 + 0.5)) / 65535.0;
    float d = floor(f.b * 255.0 + 0.5) - 128.0;
    float len = u_v.y;
    float s = t * len;
    float vs = u_v.x * len;
    float ss = u_seg.z * len;

    // glow: inward (and a little outward) of the path, trailing the value, with a pool at the needle
    float swept = clamp(vs - s + 0.5, 0.0, 1.0);
    float soft = clamp((vs - s) / 8.0 + 0.5, 0.0, 1.0);
    float depth = d >= 0.0 ? clamp(1.0 - d / max(u_shape.x, 1.0), 0.0, 1.0)
                           : (u_look.x > 0.0 ? clamp(1.0 + d / max(u_shape.x * u_look.x, 1.0), 0.0, 1.0) : 0.0);
    float trail = smoothstep(vs - u_v.w * len, vs, s);
    float g = pow(depth, u_look.z > 0.0 ? u_look.z : 2.0) * soft * mix(u_shape.w, 1.0, trail) * step(ss - 0.5, s);
    float r = length(vec2(s - vs, d - u_pool.z)) / max(u_pool.x, 1.0);
    g += u_pool.y * clamp(1.0 - r, 0.0, 1.0) * clamp(1.0 - r, 0.0, 1.0);
    g = clamp(g * u_glow.a, 0.0, 1.5);

    vec3 col;
    float alpha;
    if (art) { col = base * (1.0 + u_look.y * g) + u_glow.rgb * g; alpha = 1.0; }
    else { col = u_glow.rgb; alpha = clamp(g, 0.0, 1.0); }

    // the band, lit between its start and the value
    float lo = min(ss, vs), hi = max(ss, vs);
    float lit = clamp(s - lo + 0.5, 0.0, 1.0) * clamp(hi - s + 0.5, 0.0, 1.0);
    float band = clamp(d - u_band.x + 0.5, 0.0, 1.0) * clamp(u_band.y - d + 0.5, 0.0, 1.0);
    if (u_seg.x > 0.5) {
        float cell = (u_seg.w - u_seg.z) * len / u_seg.x;
        float local = mod(s - ss, max(cell, 1.0));
        float h = u_seg.y * 0.5;
        band *= clamp(local - h + 0.5, 0.0, 1.0) * clamp(cell - h - local + 0.5, 0.0, 1.0);
    }
    vec4 fc = t > u_v.z ? u_red : u_fill;
    float ba = band * lit * fc.a;
    col = mix(col, fc.rgb, ba);
    alpha = max(alpha, ba);

    // the needle
    float k = clamp((d - u_band.z) / max(u_band.w - u_band.z, 1.0), 0.0, 1.0);
    float hw = mix(u_shape.y, u_shape.z, k);
    float n = clamp(hw - abs(s - vs) + 0.5, 0.0, 1.0)
            * clamp(d - u_band.z + 0.5, 0.0, 1.0) * clamp(u_band.w - d + 0.5, 0.0, 1.0) * u_needle.a;
    col = mix(col, u_needle.rgb, n);
    alpha = max(alpha, n);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), alpha);
}
