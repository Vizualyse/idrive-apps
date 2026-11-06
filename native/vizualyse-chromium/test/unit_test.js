// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The bundle on the head unit's own root filesystem (run_unit_test.sh starts
 * this in a container made from it: glibc 2.27, Mesa 19, Node 8.16.2, the
 * loader in /lib), with Chromium's SwiftShader for Vulkan (as on the car:
 * no GPU driver in the bundle since 0.1.2):
 *
 * - unpack.js unpacks build/chromium.tgz at /var/opt/vizualyse-chromium/chromium,
 *   and a second ensure() leaves it be;
 * - Chromium starts as uid 12997 / gid 12997 (not video: no GPU), headless, over the pipe;
 * - probe(): JSPI runs, WebGL 2 has a renderer, WebGPU has an adapter and a
 *   compute shader gives the right numbers; chrome://gpu is read;
 * - a page is screencast through chromium-sink into a frame file: frames
 *   arrive, and the picture is the page's (a red half, a blue half);
 * - a touch replayed from a capture taps a button on the page.
 *
 *   node unit_test.js <tool folder>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const T = process.argv[2] || '/t';
const env = require(path.join(T, 'src/env.js'));
const unpack = require(path.join(T, 'src/unpack.js'));
const { Browser } = require(path.join(T, 'src/browser.js'));

