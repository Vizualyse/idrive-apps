// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Chromium, headless, driven over the DevTools protocol on a pipe
 * (--remote-debugging-pipe: we write NUL-terminated JSON on its fd 3, read
 * its fd 4). One page (tab) at the viewport's size; its pictures come as
 * screencast JPEGs ('frame' events) while screencasting; touches and text go
 * in through Input.*.
 *
 * WebGL and WebGPU: ANGLE on Vulkan and WebGPU (Dawn) on Vulkan, both on
 * Chromium's SwiftShader (the CPU; env.js: the bundle has no GPU driver since
 * 0.1.1's ANV hung the unit's kernel); --enable-unsafe-webgpu for Chromium's
 * WebGPU allow-list. WebAssembly JSPI is on by default since Chromium 137
 * (the bundle: 156). probe() reports what a page actually gets (WebGL 2's
 * renderer, the WebGPU adapter, JSPI run for real).
 *
 * Runs as the tool's uid (mgu-uplink routes it, through proxy.js) in its own
 * group, never `video` (no access to /dev/dri), never root; --no-sandbox, since the
 * unit's kernel and our uid offer neither the setuid sandbox nor (known)
 * user namespaces. In a memory cgroup when there is one (server.js).
 *
 * Events: 'frame' (Buffer jpeg, metadata), 'exit' (code, signal), 'log'
 * (line), 'navigated' ({url, title}).
 */
'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const env = require('./env.js');

const CHROMIUM = path.join(env.BUNDLE, 'chromium');

/* opts: { w, h, uid, gid, proxy (port), cgroup (dir or null), url, extraArgs } */
function args(opts) {
    const a = [
        '--headless', '--no-sandbox', '--remote-debugging-pipe',
        '--user-data-dir=' + path.join(env.PROFILE, 'chromium'),
        '--window-size=' + opts.w + ',' + opts.h, '--force-device-scale-factor=1',
        /* ANGLE and Dawn on Vulkan: SwiftShader, the only driver (env.js) */
        '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
        '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-vulkan-surface',
        /* WebGL on SwiftShader rather than off */
        '--enable-unsafe-swiftshader',
        '--enable-gpu-rasterization',
        /* the disk: a capped cache in the profile */
        '--disk-cache-size=' + (100 << 20), '--media-cache-size=' + (50 << 20),
        /* nothing the car doesn't need */
        '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-component-update',
        '--disable-background-networking', '--disable-breakpad', '--disable-crash-reporter', '--disable-domain-reliability',
        '--password-store=basic', '--use-mock-keychain', '--mute-audio', '--renderer-process-limit=4',
        '--js-flags=--max-old-space-size=768',
    ];
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
        this.casting = false;
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
        const a = args(o);
        /* into the memory cgroup first, then exec: every Chromium process stays in it */
        const cg = o.cgroup ? 'echo $$ > ' + o.cgroup + '/cgroup.procs 2>/dev/null; ' : '';
        /* LD_LIBRARY_PATH only on chromium's exec: the shell is the unit's (glibc 2.27) */
        const e = env.chromiumEnv();
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
            this.casting = false;
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
        if (m.method === 'Page.screencastFrame' && m.sessionId === this.session) {
            const p = m.params;
            /* acked once the sink has it (server.js calls ack): Chromium sends the next only then */
            this.emit('frame', Buffer.from(p.data, 'base64'), p.metadata, () => {
                this.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => { /* gone */ });
            });
        } else if (m.method === 'Page.frameNavigated' && m.sessionId === this.session && !m.params.frame.parentId) {
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
                this.send('Emulation.setDeviceMetricsOverride', { width: this.opts.w, height: this.opts.h, deviceScaleFactor: 1, mobile: false }),
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

    screencast(on, quality) {
        if (on === this.casting || !this.session) return Promise.resolve();
        this.casting = on;
        return on ? this.send('Page.startScreencast', { format: 'jpeg', quality: quality || 75, maxWidth: this.opts.w, maxHeight: this.opts.h, everyNthFrame: 1 })
            : this.send('Page.stopScreencast');
    }

    /* phase 1 down, 2 move, 3 up; x, y in the viewport */
    touch(phase, x, y) {
        const type = phase === 1 ? 'touchStart' : phase === 2 ? 'touchMove' : 'touchEnd';
        return this.send('Input.dispatchTouchEvent', { type: type, touchPoints: phase === 3 ? [] : [{ x: x, y: y, id: 1 }] });
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
        if (!this.proc) return;
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
  try {
    if (!navigator.gpu) r.webgpu = 'no navigator.gpu';
    else {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!a) r.webgpu = 'no adapter';
      else {
        const i = a.info || {};
        r.webgpu = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / ') || 'an adapter';
        r.webgpuFallback = !!(i.isFallbackAdapter || a.isFallbackAdapter);
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
  } catch (e) { r.webgpu = (r.webgpu ? r.webgpu + '; ' : '') + 'error: ' + e.message; }
  return r;
})()`;

module.exports = { Browser, args, PROBE };
