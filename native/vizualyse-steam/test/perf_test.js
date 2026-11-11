// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* src/perf.js: the journal's "perf:" lines from wl-sink's stats, on a fake
 * clock and a fake i915 sysfs.   node test/perf_test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
fs.mkdirSync(path.join(sys, 'power'));
const setGpu = (rc6, mhz) => {
    fs.writeFileSync(path.join(sys, 'power', 'rc6_residency_ms'), String(rc6) + '\n');
    fs.writeFileSync(path.join(sys, 'gt_act_freq_mhz'), String(mhz) + '\n');
};
setGpu(1000, 300);
/* a fake /proc (the unit's CPU ticks, meminfo, the game's process 42) and the game's cgroup */
const proc = path.join(sys, 'proc'), cg = path.join(sys, 'cg');
fs.mkdirSync(proc); fs.mkdirSync(path.join(proc, '42')); fs.mkdirSync(cg);
const setSys = (busy, total, gameTicks) => {
    const idle = total - busy;   /* user nice system idle iowait irq softirq steal */
    fs.writeFileSync(path.join(proc, 'stat'), 'cpu  ' + [busy, 0, 0, idle, 0, 0, 0, 0, 0, 0].join(' ') + '\ncpu0 1 2 3 4\n');
    fs.writeFileSync(path.join(proc, '42', 'stat'), '42 (wine64 (x)) S 1 2 3 4 5 6 7 8 9 10 ' + gameTicks + ' 0 0 0\n');
};
setSys(400, 1000, 0);
fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal: 5767168 kB\nMemAvailable: 1228800 kB\nSwapTotal: 1048576 kB\nSwapFree: 741376 kB\n');
fs.writeFileSync(path.join(cg, 'cgroup.procs'), '42\n');
fs.writeFileSync(path.join(cg, 'memory.usage_in_bytes'), String(1830 * 1048576));
fs.writeFileSync(path.join(cg, 'memory.max_usage_in_bytes'), String(1900 * 1048576));
fs.writeFileSync(path.join(cg, 'memory.limit_in_bytes'), String(2560 * 1048576));
process.env.STEAM_GPU_SYSFS = sys;
process.env.STEAM_PROC = proc;
process.env.STEAM_PERF_WINDOW_MS = '10000';
const { Perf, frameStats } = require('../src/perf.js');

/* frameStats: 99 frames of 33.3 ms and one of 100 ms */
const ft = Array(99).fill(33.3).concat([100]);
const f = frameStats(ft);
assert.strictEqual(f.frames, 100);
assert(Math.abs(f.fps - 1000 * 100 / (99 * 33.3 + 100)) < 1e-9, 'fps over the frames\' time');
assert(Math.abs(f.low1 - 10) < 1e-9, '1% low: the slowest frame (one of 100) at 100 ms');
assert(Math.abs(f.low01 - 10) < 1e-9, '0.1% low: at least one frame');
assert.strictEqual(f.worst, 100);
assert.strictEqual(frameStats([]), null);
console.log('ok   fps, 1% and 0.1% lows, worst from frame times');

let now = 0;
const lines = [];
const points = [];
const p = new Perf({ log: (s) => lines.push(s), point: (x) => points.push(x), label: 'Game', frame: { w: 896, h: 320 }, mode: 'off', cgroup: cg, now: () => now });
/* 10 s off: 30 pictures a second, a GPU 60 % busy (4 s of RC6 in 10 s) at
 * 650 MHz, the CPU 80 % busy (800 of 1000 ticks), the game 15 s of CPU in
 * 10 s (150 % of a core) */
for (let i = 0; i < 10; i++) {
    now += 1000;
    if (i === 9) { setGpu(5000, 650); setSys(1200, 2000, 1500); }
    p.sample({ pictures: 30, ms: 1.5, fsrOn: 0, ft: Array(30).fill(33.3) });
}
assert.strictEqual(lines.length, 1, 'a line at 10 s');
assert(/^perf: off at 896x320: 30\.0 fps, 1% low 30\.0/.test(lines[0]), lines[0]);
assert(/30\.0 pictures\/s, wl-sink 1\.5 ms a picture/.test(lines[0]), lines[0]);
/* the clock read each second: nine at 300 MHz and the last at 650 */
assert(/GPU awake 60 % at 335 MHz \(300-650\), CPU 80 %, the game 150 % of a core, memory: the game 1830 MB \(max 1830, peak 1900 of 2560\), available 1200 MB \(min 1200\), swap 300 MB \(max 300\) \(10 s\)$/.test(lines[0]), lines[0]);
assert(!/FSR/.test(lines[0]), 'no FSR part while off');
console.log('ok   a window: ' + lines[0]);
/* the same window as numbers, for the phone page's graphs */
assert.strictEqual(points.length, 1);
assert.deepStrictEqual(points[0], { t: 10000, mode: 'off', s: 10, fps: 30, low1: 30, worstMs: 33.3, pictures: 30, sinkMs: 1.5, fsrMs: null,
    gpuBusy: 60, gpuMhz: 335, cpu: 80, gameCpu: 150, gameMb: 1830, availMb: 1200, swapMb: 300 });
