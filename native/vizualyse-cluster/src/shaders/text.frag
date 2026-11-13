#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Up to 16 glyphs over a glyph atlas (R8: one row of equal cells, each glyph
// drawn from its cell's left edge). Version 2: proportional. u_pos holds
// each glyph's left edge in pixels within the layer (laid out by the tool
// from the font's advances, aligned), so a decimal point or a degree sign
// takes its own width. One texture read; one constant loop of 16 compares
// (the only loop the library allows past 4: text layers are small).
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_font;
uniform vec4 u_text[4];   // glyph codes, 4 to a vec4
uniform vec4 u_pos[4];    // each glyph's left edge, px in the layer, ascending; past the text: a large number
uniform vec4 u_meta;      // x layer width px, y glyphs in the atlas, z cell width px, w glyphs in use
uniform vec4 u_color;
varying vec2 v_uv;

float pick(vec4 v, float lane) { return lane < 0.5 ? v.x : lane < 1.5 ? v.y : lane < 2.5 ? v.z : v.w; }

void main() {
    float x = v_uv.x * u_meta.x;
    float code = -1.0, left = 0.0;
    for (int i = 0; i < 16; i++) {
        float slot = floor(float(i) / 4.0), lane = float(i) - slot * 4.0;
        vec4 p = slot < 0.5 ? u_pos[0] : slot < 1.5 ? u_pos[1] : slot < 2.5 ? u_pos[2] : u_pos[3];
        vec4 c = slot < 0.5 ? u_text[0] : slot < 1.5 ? u_text[1] : slot < 2.5 ? u_text[2] : u_text[3];
        float px = pick(p, lane);
        if (float(i) < u_meta.w && x >= px) { code = pick(c, lane); left = px; }
    }
    float local = x - left;
    float ink = 0.0;
    if (code >= 0.0 && local < u_meta.z)
        ink = texture2D(u_font, vec2((code * u_meta.z + local) / (u_meta.y * u_meta.z), v_uv.y)).r;
    gl_FragColor = vec4(u_color.rgb, u_color.a * ink);
}
