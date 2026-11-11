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
 * counters in i915's sysfs (read, never the device): the whole GPU (the
 * HMI's drawing too), not FSR's.
 *
 * What says which limit a game is at (0.2.4; until then the lines had a
 * "GPU busy" that read 100 % for any game and nothing about threads):
 * - "GPU awake": the share of the window the GPU was out of RC6, its idle
 *   state. It goes there only after tens of milliseconds with nothing to
 *   do, so a frame every 50 ms keeps it awake all the time however little
 *   each one is: 100 % here is not a GPU with no time left. Its clock says
 *   more: the mean, the lowest and highest seen (each second), the clock
 *   asked for and the limit; a GPU with work waiting is clocked up.
 * - the CPU: the unit's busy share and its share waiting for the disk
 *   (/proc/stat); the game's own (its memory cgroup's processes, in % of
 *   one core), its busiest thread by name (a thread at 100 % is a limit a
 *   total never shows), wineserver's part (this Wine has no esync: on the
 *   unit's kernel every wait goes through it) and how many threads; and
 *   the busiest processes that are not the game's (who has the other
 *   cores).
 * - memory: the game's cgroup's use, max, peak and cap; the unit's
 *   MemAvailable; swap in use, and what moved in and out of it and the
 *   major faults in the window (/proc/vmstat): a stall with pages coming
 *   back from swap is memory's.
 * - the summary's spread of frame times: frames bunched at twice or three
 *   times the frame rate's time are pacing, a wide spread is load.
 * All from /proc and /sys, at a window's ends or once a second; nothing on
 * the frame path.
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
const PAGE_MB = 4096 / 1048576;

function readNum(f) {
    try { const v = Number(fs.readFileSync(f, 'utf8').trim()); return isFinite(v) ? v : null; } catch (e) { return null; }
}
function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* the GPU's counters now: RC6 residency (ms), the clock it runs at and the one asked for (MHz) */
function gpuNow(now) {
    return { at: now, rc6: readNum(path.join(SYSFS, 'power', 'rc6_residency_ms')), mhz: readNum(path.join(SYSFS, 'gt_act_freq_mhz')),
        ask: readNum(path.join(SYSFS, 'gt_cur_freq_mhz')) };
}

/* a /proc/<pid>/stat (or a thread's): its name and its CPU ticks so far */
function procStat(s) {
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');   /* after "pid (comm) ": state is f[0], utime f[11], stime f[12] */
    return { name: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), ticks: Number(f[11]) + Number(f[12]) };
}

/* The CPU now: the unit's ticks (busy, waiting for the disk, all) from
 * /proc/stat; each of the game's processes (its memory cgroup's
 * cgroup.procs) and of their threads; with a cgroup, every other process
 * too; swap's and the major faults' counters (/proc/vmstat). */
