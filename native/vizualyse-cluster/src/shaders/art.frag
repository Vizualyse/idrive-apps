#version 100
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// The theme's static art: an asset drawn as it is. The art is an asset, not
// an image layer, so the gauge layers can sample it too and add their glow
// to it (gauge.frag) without a second upload.
precision mediump float;
uniform sampler2D u_img;
uniform vec4 u_area;    // the rectangle of the asset this layer shows, 0..1
varying vec2 v_uv;

void main() {
    gl_FragColor = texture2D(u_img, u_area.xy + v_uv * u_area.zw);
}
