// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* A game's Detail: engines told apart by their folders (steam.engine), their
 * launch options (steam.detailArgs), DXVK's options and WineD3D's
 * (env.dxvkConf, env.DETAIL_WINED3D).   node test/detail_test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const steam = require('../src/steam.js');
const env = require('../src/env.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-'));
const mk = (rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
const game = (name, files) => { files.forEach((f) => mk(name + '/' + f)); return path.join(root, name); };

const cases = [
    ['unity5', ['Game.exe', 'UnityPlayer.dll', 'Game_Data/x'], 'Game.exe', 'unity'],
    ['unity4', ['Teslagrad.exe', 'Teslagrad_Data/x'], 'Teslagrad.exe', 'unity'],
    ['godot', ['g.exe', 'g.pck'], 'g.exe', 'godot'],
    ['ue', ['Engine/x', 'Shooter/Binaries/Win64/Shooter-Win64-Shipping.exe', 'Shooter.exe'], 'Shooter/Binaries/Win64/Shooter-Win64-Shipping.exe', 'unreal'],
    ['uelauncher', ['Engine/x', 'Shooter/Binaries/Win64/x', 'Shooter.exe'], 'Shooter.exe', 'unreal'],
    ['source', ['hl2.exe', 'bin/engine.dll'], 'hl2.exe', 'source'],
    ['plain', ['a.exe'], 'a.exe', null],
];
cases.forEach(([name, files, exe, want]) => assert.strictEqual(steam.engine(game(name, files), exe), want, name));
console.log('ok   engines: ' + cases.map((c) => c[0] + '=' + c[3]).join(', '));

assert.deepStrictEqual(steam.detailArgs('unity', 'normal'), []);
assert.deepStrictEqual(steam.detailArgs('unity', 'lite'), ['-screen-quality', 'Fast']);
assert.deepStrictEqual(steam.detailArgs('unity', 'potato'), ['-screen-quality', 'Fastest']);
assert(/^-ExecCmds=sg\.ShadowQuality 0,sg\.PostProcessQuality 0,sg\.EffectsQuality 0$/.test(steam.detailArgs('unreal', 'lite')[0]));
assert(/sg\.TextureQuality 0/.test(steam.detailArgs('unreal', 'potato')[0]));
assert.deepStrictEqual(steam.detailArgs('source', 'potato').slice(-4), ['+mat_picmip', '2', '-dxlevel', '90']);
assert.deepStrictEqual(steam.detailArgs('godot', 'potato'), []);
assert.deepStrictEqual(steam.detailArgs(null, 'lite'), []);
console.log('ok   launch options per engine and Detail');

const conf = (d) => env.dxvkConf(30, d).trim().split('\n');
assert(!conf('normal').some((l) => /disableMsaa|maxFeatureLevel|maxTessFactor/.test(l)), 'normal adds nothing');
assert(conf('normal').indexOf('dxgi.maxDeviceMemory = 1024') >= 0);
assert(conf('lite').indexOf('d3d11.disableMsaa = True') >= 0 && conf('lite').indexOf('d3d11.maxTessFactor = 8') >= 0);
assert(conf('potato').indexOf('d3d11.maxFeatureLevel = 10_1') >= 0 && conf('potato').indexOf('dxgi.maxDeviceMemory = 512') >= 0);
assert(conf('potato').indexOf('d3d9.maxAvailableMemory = 512') >= 0);
conf('potato').forEach((l) => assert(/^[a-z0-9]+\.[A-Za-z]+ = \S/.test(l), 'a dxvk.conf line: ' + l));
console.log('ok   dxvk.conf per Detail');

const w = (d) => env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', false, d).WINE_D3D_CONFIG;
assert.strictEqual(w('normal'), undefined);
assert.strictEqual(w('lite'), 'csmt=1,MultisampleTextures=0,MaxShaderModelHS=0,MaxShaderModelDS=0');
assert(/MaxShaderModelPS=2,VideoMemorySize=512$/.test(w('potato')));
assert.strictEqual(env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', true, 'potato').WINE_D3D_CONFIG, undefined, 'not with DXVK');
console.log('ok   WINE_D3D_CONFIG per Detail, WineD3D only');

const rm = (d) => { fs.readdirSync(d).forEach((n) => { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) rm(f); else fs.unlinkSync(f); }); fs.rmdirSync(d); };
rm(root);
console.log('all detail tests passed');
