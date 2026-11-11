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
/* vsync on whatever the game asks: wl-sink's frame callback paces it, not DXVK's limiter waiting at full speed
 * (which stays as a stop at twice the rate) */
assert(conf('normal').indexOf('dxgi.syncInterval = 1') >= 0 && conf('normal').indexOf('d3d9.presentInterval = 1') >= 0);
assert(conf('normal').indexOf('dxgi.maxFrameRate = 60') >= 0 && conf('normal').indexOf('d3d9.maxFrameRate = 60') >= 0);
assert(conf('lite').indexOf('d3d11.disableMsaa = True') >= 0 && conf('lite').indexOf('d3d11.maxTessFactor = 8') >= 0);
assert(conf('potato').indexOf('d3d11.maxFeatureLevel = 10_1') >= 0 && conf('potato').indexOf('dxgi.maxDeviceMemory = 512') >= 0);
assert(conf('potato').indexOf('d3d9.maxAvailableMemory = 512') >= 0);
conf('potato').forEach((l) => assert(/^[a-z0-9]+\.[A-Za-z]+ = \S/.test(l), 'a dxvk.conf line: ' + l));
console.log('ok   dxvk.conf per Detail');

/* a Vulkan game's DRM calls: vk_crumbs.so's watch mode (written only when one doesn't come back), on fd 3 */
{
    const v = env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', true, 'normal');
    assert.strictEqual(v.VK_TRIAL_CRUMB_MODE, 'watch');
    assert.strictEqual(v.VK_TRIAL_CRUMB_FD, '3');
    assert(v.LD_PRELOAD.indexOf('vk_crumbs.so') >= 0);
    assert.strictEqual(env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', false, 'normal').VK_TRIAL_CRUMB_MODE, undefined);
    console.log('ok   a Vulkan game\'s crumbs: the watch mode');
}

const w = (d) => env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', false, d).WINE_D3D_CONFIG;
assert.strictEqual(w('normal'), undefined);
assert.strictEqual(w('lite'), 'csmt=1,MultisampleTextures=0,MaxShaderModelHS=0,MaxShaderModelDS=0');
assert(/MaxShaderModelPS=2,VideoMemorySize=512$/.test(w('potato')));
assert.strictEqual(env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', true, 'potato').WINE_D3D_CONFIG, undefined, 'not with DXVK');
console.log('ok   WINE_D3D_CONFIG per Detail, WineD3D only');

/* Unity 4 needs a screen of at least 640x480: the chosen one's shape at a size that holds it */
/* the version in the head of mainData / globalgamemanagers, as on the car */
const head = (v) => Buffer.concat([Buffer.from([0, 0, 0x5e, 0x19, 0, 5, 0x37, 0x1c, 0, 0, 0, 9, 0, 0, 0x5e, 0x30, 0, 0, 0, 0]), Buffer.from(v + '\0', 'latin1'), Buffer.alloc(40)]);
fs.writeFileSync(path.join(root, 'unity4', 'Teslagrad_Data', 'mainData'), head('4.6.2f1'));
fs.writeFileSync(path.join(root, 'unity5', 'Game_Data', 'globalgamemanagers'), head('6000.0.62f1'));
game('unity56', ['Old.exe', 'Old_Data/x']);   /* Unity 5.6: no UnityPlayer.dll either */
fs.writeFileSync(path.join(root, 'unity56', 'Old_Data', 'mainData'), head('5.6.7f1'));
assert.deepStrictEqual(steam.minScreen(path.join(root, 'unity4'), 'Teslagrad.exe'), { w: 640, h: 480, why: 'Unity 4' });
assert.strictEqual(steam.minScreen(path.join(root, 'unity5'), 'Game.exe'), null, 'Unity 6 takes any size');
assert.strictEqual(steam.minScreen(path.join(root, 'unity56'), 'Old.exe'), null, 'Unity 5.6 without UnityPlayer.dll: not Unity 4');
assert.strictEqual(steam.minScreen(path.join(root, 'plain'), 'a.exe'), null, 'no data folder');
assert.strictEqual(steam.minScreen(path.join(root, 'godot'), 'g.exe'), null);
const LIST = [{ id: '960x540', w: 960, h: 540 }, { id: '848x480', w: 848, h: 480 }, { id: '640x360', w: 640, h: 360 },
    { id: '1344x480', w: 1344, h: 480 }, { id: '1120x400', w: 1120, h: 400 }, { id: '896x320', w: 896, h: 320 }];
const at = (id) => LIST.filter((r) => r.id === id)[0];
const U4 = { w: 640, h: 480 };
assert.strictEqual(steam.screenFor(at('896x320'), U4, LIST).id, '1344x480');
assert.strictEqual(steam.screenFor(at('1120x400'), U4, LIST).id, '1344x480');
assert.strictEqual(steam.screenFor(at('640x360'), U4, LIST).id, '848x480');
assert.strictEqual(steam.screenFor(at('960x540'), U4, LIST).id, '960x540', 'big enough: kept');
assert.strictEqual(steam.screenFor(at('896x320'), null, LIST).id, '896x320', 'no minimum: kept');
const odd = steam.screenFor({ id: 'x', w: 700, h: 300 }, U4, LIST);
assert(odd.w >= 640 && odd.h >= 480 && odd.w % 16 === 0 && Math.abs(odd.w / odd.h - 700 / 300) < 0.05, JSON.stringify(odd));
console.log('ok   a Unity 4 game\'s screen at least 640x480, the chosen shape kept');

/* iris for OpenGL: its own EGL set in place of the unit's, by name; not with Vulkan */
const we = (vulkan, iris, engine) => env.wineEnv({ env: {}, argv: [] }, 1, 'wayland-x', vulkan, 'normal', iris, engine);
const ir = we(false, true);
assert(ir.LD_LIBRARY_PATH.split(':')[0] === env.IRIS + '/lib' && ir.LD_LIBRARY_PATH.indexOf(env.GPU_LIBS) < 0, ir.LD_LIBRARY_PATH);
assert.strictEqual(ir.LIBGL_DRIVERS_PATH, env.IRIS + '/lib/dri');
assert.strictEqual(ir.MESA_LOADER_DRIVER_OVERRIDE, 'iris');
const i9 = we(false, false);
assert(i9.LD_LIBRARY_PATH.split(':')[0] === env.GPU_LIBS && i9.MESA_LOADER_DRIVER_OVERRIDE === undefined, 'i965 by default');
assert.strictEqual(we(true, true).MESA_LOADER_DRIVER_OVERRIDE, undefined, 'not with Vulkan on');
console.log('ok   iris: Wine\'s GL on its own set, by name; i965 by default and with Vulkan');

/* Godot on OpenGL: every extension enabled in its shaders (packHalf2x16 in GLSL 330) */
assert.strictEqual(we(false, false, 'godot').force_glsl_extensions_warn, 'true');
assert.strictEqual(we(true, false, 'godot').force_glsl_extensions_warn, undefined, 'not on Vulkan');
assert.strictEqual(we(false, false, 'unity').force_glsl_extensions_warn, undefined, 'Godot only');
console.log('ok   Godot on OpenGL: force_glsl_extensions_warn');

/* gbe_fork's steam_interfaces.txt from a game's own steam_api.dll: Teslagrad's
 * (Steamworks 2013) strings, between binary bytes and lookalikes */
const dll = Buffer.concat([Buffer.from([0x4d, 0x5a, 0, 0, 0x90]),
    Buffer.from('SteamClient012\0SteamUser017\0SteamFriends013\0SteamUtils006\0SteamMatchMaking009\0SteamMatchMakingServers002\0' +
        'STEAMUSERSTATS_INTERFACE_VERSION011\0STEAMAPPS_INTERFACE_VERSION005\0SteamNetworking005\0STEAMREMOTESTORAGE_INTERFACE_VERSION011\0' +
        'STEAMSCREENSHOTS_INTERFACE_VERSION002\0STEAMHTTP_INTERFACE_VERSION002\0STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001\0SteamUser017\0' +
        'SteamAPI_Init\0xSteamClient012\0SteamClient0123\0Steam\0', 'latin1'), Buffer.from([0xff, 0xfe, 0])]);
assert.deepStrictEqual(steam.steamInterfaces(dll), ['STEAMAPPS_INTERFACE_VERSION005', 'STEAMHTTP_INTERFACE_VERSION002',
    'STEAMREMOTESTORAGE_INTERFACE_VERSION011', 'STEAMSCREENSHOTS_INTERFACE_VERSION002', 'STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001',
    'STEAMUSERSTATS_INTERFACE_VERSION011', 'SteamClient012', 'SteamFriends013', 'SteamMatchMaking009', 'SteamMatchMakingServers002',
    'SteamNetworking005', 'SteamUser017', 'SteamUtils006']);
assert.deepStrictEqual(steam.steamInterfaces(Buffer.from('a stand-in')), []);
console.log('ok   steam_interfaces.txt: the old interface versions of a game\'s own steam_api.dll');

/* SteamStub: a .bind section in the program's section table */
const pe = (sections) => {
    const h = Buffer.alloc(1024);
    h.writeUInt16LE(0x5a4d, 0); h.writeUInt32LE(0x80, 0x3c);
    h.writeUInt32LE(0x00004550, 0x80); h.writeUInt16LE(0x14c, 0x84);
    h.writeUInt16LE(sections.length, 0x86); h.writeUInt16LE(0xe0, 0x94);   /* the optional header's size */
    sections.forEach((s, i) => h.write(s, 0x80 + 24 + 0xe0 + i * 40, 'latin1'));
    return h;
};
fs.writeFileSync(path.join(root, 'stub.exe'), pe(['.text', '.rdata', '.data', '.bind']));
fs.writeFileSync(path.join(root, 'plain.exe'), pe(['.text', '.rdata', '.data', '.rsrc']));
fs.writeFileSync(path.join(root, 'junk.exe'), Buffer.from('not a program'));
assert.strictEqual(steam.steamStub(root, 'stub.exe'), true);
assert.strictEqual(steam.steamStub(root, 'plain.exe'), false);
assert.strictEqual(steam.steamStub(root, 'junk.exe'), null);
assert.strictEqual(steam.arch(root, 'stub.exe'), 'x86', 'the same header arch reads');
console.log('ok   SteamStub: a .bind section on the program');

const rm = (d) => { fs.readdirSync(d).forEach((n) => { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) rm(f); else fs.unlinkSync(f); }); fs.rmdirSync(d); };
rm(root);
console.log('all detail tests passed');