const W = 640, H = 240;
const FRAME = '/dev/shm/mgu-video-test';
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const log = (s) => console.log('     ' + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function frameFile(file, w, h) {
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    const fd = fs.openSync(file, 'w', 0o644);
    fs.ftruncateSync(fd, 64 + 3 * w * h * 3 / 2);
    const b = Buffer.alloc(64);
    [0x4656474d, 1, w, h, 0, 0, 3, 0, 0].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    fs.writeSync(fd, b, 0, 64, 0);
    fs.closeSync(fd);
}

/* The page: left half red, right half blue, a button in the middle that turns
 * the title "tapped". */
const PAGE = '<!doctype html><title>start</title><style>body{margin:0}#l,#r{position:fixed;top:0;bottom:0;width:50%}#l{left:0;background:#f00}#r{right:0;background:#00f}' +
    'button{position:fixed;left:270px;top:90px;width:100px;height:60px}</style><div id=l></div><div id=r></div>' +
    '<button onclick="document.title=\'tapped\'">tap</button>';

/* A touch capture for the sink: down / up at screen x, y (the PDU layout of touch.c). */
function touchCapture(file, x, y) {
    const pdu = (ev) => {
        const b = Buffer.alloc(112);
        b.writeUInt32BE(0xB0048002, 0); b.writeUInt32BE(96, 4);
        b[28] = 0x80; b[53] = 1; b.writeUInt16BE(x, 54); b.writeUInt16BE(y, 60); b[62] = 50; b[63] = ev << 4;
        return b.toString('hex');
    };
    fs.writeFileSync(file + '.tmp', ['0 160.48.199.115 112 ' + pdu(1), '40 160.48.199.115 112 ' + pdu(3)].join('\n') + '\n');
    fs.chownSync(file + '.tmp', 65534, 65534);   /* the sink (nobody by then) deletes it after one replay */
    fs.renameSync(file + '.tmp', file);
}

function i420At(buf, w, h, x, y) {
    const Y = buf[y * w + x], U = buf[w * h + (y >> 1) * (w >> 1) + (x >> 1)], V = buf[w * h + (w * h >> 2) + (y >> 1) * (w >> 1) + (x >> 1)];
    return { Y, U, V };
}

async function main() {
    const archive = path.join(T, 'build/chromium.tgz');
    const r1 = await new Promise((res, rej) => unpack.ensure(archive, log, (e, r) => (e ? rej(e) : res(r))));
    check(r1.unpacked && fs.existsSync(path.join(env.BUNDLE, 'chromium')), 'the bundle unpacks (' + r1.files + ' files)');
    const r2 = await new Promise((res, rej) => unpack.ensure(archive, log, (e, r) => (e ? rej(e) : res(r))));
    check(!r2.unpacked, 'a second ensure() leaves it');
    check((fs.statSync(path.join(env.BUNDLE, 'chromium')).mode & 0o111) !== 0, 'chromium is executable');

    const server = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(PAGE); }).listen(8999, '127.0.0.1');
    fs.mkdirSync(env.PROFILE, 0o700);
    const b = new Browser({ w: W, h: H, uid: 12997, gid: 12997 });
    const chromeLog = [];
    b.on('log', (l) => chromeLog.push(l));
    b.on('exit', (c, s) => { log('chromium exited ' + (s || c)); console.log(chromeLog.slice(-40).join('\n')); });
    const t0 = Date.now();
    try {
        await b.start();
    } catch (e) {
        check(false, 'chromium starts: ' + e.message);
        console.log(chromeLog.slice(-40).join('\n'));
        throw e;
    }
    check(true, 'chromium starts and attaches (' + (Date.now() - t0) + ' ms)');

    const p = await b.probe('http://127.0.0.1:8999/blank');
    log(JSON.stringify(Object.assign({}, p, { gpuPage: undefined })));
    check(p.jspi === 'ok', 'JSPI runs (' + p.jspi + ')');
    check(/SwiftShader|Vulkan/i.test(String(p.webgl2)), 'WebGL 2 on ANGLE/Vulkan (' + p.webgl2 + ')');
    check(p.webgpu && !/^no |error/.test(p.webgpu), 'WebGPU has an adapter (' + p.webgpu + ')');
    check(p.webgpuCompute === 'ok', 'a WebGPU compute shader gives the right numbers (' + p.webgpuCompute + ')');
    const gpuLines = String(p.gpuPage || '').split('\n').filter((l) => /WebGPU|WebGL|Vulkan|ANGLE|GL_RENDERER|Rasterization/i.test(l)).slice(0, 25);
    gpuLines.forEach((l) => log('chrome://gpu: ' + l.trim().slice(0, 160)));
    if (process.env.GPU_PAGE) fs.writeFileSync('/out/gpu.txt', p.gpuPage);
    check(gpuLines.length > 0, 'chrome://gpu is read');

    /* the screencast through the sink */
    frameFile(FRAME, W, H);
    const touchFile = '/dev/shm/touch.txt';
    const sink = spawn(path.join(env.BUNDLE, 'chromium-sink'), ['--frame', FRAME, '--touch-file', touchFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    const events = [];
    let rest = '';
    sink.stdout.setEncoding('utf8');
    sink.stdout.on('data', (d) => { rest += d; let i; while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i); rest = rest.slice(i + 1); try { events.push(JSON.parse(l)); } catch (e) { log('sink: ' + l); } } });
    b.on('frame', (jpeg, meta, ack) => {
        const h = Buffer.alloc(4);
        h.writeUInt32LE(jpeg.length, 0);
        sink.stdin.write(h);
        sink.stdin.write(jpeg, ack);
    });
    /* touches into the page, as server.js does (screen = viewport here) */
    const touches = [];
    const taps = [];
    const feed = setInterval(() => {
        events.splice(0).forEach((e) => {
            if (e.ev === 'touch') { touches.push(e); taps.push(b.touch(e.p, e.x, e.y).catch((x) => log('touch: ' + x.message))); }
            else if (e.ev !== 'stats') log('sink: ' + JSON.stringify(e));
            else log('sink stats: ' + JSON.stringify(e));
        });
    }, 20);
    await b.navigate('http://127.0.0.1:8999/');
    await wait(1500);
    await b.screencast(true, 80);
    await wait(2500);
    const buf = fs.readFileSync(FRAME);
    const seq = buf.readUInt32LE(16), slot = buf.readUInt32LE(20);
    check(seq > 0, 'frames reach the frame file (seq ' + seq + ')');
    check(buf.readUInt32LE(32) === 1, 'the frame file says full range');
    const pic = buf.slice(64 + slot * W * H * 3 / 2, 64 + (slot + 1) * W * H * 3 / 2);
    const left = i420At(pic, W, H, 40, 30), right = i420At(pic, W, H, 600, 210);
    log('left ' + JSON.stringify(left) + ', right ' + JSON.stringify(right));
    /* red: V high, U low; blue: U high */
    check(left.V > 200 && left.U < 120, 'the left half is red');
    check(right.U > 200 && right.V < 140, 'the right half is blue');

    touchCapture(touchFile, 320, 120);
    await wait(1500);
    await Promise.all(taps);
    const title = await b.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    check(touches.length >= 2, 'the sink reads the touches (' + touches.map((t) => t.p).join(',') + ')');
    check(title.result.value === 'tapped', 'a tap presses the page\'s button (title ' + title.result.value + ')');

    clearInterval(feed);
    await b.screencast(false);
    sink.stdin.end();
    b.stop();
    server.close();
    await wait(1500);
    if (fails) console.log(chromeLog.slice(-30).join('\n'));
    console.log(fails ? fails + ' FAILED' : 'all ok');
    process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
