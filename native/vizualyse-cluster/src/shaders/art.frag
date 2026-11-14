#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// The theme's static art, drawn through its tile map (THEMES.md "Static
// art"): the art's distinct tiles and the map of the screen's tiles share one
// texture (tools/tiles.js). A pixel's tile is looked up in the map (two tiles
// a texel: R, G the even tile's slot, B, A the odd one's, as column and row
// in tiles), then the slot's texel at the pixel's place in its tile. Nearest
// sampling at texel centres, so the art comes back exactly. The gauge layers
// read the art the same way to add their glow to it (gauge.frag).
// With u_tile.z 0 the texture is drawn as it is, u_area its rectangle 0..1
// (a sprite: tools/design_build.js). Two texture reads.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_img;
uniform vec4 u_area;    // the rectangle of the art this layer shows, in tiles (x, y, w, h); untiled: 0..1
uniform vec4 u_tile;    // x, y the texture's size px; z the tile size px (0: not tiled); w unused
varying vec2 v_uv;

void main() {
    vec2 p = u_area.xy + v_uv * u_area.zw;
    vec2 uv = p;
    if (u_tile.z > 0.5) {
        vec2 tile = floor(p);
        float hx = floor(tile.x * 0.5);
        vec4 e = texture2D(u_img, (vec2(hx, tile.y) + 0.5) / u_tile.xy);
        vec2 slot = floor((tile.x - hx * 2.0 < 0.5 ? e.rg : e.ba) * 255.0 + 0.5);
        uv = (slot + p - tile) * u_tile.z / u_tile.xy;
    }
    gl_FragColor = texture2D(u_img, uv);
}
