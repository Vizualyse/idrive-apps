#version 450
// SPDX-License-Identifier: GPL-3.0-or-later
// vkprobe's draw stage: each pixel's colour from its own position, so the
// CPU can check every one: (x/256, y/256, 0, 1).
layout(location = 0) out vec4 color;
void main() {
    color = vec4(gl_FragCoord.x / 256.0, gl_FragCoord.y / 256.0, 0.0, 1.0);
}