function cpuNow(cgroup) {
    const out = { busy: null, total: null, iowait: null, procs: {}, threads: {}, others: {}, vm: null };
    const st = readText(path.join(PROC, 'stat'));
    const m = st && /^cpu\s+(.*)$/m.exec(st);
    if (m) {
        const v = m[1].trim().split(/\s+/).map(Number);   /* user nice system idle iowait irq softirq steal ... */
        const idle = (v[3] || 0) + (v[4] || 0);
        out.total = v.slice(0, 8).reduce((s, x) => s + (x || 0), 0);
        out.busy = out.total - idle;
        out.iowait = v[4] || 0;
    }
    const procs = cgroup && readText(path.join(cgroup, 'cgroup.procs'));
    if (procs) {
        procs.split('\n').filter(Boolean).forEach((pid) => {
            const s = readText(path.join(PROC, pid, 'stat'));
            if (!s) return;
            out.procs[pid] = procStat(s);
            let tids = [];
            try { tids = fs.readdirSync(path.join(PROC, pid, 'task')); } catch (e) { /* gone, or no threads to read */ }
            tids.forEach((tid) => {
                const t = readText(path.join(PROC, pid, 'task', tid, 'stat'));
                if (t) out.threads[tid] = procStat(t);
            });
        });
        let all = [];
        try { all = fs.readdirSync(PROC); } catch (e) { /* none */ }
        all.forEach((pid) => {
            if (!/^\d+$/.test(pid) || out.procs[pid]) return;
            const s = readText(path.join(PROC, pid, 'stat'));
            if (s) out.others[pid] = procStat(s);
        });
    }
    const vm = readText(path.join(PROC, 'vmstat'));
    if (vm) {
        const n = (k) => { const r = new RegExp('^' + k + ' (\\d+)', 'm').exec(vm); return r ? Number(r[1]) : 0; };
        out.vm = { swapIn: n('pswpin'), swapOut: n('pswpout'), majflt: n('pgmajfault') };
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
    return { s: 0, pictures: 0, sinkMsW: 0, fsrPictures: 0, fsrMsW: 0, fsrN: 0, fsrMax: 0, skipped: 0, busyMs: 0, busySpan: 0,
        mhzSum: 0, mhzN: 0, mhzMin: Infinity, mhzMax: 0, askSum: 0, askN: 0, limit: 0, ft: [],
        cpuBusy: 0, cpuIowait: 0, cpuTotal: 0, gameTicks: 0, wsTicks: 0, wallMs: 0, topPct: 0, topName: '', threads: 0, oth: {},
        memN: 0, gameN: 0, gameSum: 0, gameMax: 0, peak: 0, cap: 0, availSum: 0, availMin: Infinity, swapSum: 0, swapMax: 0,
        swapIn: 0, swapOut: 0, majflt: 0,
        why: '' };   /* FSR on but not drawing: wl-sink's last reason (fsrWhy) */
}

const MAXED = { fsrMax: 1, gameMax: 1, peak: 1, cap: 1, swapMax: 1, mhzMax: 1, limit: 1, threads: 1 };
function add(a, b) {
    Object.keys(b).forEach((k) => {
        if (k === 'fs' || k === 'topName') return;   /* a window's own frame statistics: the total's are its own; the name goes with topPct */
        if (k === 'ft') { if (a.ft.length < MAX_FT) a.ft = a.ft.concat(b.ft.slice(0, MAX_FT - a.ft.length)); }
        else if (k === 'availMin' || k === 'mhzMin') a[k] = Math.min(a[k], b[k]);
        else if (k === 'why') a[k] = b[k] || a[k];
        else if (k === 'topPct') { if (b.topPct > a.topPct) { a.topPct = b.topPct; a.topName = b.topName; } }   /* the busiest thread of any window */
        else if (k === 'oth') Object.keys(b.oth).forEach((n) => { a.oth[n] = (a.oth[n] || 0) + b.oth[n]; });
        else a[k] = MAXED[k] ? Math.max(a[k], b[k]) : a[k] + b[k];
    });
}

/* ticks over the wall time, in % of one core */
function cores(ticks, wallMs) { return 100 * (ticks / HZ) / (wallMs / 1000); }

/* the GPU's part of a line: awake (out of RC6), its clock */
function fmtGpu(a) {
    let t = '';
    if (a.busySpan) t += ', GPU awake ' + Math.round(100 * a.busyMs / a.busySpan) + ' %';
    if (a.mhzN) {
        t += ' at ' + Math.round(a.mhzSum / a.mhzN) + ' MHz';
        const more = [];
        if (a.mhzMin !== Infinity && a.mhzMin !== a.mhzMax) more.push(Math.round(a.mhzMin) + '-' + Math.round(a.mhzMax));
        if (a.askN) more.push('asked ' + Math.round(a.askSum / a.askN));
        if (a.limit) more.push('limit ' + Math.round(a.limit));
        if (more.length) t += ' (' + more.join(', ') + ')';
    }
    return t;
}

/* the CPU and memory parts of a line */
function fmtSys(a) {
    const t = [];
    if (a.cpuTotal) {
        const io = Math.round(100 * a.cpuIowait / a.cpuTotal);
        t.push('CPU ' + Math.round(100 * a.cpuBusy / a.cpuTotal) + ' %' + (io >= 1 ? ' (and ' + io + ' % waiting for the disk)' : ''));
    }
    if (a.wallMs) {
        const more = [];
        if (a.topPct >= 1) more.push('busiest thread ' + a.topName + ' ' + Math.round(a.topPct) + ' %');
        const ws = cores(a.wsTicks, a.wallMs);
        if (ws >= 1) more.push('wineserver ' + Math.round(ws) + ' %');
        if (a.threads) more.push(a.threads + ' threads');
        t.push('the game ' + Math.round(cores(a.gameTicks, a.wallMs)) + ' % of a core' + (more.length ? ' (' + more.join(', ') + ')' : ''));
        /* who has the other cores: the busiest processes that are not the game's, from 2 % of a core */
        const oth = Object.keys(a.oth).map((n) => ({ n: n, pct: cores(a.oth[n], a.wallMs) })).filter((x) => x.pct >= 2)
            .sort((x, y) => y.pct - x.pct).slice(0, 3);
        if (oth.length) t.push('others: ' + oth.map((x) => x.n + ' ' + Math.round(x.pct) + ' %').join(', '));
    }
    if (a.memN) {
        const m = [];
        /* the game's part only when its cgroup was read (none on the bench) */
        if (a.gameN) m.push('the game ' + Math.round(a.gameSum / a.gameN) + ' MB (max ' + Math.round(a.gameMax) +
            (a.peak ? ', peak ' + Math.round(a.peak) : '') + (a.cap ? ' of ' + Math.round(a.cap) : '') + ')');
        if (a.availMin !== Infinity) m.push('available ' + Math.round(a.availSum / a.memN) + ' MB (min ' + Math.round(a.availMin) + ')');
        m.push('swap ' + Math.round(a.swapSum / a.memN) + ' MB (max ' + Math.round(a.swapMax) + ')');
        if (a.swapIn || a.swapOut) m.push(Math.round(a.swapIn * PAGE_MB) + ' MB swapped in, ' + Math.round(a.swapOut * PAGE_MB) + ' MB out');
        if (a.majflt) m.push(a.majflt + ' major faults');
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

/* How the frame times spread (the summary): the share of frames up to each
 * time, those with any. The times are a 30 a second frame (with the few ms
 * a tick can be late) and a half, two, three and six of them. */
const SPREAD = [36, 50, 67, 100, 200];
function spread(ft) {
    if (!ft.length) return '';
    const n = SPREAD.map(() => 0).concat([0]);
    ft.forEach((x) => { let i = 0; while (i < SPREAD.length && x > SPREAD[i]) i++; n[i]++; });
    /* whole per cents, a tenth at the ends: 99.7 % and 0.3 %, not 100 % and 0 % */
    const pct = (c) => { const p = 100 * c / ft.length; return (p >= 10 && p <= 99 ? Math.round(p) : Math.round(p * 10) / 10) + ' %'; };
    return n.map((c, i) => (c ? pct(c) + (i < SPREAD.length ? ' to ' + SPREAD[i] + ' ms' : ' longer') : null)).filter(Boolean).join(', ');
}

/* A window as numbers, for the phone page's graphs (server.js /api/perf):
 * the same figures as its "perf:" line, null where not measured. */
function point(a, mode, at) {
    const f = a.fs !== undefined ? a.fs : frameStats(a.ft), r1 = (x) => Math.round(x * 10) / 10;
    return {
        t: at, mode: mode, s: a.s,
        fps: f ? r1(f.fps) : null, low1: f ? r1(f.low1) : null, worstMs: f ? r1(f.worst) : null,
        pictures: a.s ? r1(a.pictures / a.s) : null,
        sinkMs: a.pictures ? Math.round(100 * a.sinkMsW / a.pictures) / 100 : null,
        fsrMs: a.fsrN ? Math.round(100 * a.fsrMsW / a.fsrN) / 100 : null,
        gpuBusy: a.busySpan ? Math.round(100 * a.busyMs / a.busySpan) : null,
        gpuMhz: a.mhzN ? Math.round(a.mhzSum / a.mhzN) : null,
        cpu: a.cpuTotal ? Math.round(100 * a.cpuBusy / a.cpuTotal) : null,
        gameCpu: a.wallMs ? Math.round(cores(a.gameTicks, a.wallMs)) : null,
        gameMb: a.gameN ? Math.round(a.gameSum / a.gameN) : null,
        availMb: a.memN && a.availMin !== Infinity ? Math.round(a.availSum / a.memN) : null,
        swapMb: a.memN ? Math.round(a.swapSum / a.memN) : null,
    };
}

/* a line; whole: with the spread of its frame times (the summary) */
function fmt(a, mode, frame, whole) {
    const r = (x, d) => (a.s ? x / a.s : 0).toFixed(d === undefined ? 1 : d);
    const f = a.fs !== undefined ? a.fs : frameStats(a.ft);
    let t = mode + ' at ' + frame.w + 'x' + frame.h + (frame.detail && frame.detail !== 'normal' ? ' ' + frame.detail : '') + ': ' +
        (f ? f.fps.toFixed(1) + ' fps, 1% low ' + f.low1.toFixed(1) + ', 0.1% low ' + f.low01.toFixed(1) +
            ', frame time p99 ' + f.p99.toFixed(1) + ' ms, worst ' + f.worst.toFixed(1) + ' ms (' + f.frames + ' frames' +
            (whole ? ': ' + spread(a.ft) : '') + '); ' : '') +
        r(a.pictures) + ' pictures/s, wl-sink ' +
        (a.pictures ? (a.sinkMsW / a.pictures).toFixed(1) : '-') + ' ms a picture';
    if (a.fsrPictures) {
        t += ', FSR ' + r(a.fsrPictures) + '/s' + (a.fsrN ? ' at ' + (a.fsrMsW / a.fsrN).toFixed(2) + ' ms GPU (max ' + a.fsrMax.toFixed(2) +
            ', ' + a.fsrN + ' measured)' : ' (no GPU timer)') + ', ' + a.skipped + ' skipped';
    }
    if (a.why && a.fsrPictures < a.pictures) t += ', FSR not used: ' + a.why;
    return t + fmtGpu(a) + fmtSys(a) + ' (' + a.s + ' s)';
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

    /* a new window; cpu: the counters just read (the window before's end) */
    _open(cpu) {
        this.acc = emptyAcc();
        this.started = this.now();
        this.gpu = gpuNow(this.started);
        this.cpu = cpu || cpuNow(this.o.cgroup);
        this.acc.limit = readNum(path.join(SYSFS, 'gt_max_freq_mhz')) || 0;
    }

    /* memory and the GPU's clock once a second (with the stats); cheap reads of a few small files */
    _second() {
        const m = memNow(this.o.cgroup), a = this.acc;
        const mhz = readNum(path.join(SYSFS, 'gt_act_freq_mhz')), ask = readNum(path.join(SYSFS, 'gt_cur_freq_mhz'));
        if (mhz !== null) { a.mhzSum += mhz; a.mhzN++; a.mhzMin = Math.min(a.mhzMin, mhz); a.mhzMax = Math.max(a.mhzMax, mhz); }
        if (ask !== null) { a.askSum += ask; a.askN++; }
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
        if (e.fsrWhy) a.why = String(e.fsrWhy).slice(0, 200);
        if (e.fsrSkipped !== undefined) {
            if (this.lastSkipped !== null) a.skipped += Math.max(0, e.fsrSkipped - this.lastSkipped);
            this.lastSkipped = e.fsrSkipped;
        }
        this._second();
        if (this.now() - this.started >= WINDOW_MS) this.flush();
    }

    /* the window so far into the journal and the mode's total; a new window */
    flush() {
        const a = this.acc, now = this.now(), g = gpuNow(now), was = this.cpu;
        if (this.gpu.rc6 !== null && g.rc6 !== null && now > this.gpu.at) {
            const span = now - this.gpu.at, idle = Math.min(span, Math.max(0, g.rc6 - this.gpu.rc6));
            a.busyMs += span - idle; a.busySpan += span;
        }
        const c = cpuNow(this.o.cgroup);
        if (c.total !== null && was.total !== null && c.total > was.total) {
            a.cpuBusy += c.busy - was.busy; a.cpuTotal += c.total - was.total;
            a.cpuIowait += Math.max(0, c.iowait - was.iowait);
        }
        const pids = Object.keys(c.procs), wall = now - this.started;
        if (pids.length && wall > 0) {
            /* a process (a thread) started in the window counts whole; one that ended is lost */
            const d = (now_, before, id) => Math.max(0, now_[id].ticks - (before[id] ? before[id].ticks : 0));
            pids.forEach((p) => {
                const t = d(c.procs, was.procs, p);
                a.gameTicks += t;
                if (c.procs[p].name === 'wineserver') a.wsTicks += t;
            });
            a.wallMs += wall;
            const tids = Object.keys(c.threads);
            a.threads = tids.length;
            tids.forEach((tid) => {
                const pct = cores(d(c.threads, was.threads, tid), wall);
                if (pct > a.topPct) { a.topPct = pct; a.topName = c.threads[tid].name; }
            });
            Object.keys(c.others).forEach((p) => {
                const t = d(c.others, was.others, p);
                if (t) a.oth[c.others[p].name] = (a.oth[c.others[p].name] || 0) + t;
            });
        }
        if (c.vm && was.vm) {
            a.swapIn += Math.max(0, c.vm.swapIn - was.vm.swapIn); a.swapOut += Math.max(0, c.vm.swapOut - was.vm.swapOut);
            a.majflt += Math.max(0, c.vm.majflt - was.vm.majflt);
        }
        if (a.s) {
            a.fs = frameStats(a.ft);   /* once, for the line and the numbers */
            this.o.log('perf: ' + fmt(a, this.m, this.o.frame));
            if (this.o.point) this.o.point(point(a, this.m, now));
            if (!this.totals[this.m]) { this.totals[this.m] = emptyAcc(); this.order.push(this.m); }
            add(this.totals[this.m], a);
        }
        this._open(c);
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
            this.order.map((m) => fmt(this.totals[m], m, this.o.frame, true)).join('; '));
    }
}

/* The perf lines in a file of the tool's own too (state/perf.log): the
 * unit's journal keeps only the last 10-15 minutes of the tool's lines, too
 * short to read a long run afterwards. Each line with its time; at maxBytes
 * the file becomes perf.log.1 (one kept), so about 2 MB in all (about ten
 * hours of 10 s lines). Failures are ignored: the journal still has them. */
function keepLine(file, line, maxBytes) {
    maxBytes = maxBytes || 1048576;
    try {
        let size = 0;
        try { size = fs.statSync(file).size; } catch (e) { /* new */ }
        if (size >= maxBytes) fs.renameSync(file, file + '.1');
        fs.appendFileSync(file, new Date().toISOString() + ' ' + line + '\n', { mode: 0o644 });
    } catch (e) { /* the journal has it */ }
}

module.exports = { Perf, fmt, point, frameStats, spread, keepLine };
