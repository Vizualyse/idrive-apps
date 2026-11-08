// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Chromium, driven over the DevTools protocol on a pipe
 * (--remote-debugging-pipe: we write NUL-terminated JSON on its fd 3, read
 * its fd 4). One page (tab) at the viewport's size; touches and text go in
 * through Input.*.
 *
 * Its pictures: Chromium runs on its Wayland backend (--ozone-platform=wayland,
 * --kiosk: one full-screen window, no browser UI) against chromium-wl
 * (sink/wl.c), our own minimal compositor, started first and ended with it
 * (a Wayland client dies with its compositor). chromium-wl converts each
 * frame straight into mgu-render's frame file while shown (show(file),
 * hide()) and paces Chromium to at most fps frames a second (setFps). Until
 * 0.2.4 the pictures were headless Chromium's screencast: a JPEG encoded in
 * the browser process and decoded again for every picture.
 *
 * WebGL and WebGPU: ANGLE on Vulkan and WebGPU (Dawn) on Vulkan, both on
 * Chromium's SwiftShader (the CPU; env.js: the bundle has no GPU driver since
 * 0.1.1's ANV hung the unit's kernel). In the GPU mode (opts.gpu, by hand
 * only) ANGLE runs on the unit's own Mesa 19 GLES instead (env.js);
 * --enable-unsafe-webgpu for Chromium's
 * WebGPU allow-list. WebAssembly JSPI is on by default since Chromium 137
 * (the bundle: 156). probe() reports what a page actually gets (WebGL 2's
 * renderer, the WebGPU adapter, JSPI run for real).
 *
 * Runs as the tool's uid (mgu-uplink routes it, through proxy.js) in its own
 * group, never `video` (no access to /dev/dri), never root; --no-sandbox, since the
 * unit's kernel and our uid offer neither the setuid sandbox nor (known)
 * user namespaces. In a memory cgroup when there is one (server.js).
 *
 * chromium-wl starts as root and drops to nobody in Chromium's group: the
 * Wayland socket (env.WL_DIR) is that group's only, and the frame file is
 * nobody's (screen.js). In the GPU mode it also reads Chromium's GPU buffers
 * (wl_drm, PRIME) back through the unit's own EGL on the render node.
 *
 * Events: 'exit' (code, signal), 'log' (line), 'navigated' ({url, title}),
 * 'display' (chromium-wl's events: stats, error, ...).
 */
'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const env = require('./env.js');
const unpack = require('./unpack.js');

const CHROMIUM = path.join(env.BUNDLE, 'chromium');
const WL = path.join(env.BUNDLE, 'chromium-wl');
const NOBODY = 65534;
const FPS = 30;   /* chromium-wl's pace while shown, by default */

/* the window's size: the pictures' */
function picOf(opts) { return opts.pic || { w: opts.w, h: opts.h }; }

/* opts: { w, h, uid, gid, gpu (the GPU mode: env.js), game (game mode: below),
 * scale (the device scale factor, 1 down to 0.25: the layout stays w x h CSS pixels, the pictures are
 * smaller), pic ({ w, h }: the pictures' size at that scale), fps (at most,
 * while shown), proxy (port), cgroup (dir or null), url, extraArgs } */
function args(opts) {
    const pic = picOf(opts);
    const a = [
        '--ozone-platform=wayland', '--kiosk', '--no-sandbox', '--remote-debugging-pipe',
        '--user-data-dir=' + path.join(env.PROFILE, 'chromium'),
        '--window-size=' + pic.w + ',' + pic.h, '--force-device-scale-factor=1',
        /* nothing over the page: no "restore pages?" bubble after a kill, no
         * "unsupported command-line flag" bar (--no-sandbox) */
        '--hide-crash-restore-bubble', '--test-type',
    ].concat(opts.gpu ? [
        /* GPU mode: ANGLE on the unit's own Mesa 19 GLES (i965), through the
         * EGL shim (env.js, gpu/egl_shim.c); no video engines */
        '--use-gl=angle', '--use-angle=gles-egl',
        '--disable-accelerated-video-decode', '--disable-accelerated-video-encode',
        /* WebGPU on the same driver: Dawn's GLES backend over ANGLE, which
         * Linux leaves off without --use-webgpu-adapter=opengles. It offers
         * WebGPU's compatibility mode only, so every page gets that
         * (--force-webgpu-compat), even one asking for plain WebGPU. The
         * developer features tell the probe the backend. */
        '--use-webgpu-adapter=opengles', '--force-webgpu-compat', '--enable-webgpu-developer-features',
    ] : [
        /* ANGLE and Dawn on Vulkan: SwiftShader, the only driver (env.js) */
        '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
        '--disable-vulkan-surface',
    ], [
        '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
        /* WebGL on SwiftShader rather than off (and if the GPU mode fails) */
        '--enable-unsafe-swiftshader',
        '--enable-gpu-rasterization',
        /* the disk: a capped cache in the profile */
        '--disk-cache-size=' + (100 << 20), '--media-cache-size=' + (50 << 20),
        /* nothing the car doesn't need */
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update',
        '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter', '--disable-domain-reliability',
        '--password-store=basic', '--use-mock-keychain', '--mute-audio',
        '--js-flags=--max-old-space-size=768',
        /* Memory (the unit has ~5.6 GB, the HMI already swaps; switches checked
         * in Chromium 156's source): one page at a time, so no site isolation
         * (cross-site frames share the page's renderer; it guards a page from
         * another tab's Spectre-style reads), two renderers at most, no spare
         * renderer kept warm, no back-forward cache (a left page isn't kept
         * alive in memory), capped GPU tile and discardable caches. Not
         * --enable-low-end-device-mode: it switches V8 to optimize for size,
         * which slows games. */
        '--disable-site-isolation-trials', '--renderer-process-limit=2',
        '--disable-features=SpareRendererForSitePerProcess,BackForwardCache,Translate',
        '--force-gpu-mem-available-mb=256', '--force-gpu-mem-discardable-limit-mb=64',
    ]);
    /* Game mode (opts.game, by hand, never kept): Dawn skips WebGPU's
     * validation and robustness checks in the GPU process (on the car its
     * main thread, which turns WebGPU into GL, was the busiest thread in
     * vel.gg). For trusted pages only: a wrong command is no longer caught. */
    if (opts.game) a.push('--enable-dawn-features=skip_validation,disable_robustness');
    /* loopback (the probe's page) stays direct: Chromium's default */
    if (opts.proxy) a.push('--proxy-server=http://127.0.0.1:' + opts.proxy);
    return a.concat(opts.extraArgs || [], [opts.url || 'about:blank']);
}

class Browser extends EventEmitter {
    constructor(opts) {
        super();
        this.opts = opts;
        this.proc = null;
        this.seq = 0;
        this.pending = new Map();
        this.session = null;
        this.wl = null;   /* chromium-wl */
        this.winston = false;   /* chromium-wl is connected to Winston */
        this.inbuf = '';
        this.url = '';
        this.title = '';
    }

    running() { return !!this.proc; }

    start() {
        const o = this.opts;
        ['', 'chromium', 'config', 'cache', 'tmp'].forEach((d) => {
            const p = path.join(env.PROFILE, d);
            if (!fs.existsSync(p)) fs.mkdirSync(p, 0o700);
            if (o.uid !== undefined) fs.chownSync(p, o.uid, o.gid);
        });
        return this._display().then(() => this._chromium());
    }

    /* chromium-wl, until its socket is up */
    _display() {
        const o = this.opts;
        const pic = picOf(o);
        /* the socket's folder: chromium-wl (nobody) makes the socket, Chromium's group enters */
        unpack.mkdirp(path.dirname(env.WL_DIR), 0o755);
        if (!fs.existsSync(env.WL_DIR)) fs.mkdirSync(env.WL_DIR, 0o750);
        if (o.uid !== undefined) { fs.chownSync(env.WL_DIR, NOBODY, o.gid); fs.chmodSync(env.WL_DIR, 0o750); }
        const a = ['--dir', env.WL_DIR, '--socket', env.WL_SOCKET, '--size', pic.w + 'x' + pic.h, '--fps', String(o.fps || FPS)];
        if (o.uid !== undefined) a.push('--uid', String(NOBODY), '--gid', String(o.gid));
        if (o.gpu) a.push('--drm', '--device', env.RENDER_NODE, '--unit-lib', env.UNIT_LIB);
        /* connected now, used only when shown that way (showWinston) */
        if (fs.existsSync(env.WINSTON_SOCKET)) a.push('--winston', env.WINSTON_SOCKET);
        const w = spawn(WL, a, { env: env.wlEnv(!!o.gpu), stdio: ['pipe', 'pipe', 'pipe'] });
        this.wl = w;
        return new Promise((resolve, reject) => {
            let ready = false, rest = '';
            w.stdout.setEncoding('utf8');
            w.stdout.on('data', (d) => {
                rest += d;
                let i;
                while ((i = rest.indexOf('\n')) >= 0) {
                    const l = rest.slice(0, i);
                    rest = rest.slice(i + 1);
                    let e;
                    try { e = JSON.parse(l); } catch (x) { this.emit('log', 'chromium-wl: ' + l); continue; }
                    if (e.ev === 'ready' && !ready) { ready = true; this.winston = !!e.winston; resolve(e); }
                    if (e.ev === 'winston-lost') this.winston = false;
                    this.emit('display', e);
                }
            });
            w.stderr.setEncoding('utf8');
            w.stderr.on('data', (d) => String(d).split('\n').filter((l) => l.trim()).forEach((l) => this.emit('log', 'chromium-wl: ' + l)));
            w.stdin.on('error', () => { /* it exited: 'exit' says so */ });
            w.on('error', (e) => { if (!ready) { ready = true; reject(e); } });
            w.on('exit', (code, sig) => {
                if (this.wl === w) this.wl = null;
                if (!ready) { ready = true; reject(new Error('chromium-wl exited (' + (sig || code) + ')')); return; }
                this.emit('log', 'chromium-wl: exited (' + (sig || code) + ')');
                /* Chromium can't draw without it */
                if (this.proc) { try { this.proc.kill('SIGKILL'); } catch (e) { /* gone */ } }
            });
        });
    }

    /* A line for chromium-wl (show FILE, hide, fps N, size WxH). */
    _wl(line) {
        if (this.wl) this.wl.stdin.write(line + '\n');
    }

    _chromium() {
        const o = this.opts;
        const a = args(o);
        /* into the memory cgroup first, then exec: every Chromium process stays in it */
        const cg = o.cgroup ? 'echo $$ > ' + o.cgroup + '/cgroup.procs 2>/dev/null; ' : '';
        /* LD_LIBRARY_PATH only on chromium's exec: the shell is the unit's (glibc 2.27) */
        const e = env.chromiumEnv(!!o.gpu);
        const libs = e.LD_LIBRARY_PATH;
        delete e.LD_LIBRARY_PATH;
        const spawnOpts = { env: e, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'], cwd: env.PROFILE };
        if (o.uid !== undefined) { spawnOpts.uid = o.uid; spawnOpts.gid = o.gid; }
        this.proc = spawn('/bin/sh', ['-c', cg + 'LD_LIBRARY_PATH=' + libs + ' exec "$0" "$@"', CHROMIUM].concat(a), spawnOpts);
        const p = this.proc;
        const lines = (stream) => {
            let rest = '';
            stream.setEncoding('utf8');
            stream.on('data', (d) => {
                rest += d;
                let i;
                while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i); rest = rest.slice(i + 1); if (l.trim()) this.emit('log', l); }
                if (rest.length > 8192) { this.emit('log', rest); rest = ''; }
            });
        };
        lines(p.stdout);
        lines(p.stderr);
        p.stdio[4].setEncoding('utf8');
        p.stdio[4].on('data', (d) => this._read(d));
        p.stdio[3].on('error', () => { /* gone */ });
        p.on('exit', (code, sig) => {
            this.proc = null;
            this.session = null;
            /* its display goes with it */
            if (this.wl) { try { this.wl.stdin.end(); } catch (e) { /* gone */ } }
            this.pending.forEach((cb) => cb.reject(new Error('chromium exited')));
            this.pending.clear();
            this.emit('exit', code, sig);
        });
        return this._attach();
    }

    _read(d) {
        this.inbuf += d;
        let i;
        while ((i = this.inbuf.indexOf('\0')) >= 0) {
            const raw = this.inbuf.slice(0, i);
            this.inbuf = this.inbuf.slice(i + 1);
            let m;
            try { m = JSON.parse(raw); } catch (e) { continue; }
            if (m.id !== undefined && this.pending.has(m.id)) {
                const cb = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (m.error) cb.reject(new Error(m.error.message + (m.error.data ? ': ' + m.error.data : '')));
                else cb.resolve(m.result);
            } else if (m.method) {
                this._event(m);
            }
        }
    }

    /* A DevTools command: on the page's session unless sessionId is null. */
    send(method, params, sessionId) {
        if (!this.proc) return Promise.reject(new Error('chromium is not running'));
        const id = ++this.seq;
        const msg = { id: id, method: method, params: params || {} };
        const sid = sessionId === undefined ? this.session : sessionId;
        if (sid) msg.sessionId = sid;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: resolve, reject: reject });
            this.proc.stdio[3].write(JSON.stringify(msg) + '\0');
        });
    }

    _event(m) {
        if (m.method === 'Page.frameNavigated' && m.sessionId === this.session && !m.params.frame.parentId) {
            this.url = m.params.frame.url;
            this.refreshTitle(true);
        } else if (m.method === 'Page.loadEventFired' && m.sessionId === this.session) {
            this.refreshTitle(true);
        } else if (m.method === 'Target.targetCrashed') {
            this.emit('log', 'page crashed: ' + JSON.stringify(m.params));
        }
    }

    /* The page's title (scripts change it without a navigation: server.js
     * calls this every few seconds); 'navigated' on a change, or always. */
    refreshTitle(always) {
        if (!this.session) return;
        this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
            .then((r) => {
                const t = String((r && r.result && r.result.value) || '');
                if (t === this.title && !always) return;
                this.title = t;
                this.emit('navigated', { url: this.url, title: this.title });
            })
            .catch(() => { /* navigating */ });
    }

    /* The first page target, attached (flat sessions), sized and touch-enabled. */
    _attach() {
        const tryOnce = (left) => this.send('Target.getTargets', {}, null).then((r) => {
            const page = (r.targetInfos || []).filter((t) => t.type === 'page')[0];
            if (!page) {
                if (!left) throw new Error('no page target');
                return new Promise((res) => setTimeout(res, 200)).then(() => tryOnce(left - 1));
            }
            return this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, null);
        });
        return tryOnce(50).then((r) => {
            this.session = r.sessionId;
            return Promise.all([
                this.send('Page.enable'),
                this.send('Runtime.enable'),
                this._metrics(),
                this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }),
            ]);
        });
    }

    navigate(url) { return this.send('Page.navigate', { url: url }); }
    reload() { return this.send('Page.reload', {}); }
    history(delta) {
        return this.send('Page.getNavigationHistory').then((h) => {
            const e = h.entries[h.currentIndex + delta];
            return e ? this.send('Page.navigateToHistoryEntry', { entryId: e.id }) : null;
        });
    }

    /* the page's size in CSS pixels, drawn at the scale: the page sees it as
     * devicePixelRatio, and the view is scaled by it into the window (in a
     * window, unlike headless, deviceScaleFactor alone doesn't draw smaller) */
    _metrics() {
        const s = this.opts.scale || 1;
        return this.send('Emulation.setDeviceMetricsOverride', { width: this.opts.w, height: this.opts.h, deviceScaleFactor: s, scale: s, mobile: false });
    }

    /* the resolution, live: touches keep their CSS coordinates; the window
     * takes the pictures' size (a new frame file of that size, when shown,
     * resizes it too: server.js re-shows) */
    setScale(scale, pic) {
        this.opts.scale = scale;
        this.opts.pic = pic;
        this._wl('size ' + pic.w + 'x' + pic.h);
        return this.session ? this._metrics() : Promise.resolve();
    }

    /* Pictures into the frame file (made by screen.js, nobody's) from now on;
     * its size is the window's. */
    show(file) { this._wl('show ' + file); }
    /* Pictures straight onto the centre screen through Winston, fitted into
     * view { x, y, w, h } (chromium-wl's own connection: this.winston). */
    showWinston(view) { this._wl('winston ' + [view.x, view.y, view.w, view.h].join(',')); }
    hide() { this._wl('hide'); }

    /* At most fps pictures a second while shown (chromium-wl answers
     * Chromium's frame callbacks no faster: requestAnimationFrame follows). */
    setFps(fps) {
        this.opts.fps = fps;
        this._wl('fps ' + fps);
    }

    /* phase 1 down, 2 move, 3 up; x, y in the page's CSS pixels (VIEW's
     * size), which the window has scaled by the scale (_metrics) */
    touch(phase, x, y) {
        const type = phase === 1 ? 'touchStart' : phase === 2 ? 'touchMove' : 'touchEnd';
        const s = this.opts.scale || 1;
        return this.send('Input.dispatchTouchEvent', { type: type, touchPoints: phase === 3 ? [] : [{ x: x * s, y: y * s, id: 1 }] });
    }

    text(s) { return this.send('Input.insertText', { text: String(s) }); }

    key(name) {
        const K = { Enter: [13, '\r'], Backspace: [8, ''], Tab: [9, '\t'], Escape: [27, ''], ArrowUp: [38, ''], ArrowDown: [40, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''] };
        const k = K[name];
        if (!k) return Promise.reject(new Error('no key ' + name));
        const base = { key: name, code: name, windowsVirtualKeyCode: k[0], nativeVirtualKeyCode: k[0] };
        return this.send('Input.dispatchKeyEvent', Object.assign({ type: k[1] ? 'keyDown' : 'rawKeyDown', text: k[1] || undefined }, base))
            .then(() => this.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base)));
    }

    /* What a page gets: in a tab of its own at url (a secure context, e.g.
     * http://127.0.0.1/: about:blank has no navigator.gpu), closed after. */
    probe(url) {
        let target = null, sid = null;
        return this.send('Target.createTarget', { url: url || 'about:blank' }, null)
            .then((t) => { target = t.targetId; return this.send('Target.attachToTarget', { targetId: target, flatten: true }, null); })
            .then((a) => { sid = a.sessionId; return this._loaded(sid, url || 'about:blank', 50); })
            .then(() => this.send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true, timeout: 30000 }, sid))
            .then((r) => {
                if (r.exceptionDetails) throw new Error('probe: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
                return r.result.value;
            })
            .then((v) => this._gpuPage(sid).then((g) => { v.gpuPage = g; return v; }, () => v))
            .then((v) => this.send('Target.closeTarget', { targetId: target }, null).then(() => v, () => v),
                (e) => (target ? this.send('Target.closeTarget', { targetId: target }, null).catch(() => null) : Promise.resolve()).then(() => { throw e; }));
    }

    /* Until the tab shows url, loaded (a new tab starts on its own about:blank
     * first, where a script would run instead). */
    _loaded(sid, url, left) {
        return this.send('Runtime.evaluate', { expression: 'location.href + " " + document.readyState', returnByValue: true }, sid)
            .then((r) => String(r && r.result && r.result.value), () => '')
            .then((s) => {
                if (s === url + ' complete' || s.indexOf(url) === 0 && / complete$/.test(s)) return;
                if (!left) throw new Error('probe page never loaded (' + s + ')');
                return new Promise((res) => setTimeout(res, 100)).then(() => this._loaded(sid, url, left - 1));
            });
    }

    /* chrome://gpu as text: the feature status and the driver lines */
    _gpuPage(sid) {
        return this.send('Page.navigate', { url: 'chrome://gpu' }, sid)
            .then(() => new Promise((r) => setTimeout(r, 2500)))
            .then(() => this.send('Runtime.evaluate', {
                expression: '(function(){var a=document.querySelector("info-view");var r=a&&a.shadowRoot;return (r?r.textContent:document.body.innerText)||""})()',
                returnByValue: true,
            }, sid))
            .then((r) => String((r && r.result && r.result.value) || '').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').slice(0, 20000));
    }

    stop() {
        if (!this.proc) {
            if (this.wl) { try { this.wl.stdin.end(); } catch (e) { /* gone */ } }
            return;
        }
        const p = this.proc;
        this.send('Browser.close', {}, null).catch(() => { /* gone */ });
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 5000);
    }
}