console.log('ok   and as numbers: ' + JSON.stringify(points[0]));

/* FSR on mid-window: the part so far closes under "off", then FSR's window */
now += 3000;
p.sample({ pictures: 30, ms: 1.5, fsrOn: 0, ft: Array(30).fill(33.3) });
p.mode('fsr');
assert(/^perf: off at 896x320: .*\(1 s\)$/.test(lines[1]), lines[1]);
assert.strictEqual(lines[2], 'perf: Game: upscaling off -> fsr');
for (let i = 0; i < 10; i++) {
    now += 1000;
    p.sample({ pictures: 28, ms: 0.4, fsrOn: 1, fsrNow: 28, fsrGpuMs: 4, fsrGpuMaxMs: i === 3 ? 7.5 : 4.5, fsrGpuN: 28,
        fsrSkipped: i === 5 ? 2 : (i > 5 ? 2 : 0), ft: Array(27).fill(33.3).concat([60]) });
}
const fl = lines[3];
assert(/^perf: fsr at 896x320: .* fps, 1% low 16\.7/.test(fl), fl);
assert(/FSR 28\.0\/s at 4\.00 ms GPU \(max 7\.50, 280 measured\), 2 skipped/.test(fl), fl);
assert(!/not used/.test(fl), fl);
console.log('ok   a change of mode closes the window; FSR\'s line: ' + fl);

/* FSR on but not drawing (0.1.11 on the car said nothing): wl-sink's reason in the line */
for (let i = 0; i < 10; i++) {
    now += 1000;
    p.sample({ pictures: 18, ms: 12, fsrOn: 1, fsrWhy: 'barely scaled (1792x640 drawn, 1786x638 on the screen)', ft: Array(18).fill(55) });
}
const nl = lines[lines.length - 1];
assert(/^perf: fsr at 896x320: .*, FSR not used: barely scaled \(1792x640 drawn, 1786x638 on the screen\)/.test(nl), nl);
assert(!/FSR [\d.]+\/s/.test(nl), nl);
console.log('ok   FSR on but not drawing says why: ' + nl);

p.end();
const sum = lines[lines.length - 1];
assert(/^perf: summary for Game: off at 896x320: 30\.0 fps.*\(11 s\); fsr at 896x320: .*\(20 s\)$/.test(sum), sum);
console.log('ok   the summary per mode: ' + sum);
/* off: 330 frames of 33.3 ms; fsr: 270 of 33.3 ms, 10 of 60 and the 180 of 55 ms it didn't draw for */
assert(/\(330 frames: 100 % to 36 ms\)/.test(sum) && /\(460 frames: 59 % to 36 ms, 41 % to 67 ms\)/.test(sum), sum);
console.log('ok   with the spread of its frame times');

