// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Performance in the journal, to compare ways of running a game afterwards
 * (Upscaling off / FSR / FSR without sharpening, Pictures) without watching
 * the unit while it runs: one "perf:" line per window (10 s by default), a
 * new window at every change of mode, and a summary per mode when the game
 * ends. From wl-sink's stats lines (once a second while it shows pictures:
 * the game's frame times, from which fps, the 1 % and 0.1 % lows, the 99th
 * percentile and the worst frame time; FSR's GPU time) and the GPU's own
 * counters in i915's sysfs (read, never the device):
 * busy = the share of the window the GPU was out of RC6 (its idle state),
 * and its actual clock. The whole GPU (the HMI's drawing too), not FSR's.
 * With them, to cross-reference: the CPU (the unit's busy share from
 * /proc/stat; the game's own, its memory cgroup's processes, in % of one
 * core) and memory (the game's cgroup's use, max, peak and cap; the unit's
 * MemAvailable; swap in use), all from /proc and /sys, nothing on the
 * frame path.
 *
 *   const p = new Perf({ log, label: 'Game', frame: { w, h }, mode: 'off' });
 *   p.sample(stats); p.mode('fsr'); p.end();
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SYSFS = process.env.STEAM_GPU_SYSFS || '/sys/class/drm/card0';
const PROC = process.env.STEAM_PROC || '/proc';
const WINDOW_MS = Number(process.env.STEAM_PERF_WINDOW_MS) || 10000;
const HZ = 100;   /* USER_HZ: /proc's clock ticks (100 on Linux x86) */

function readNum(f) {
    try { const v = Number(fs.readFileSync(f, 'utf8').trim()); return isFinite(v) ? v : null; } catch (e) { return null; }
}
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* the GPU's counters now: RC6 residency (ms), the actual clock (MHz) */
function gpuNow(now) {
    return { at: now, rc6: readNum(path.join(SYSFS, 'power', 'rc6_residency_ms')), mhz: readNum(path.join(SYSFS, 'gt_act_freq_mhz')) };
}

/* The CPU now: the unit's ticks (busy, all) from /proc/stat, and each of
 * the game's processes' (utime + stime; its memory cgroup's cgroup.procs). */
function cpuNow(cgroup) {
    const out = { busy: null, total: null, procs: {} };
    const st = readText(path.join(PROC, 'stat'));
    const m = st && /^cpu\s+(.*)$/m.exec(st);
    if (m) {
        const v = m[1].trim().split(/\s+/).map(Number);   /* user nice system idle iowait irq softirq steal ... */
        const idle = (v[3] || 0) + (v[4] || 0);
        out.total = v.slice(0, 8).reduce((s, x) => s + (x || 0), 0);
        out.busy = out.total - idle;
    }
    const procs = cgroup && readText(path.join(cgroup, 'cgroup.procs'));
    if (procs) {
        procs.split('\n').filter(Boolean).forEach((pid) => {
            const s = readText(path.join(PROC, pid, 'stat'));
            if (!s) return;
            const f = s.slice(s.lastIndexOf(')') + 2).split(' ');   /* after "pid (comm) ": state is f[0], utime f[11], stime f[12] */
            out.procs[pid] = Number(f[11]) + Number(f[12]);
        });
    }
    return out;
}

/* Memory now (MB): the game's cgroup's use and peak (and its cap), the
 * unit's available memory and swap in use (/proc/meminfo). */
function memNow(cgroup) {
    const mb = (b) => (b === null ? null : b / 1048576);
    const out = { game: null, peak: null, cap: null, avail: null, swap: null };
    if (cgroup) {
        out.game = mb(readNum(path.join(cgroup, 'memory.usage_in_bytes')));
        out.peak = mb(readNum(path.join(cgroup, 'memory.max_usage_in_bytes')));
        out.cap = mb(readNum(path.join(cgroup, 'memory.limit_in_bytes')));
    }
    const mi = readText(path.join(PROC, 'meminfo'));
    if (mi) {
        const kb = (k) => { const r = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(mi); return r ? Number(r[1]) / 1024 : null; };
        out.avail = kb('MemAvailable');
        const st = kb('SwapTotal'), sf = kb('SwapFree');
        out.swap = st !== null && sf !== null ? st - sf : null;
    }
    return out;
}

/* a mode's frame times kept for its summary: an hour at 60 fps */
const MAX_FT = 216000;

function emptyAcc() {
    return { s: 0, pictures: 0, sinkMsW: 0, fsrPictures: 0, fsrMsW: 0, fsrN: 0, fsrMax: 0, skipped: 0, busyMs: 0, busySpan: 0, mhzSum: 0, mhzN: 0, ft: [],
        cpuBusy: 0, cpuTotal: 0, gameTicks: 0, wallMs: 0, memN: 0, gameN: 0, gameSum: 0, gameMax: 0, peak: 0, cap: 0, availSum: 0, availMin: Infinity, swapSum: 0, swapMax: 0 };
}

const MAXED = { fsrMax: 1, gameMax: 1, peak: 1, cap: 1, swapMax: 1 };
function add(a, b) {
    Object.keys(b).forEach((k) => {
        if (k === 'ft') { if (a.ft.length < MAX_FT) a.ft = a.ft.concat(b.ft.slice(0, MAX_FT - a.ft.length)); }
        else if (k === 'availMin') a[k] = Math.min(a[k], b[k]);
        else a[k] = MAXED[k] ? Math.max(a[k], b[k]) : a[k] + b[k];
    });
}

/* the CPU and memory parts of a line */
function fmtSys(a) {
    const t = [];
    if (a.cpuTotal) t.push('CPU ' + Math.round(100 * a.cpuBusy / a.cpuTotal) + ' %');
    if (a.wallMs) t.push('the game ' + Math.round(100 * (a.gameTicks / HZ) / (a.wallMs / 1000)) + ' % of a core');
    if (a.memN) {
        const m = [];
        /* the game's part only when its cgroup was read (none on the bench) */
        if (a.gameN) m.push('the game ' + Math.round(a.gameSum / a.gameN) + ' MB (max ' + Math.round(a.gameMax) +
            (a.peak ? ', peak ' + Math.round(a.peak) : '') + (a.cap ? ' of ' + Math.round(a.cap) : '') + ')');
        if (a.availMin !== Infinity) m.push('available ' + Math.round(a.availSum / a.memN) + ' MB (min ' + Math.round(a.availMin) + ')');
        m.push('swap ' + Math.round(a.swapSum / a.memN) + ' MB (max ' + Math.round(a.swapMax) + ')');
        t.push('memory: ' + m.join(', '));
    }
    return t.length ? ', ' + t.join(', ') : '';
}

/* From frame times (ms): fps (frames over their time), the 1 % and 0.1 %
 * lows (the fps of the mean of the slowest 1 % / 0.1 % of frames, at least
 * one frame), the 99th percentile frame time and the worst. null: none. */
function frameStats(ft) {
    if (!ft.length) return null;
    const sorted = ft.slice().sort((x, y) => y - x);   /* slowest first */
    const total = ft.reduce((s, x) => s + x, 0);
    const low = (share) => {
        const n = Math.max(1, Math.floor(ft.length * share));
        const mean = sorted.slice(0, n).reduce((s, x) => s + x, 0) / n;
        return 1000 / mean;
    };
    return { frames: ft.length, fps: 1000 * ft.length / total, low1: low(0.01), low01: low(0.001),
        p99: sorted[Math.min(sorted.length - 1, Math.floor(ft.length * 0.01))], worst: sorted[0] };
}

function fmt(a, mode, frame) {
    const r = (x, d) => (a.s ? x / a.s : 0).toFixed(d === undefined ? 1 : d);
    const f = frameStats(a.ft);
    let t = mode + ' at ' + frame.w + 'x' + frame.h + ': ' +
        (f ? f.fps.toFixed(1) + ' fps, 1% low ' + f.low1.toFixed(1) + ', 0.1% low ' + f.low01.toFixed(1) +
            ', frame time p99 ' + f.p99.toFixed(1) + ' ms, worst ' + f.worst.toFixed(1) + ' ms (' + f.frames + ' frames); ' : '') +
        r(a.pictures) + ' pictures/s, wl-sink ' +
        (a.pictures ? (a.sinkMsW / a.pictures).toFixed(1) : '-') + ' ms a picture';
    if (a.fsrPictures) {
        t += ', FSR ' + r(a.fsrPictures) + '/s' + (a.fsrN ? ' at ' + (a.fsrMsW / a.fsrN).toFixed(2) + ' ms GPU (max ' + a.fsrMax.toFixed(2) +
            ', ' + a.fsrN + ' measured)' : ' (no GPU timer)') + ', ' + a.skipped + ' skipped';
    }
    if (a.busySpan) t += ', GPU busy ' + Math.round(100 * a.busyMs / a.busySpan) + ' %';
    if (a.mhzN) t += ' at ' + Math.round(a.mhzSum / a.mhzN) + ' MHz';
    return t + fmtSys(a) + ' (' + a.s + ' s)';
}

class Perf {
    /* o: { log, label, frame {w, h}, mode, cgroup (the game's memory cgroup dir, or null), now () -> ms } */
    constructor(o) {
        this.o = o;
        this.now = o.now || Date.now;
        this.m = o.mode || 'off';
        this.totals = {};      /* mode -> acc */
        this.order = [];
        this.lastSkipped = null;
        this._open();
    }

    _open() {
        this.acc = emptyAcc();
        this.started = this.now();
        this.gpu = gpuNow(this.started);
        this.cpu = cpuNow(this.o.cgroup);
    }

    /* memory once a second (with the stats); cheap reads of two small files */
    _mem() {
        const m = memNow(this.o.cgroup), a = this.acc;
        if (m.game === null && m.avail === null) return;
        a.memN++;
        if (m.game !== null) { a.gameN++; a.gameSum += m.game; a.gameMax = Math.max(a.gameMax, m.game); }
        a.peak = Math.max(a.peak, m.peak || 0);
        if (m.cap && m.cap < 1e9) a.cap = m.cap;   /* no limit reads as ~8 EB */
        if (m.avail !== null) { a.availSum += m.avail; a.availMin = Math.min(a.availMin, m.avail); }
        a.swapSum += m.swap || 0; a.swapMax = Math.max(a.swapMax, m.swap || 0);
    }

    /* one wl-sink stats event */
    sample(e) {
        const a = this.acc;
        a.s++;
        a.pictures += e.pictures || 0;
        a.sinkMsW += (e.ms || 0) * (e.pictures || 0);
        if (Array.isArray(e.ft)) e.ft.forEach((x) => { if (x > 0 && x < 60000) a.ft.push(x); });
        if (e.fsrNow) {
            a.fsrPictures += e.fsrNow;
            if (e.fsrGpuN > 0 && e.fsrGpuMs >= 0) { a.fsrMsW += e.fsrGpuMs * e.fsrGpuN; a.fsrN += e.fsrGpuN; a.fsrMax = Math.max(a.fsrMax, e.fsrGpuMaxMs || 0); }
        }
        if (e.fsrSkipped !== undefined) {
            if (this.lastSkipped !== null) a.skipped += Math.max(0, e.fsrSkipped - this.lastSkipped);
            this.lastSkipped = e.fsrSkipped;
        }
        this._mem();
        if (this.now() - this.started >= WINDOW_MS) this.flush();
    }

    /* the window so far into the journal and the mode's total; a new window */
    flush() {
        const a = this.acc, now = this.now(), g = gpuNow(now);
        if (this.gpu.rc6 !== null && g.rc6 !== null && now > this.gpu.at) {
            const span = now - this.gpu.at, idle = Math.min(span, Math.max(0, g.rc6 - this.gpu.rc6));
            a.busyMs += span - idle; a.busySpan += span;
        }
        if (g.mhz !== null) { a.mhzSum += g.mhz; a.mhzN++; }
        const c = cpuNow(this.o.cgroup);
        if (c.total !== null && this.cpu.total !== null && c.total > this.cpu.total) {
            a.cpuBusy += c.busy - this.cpu.busy; a.cpuTotal += c.total - this.cpu.total;
        }
        const pids = Object.keys(c.procs);
        if (pids.length && now > this.started) {
            /* a process started in the window counts whole; one that ended is lost */
            a.gameTicks += pids.reduce((s, p) => s + Math.max(0, c.procs[p] - (this.cpu.procs[p] || 0)), 0);
            a.wallMs += now - this.started;
        }
        if (a.s) {
            this.o.log('perf: ' + fmt(a, this.m, this.o.frame));
            if (!this.totals[this.m]) { this.totals[this.m] = emptyAcc(); this.order.push(this.m); }
            add(this.totals[this.m], a);
        }
        this._open();
    }

    /* a change of mode: what ran so far closes under the old one */
    mode(m) {
        if (m === this.m) return;
        this.flush();
        this.o.log('perf: ' + (this.o.label || 'the game') + ': upscaling ' + this.m + ' -> ' + m);
        this.m = m;
    }

    /* the game ended: one line per mode it ran in */
    end() {
        this.flush();
        if (!this.order.length) return;
        this.o.log('perf: summary for ' + (this.o.label || 'the game') + ': ' +
            this.order.map((m) => fmt(this.totals[m], m, this.o.frame)).join('; '));
    }
}

module.exports = { Perf, fmt, frameStats };