/* Runs in a fresh about:blank tab. JSPI is run for real: a hand-made module
 * importing an async function through WebAssembly.Suspending and called
 * through WebAssembly.promising. */
const PROBE = `(async () => {
  const r = { ua: navigator.userAgent };
  try {
    const bytes = new Uint8Array([0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 2,7,1,1,109,1,102,0,0, 3,2,1,0, 7,5,1,1,103,0,1, 10,6,1,4,0,16,0,11]);
    if (typeof WebAssembly.Suspending !== 'function') r.jspi = 'no WebAssembly.Suspending';
    else {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { m: { f: new WebAssembly.Suspending(async () => { await null; return 42; }) } });
      r.jspi = (await WebAssembly.promising(inst.exports.g)()) === 42 ? 'ok' : 'wrong result';
    }
  } catch (e) { r.jspi = 'error: ' + e.message; }
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) r.webgl2 = 'none';
    else { const x = gl.getExtension('WEBGL_debug_renderer_info'); r.webgl2 = x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
  } catch (e) { r.webgl2 = 'error: ' + e.message; }
  /* twice at most: an adapter can go stale when the GPU process restarts
   * under it ("A valid external Instance reference no longer exists") */
  for (let attempt = 0; attempt < 2; attempt++) try {
    delete r.webgpu; delete r.webgpuCompute;
    if (!navigator.gpu) r.webgpu = 'no navigator.gpu';
    else {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) r.webgpu = 'no adapter';
      else {
        const i = a.info || {};
        r.webgpu = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / ') || 'an adapter';
        r.webgpuFallback = !!(i.isFallbackAdapter || a.isFallbackAdapter);
        /* the backend (with --enable-webgpu-developer-features) and core or
         * compatibility mode (the GPU mode forces compatibility) */
        if (i.backend) r.webgpuBackend = i.backend;
        r.webgpuCore = a.features.has('core-features-and-limits');
        const d = await a.requestDevice();
        const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const mod = d.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> o: array<u32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) i: vec3u) { o[i.x] = i.x * 7u; }' });
        const pipe = d.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        const bg = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
        const rd = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const enc = d.createCommandEncoder();
        const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(1); pass.end();
        enc.copyBufferToBuffer(buf, 0, rd, 0, 16);
        d.queue.submit([enc.finish()]);
        await rd.mapAsync(GPUMapMode.READ);
        r.webgpuCompute = Array.from(new Uint32Array(rd.getMappedRange())).join(',') === '0,7,14,21' ? 'ok' : 'wrong result';
        d.destroy();
      }
    }
    break;
  } catch (e) {
    r.webgpu = (r.webgpu ? r.webgpu + '; ' : '') + 'error: ' + e.message;
    if (attempt === 0 && /Instance reference|lost|destroyed/i.test(e.message)) await new Promise((ok) => setTimeout(ok, 1000));
    else break;
  }
  return r;
})()`;

module.exports = { Browser, args, PROBE };