/* What names the limit: the GPU's clock against the one asked for and the
 * limit; the unit's wait for the disk; the game's busiest thread,
 * wineserver's part, its threads; the busiest processes that are not the
 * game's; what moved in and out of swap, the major faults. */
{
    const stat = (name, ticks) => '1 (' + name + ') S 1 2 3 4 5 6 7 8 9 10 ' + ticks + ' 0 0 0\n';
    const proc_ = (pid, name, ticks) => {
        try { fs.mkdirSync(path.join(proc, String(pid))); } catch (e) { /* there */ }
        fs.writeFileSync(path.join(proc, String(pid), 'stat'), stat(name, ticks));
    };
    const thread = (pid, tid, name, ticks) => {
        [path.join(proc, String(pid), 'task'), path.join(proc, String(pid), 'task', String(tid))].forEach((d) => { try { fs.mkdirSync(d); } catch (e) { /* there */ } });
        fs.writeFileSync(path.join(proc, String(pid), 'task', String(tid), 'stat'), stat(name, ticks));
    };
    const cpu = (busy, iowait, total) => fs.writeFileSync(path.join(proc, 'stat'), 'cpu  ' + [busy, 0, 0, total - busy - iowait, iowait, 0, 0, 0, 0, 0].join(' ') + '\n');
    const vm = (i, o, f) => fs.writeFileSync(path.join(proc, 'vmstat'), 'nr_free_pages 5\npswpin ' + i + '\npswpout ' + o + '\npgmajfault ' + f + '\n');
    const all = (game, gfx, job, ws, hmi, kswapd, small) => {
        proc_(42, 'Game.exe', game + gfx + job); thread(42, 42, 'Game.exe', game); thread(42, 50, 'UnityGfxDeviceW', gfx); thread(42, 51, 'Job.Worker 1', job);
        proc_(43, 'wineserver', ws); thread(43, 43, 'wineserver', ws);
        proc_(7, 'HmiMain3D', hmi); proc_(8, 'kswapd0', kswapd); proc_(9, 'small', small);
    };
    fs.writeFileSync(path.join(cg, 'cgroup.procs'), '42\n43\n');
    fs.writeFileSync(path.join(sys, 'gt_cur_freq_mhz'), '750\n');
    fs.writeFileSync(path.join(sys, 'gt_max_freq_mhz'), '750\n');
    setGpu(20000, 450); cpu(1000, 100, 5000); vm(1000, 2000, 10); all(500, 500, 500, 500, 500, 500, 500);
    const out = [];
    const r = new Perf({ log: (s) => out.push(s), label: 'Game', frame: { w: 960, h: 540 }, mode: 'off', cgroup: cg, now: () => now });
    for (let i = 0; i < 10; i++) {
        now += 1000;
        /* in the 10 s: the GPU never in RC6, the CPU 800 of 1000 ticks busy and 50 waiting for the disk, the game 14 s of
         * CPU (its graphics thread 9.5 s, wineserver 1 s), the HMI 1.8 s, kswapd 1.2 s; 10 MB in from swap, 20 MB out */
        if (i === 9) { setGpu(20000, 450); cpu(1800, 150, 6000); vm(1000 + 2560, 2000 + 5120, 360); all(800, 1450, 550, 600, 680, 620, 505); }
        r.sample({ pictures: 30, ms: 0.6, fsrOn: 0, ft: i === 9 ? Array(29).fill(33.3).concat([120]) : Array(30).fill(33.3) });
    }
    const l = out[0];
    assert(/GPU awake 100 % at 450 MHz \(asked 750, limit 750\), CPU 80 % \(and 5 % waiting for the disk\)/.test(l), l);
    assert(/the game 140 % of a core \(busiest thread UnityGfxDeviceW 95 %, wineserver 10 %, 4 threads\), others: HmiMain3D 18 %, kswapd0 12 %, memory: /.test(l), l);
    assert(/swap 300 MB \(max 300\), 10 MB swapped in, 20 MB out, 350 major faults \(10 s\)$/.test(l), l);
    console.log('ok   what names the limit: ' + l.replace(/^.*a picture, /, ''));
    r.end();
    assert(/\(300 frames: 99\.7 % to 36 ms, 0\.3 % to 200 ms\)/.test(out[out.length - 1]) && /busiest thread UnityGfxDeviceW 95 %/.test(out[out.length - 1]), out[out.length - 1]);
    console.log('ok   and in the summary, with the frame times\' spread');
}

/* nothing to read (the bench without i915, no cgroup, no /proc): those parts left out, nothing breaks */
const rmTree = (d) => { fs.readdirSync(d).forEach((n) => { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) rmTree(f); else fs.unlinkSync(f); }); fs.rmdirSync(d); };
rmTree(sys);   /* Node 8: no rmSync */
lines.length = 0;
const q = new Perf({ log: (s) => lines.push(s), label: 'Game', frame: { w: 960, h: 540 }, mode: 'off', cgroup: cg, now: () => now });
for (let i = 0; i < 10; i++) { now += 1000; q.sample({ pictures: 30, ms: 1, ft: [33.3] }); }
assert(lines.length === 1 && !/GPU awake|CPU|memory/.test(lines[0]), lines[0]);
console.log('ok   without i915\'s sysfs, /proc or the cgroup: those parts left out');

/* the perf lines kept in the tool's own file: dated, rotated at the size given, one old file kept */
const { keepLine } = require('../src/perf.js');
const kd = fs.mkdtempSync(path.join(os.tmpdir(), 'perflog-')), kf = path.join(kd, 'perf.log');
keepLine(kf, 'perf: one', 200);
keepLine(kf, 'perf: two', 200);
const kl = fs.readFileSync(kf, 'utf8').split('\n').filter(Boolean);
assert(kl.length === 2 && /^\d{4}-\d\d-\d\dT[\d:.]+Z perf: one$/.test(kl[0]) && / perf: two$/.test(kl[1]), kl.join(' | '));
for (let i = 0; i < 10; i++) keepLine(kf, 'perf: line ' + i + ' ' + 'x'.repeat(40), 200);
assert(fs.existsSync(kf + '.1'), 'rotated');
assert(fs.statSync(kf).size < 300 && fs.statSync(kf + '.1').size < 300, 'each about the size given');
assert(/perf: line 9 /.test(fs.readFileSync(kf, 'utf8')), 'the newest in perf.log');
keepLine(path.join(kd, 'no', 'such', 'dir', 'perf.log'), 'perf: lost');   /* no folder: ignored, no throw */
fs.readdirSync(kd).forEach((n) => fs.unlinkSync(path.join(kd, n))); fs.rmdirSync(kd);
console.log('ok   perf lines kept in state/perf.log, dated, rotated with one old file');
console.log('all perf tests passed');
