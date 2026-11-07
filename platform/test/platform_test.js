#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * The platform's mechanics (platform/platform.js): a pin's copies are
 * written byte for byte with a .gitignore block that lists them, beside what
 * a folder's .gitignore already said; modules compose, each at its own
 * version; a copy the pin drops goes, and so does the block when nothing is
 * left; a block written before the modules is still found; a malformed pin,
 * an unsafe path, a file two modules copy or a missing module or version is
 * refused; the packer (release/tool_artifact.js) ships the pinned versions'
 * bytes and dates nothing itself; release.js counts the platform files a
 * component copies as shipped; and this repository's pins pass `check`,
 * every copy equal to its original.
 *
 *   node platform/test/platform_test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const platform = require('../platform.js');
const { buildArtifact } = require('../../release/tool_artifact.js');

const REPO = path.join(__dirname, '..', '..');

function untgz(file) {
    const tar = zlib.gunzipSync(fs.readFileSync(file));
    const out = {};
    for (let off = 0; off + 512 <= tar.length;) {
        const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
        if (!name) {
            break;
        }
        const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8);
        out[name] = tar.slice(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

/* A repo with modules tool/sound (1.0.0, 1.1.0) and native/frame (1.0.0,
 * 1.0.1) and one tool pinning `pin`. */
function fixture(pin) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-platform-test-'));
    const put = (rel, data) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), data);
    };
    put('platform/tool/sound/1.0.0/sound.py', 'print("one")\n');
    put('platform/tool/sound/1.1.0/sound.py', 'print("two")\n');
    put('platform/native/frame/1.0.0/frame.c', 'int frame;\n');
    put('platform/native/frame/1.0.1/frame.c', 'int frame = 1;\n');
    put('native/fix-tool/src/server.js', 'console.log("hi");\n');
    put('native/fix-tool/component.json', JSON.stringify({
        id: 'fix-tool', kind: 'tool', version: '0.1.0', platform: pin,
        files: [{ path: 'server.js', from: 'src/server.js', mode: '0644' },
            { path: 'sound.py', from: 'src/sound.py', mode: '0644' }]
    }, null, 2));
    return { root, dir: path.join(root, 'native', 'fix-tool') };
}

/* A pin entry: a module version and the files it copies, { dest: src }. */
function mod(version, files) {
    return { version, files };
}
const SOUND = (v) => ({ 'tool/sound': mod(v, { 'src/sound.py': 'sound.py' }) });
const FRAME = (v) => ({ 'native/frame': mod(v, { 'core/frame.c': 'frame.c' }) });

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('sync writes the pinned copies and a .gitignore block listing them', () => {
    const { dir } = fixture(Object.assign(SOUND('1.0.0'), FRAME('1.0.0')));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', '.gitignore'), '# ours\n/scratch/\n');
    assert.deepStrictEqual(platform.sync(dir), ['core/frame.c', 'src/sound.py']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'sound.py'), 'utf8'), 'print("one")\n');
    const ignore = fs.readFileSync(path.join(dir, 'src', '.gitignore'), 'utf8');
    assert.ok(ignore.startsWith('# ours\n/scratch/\n'), 'what the .gitignore said stays');
    assert.deepStrictEqual(platform.parseIgnore(ignore).names, ['sound.py']);
    assert.deepStrictEqual(platform.parseIgnore(fs.readFileSync(path.join(dir, 'core', '.gitignore'), 'utf8')).names, ['frame.c']);
    // again: the same bytes everywhere
    const before = fs.readFileSync(path.join(dir, 'src', '.gitignore'), 'utf8');
    platform.sync(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', '.gitignore'), 'utf8'), before);
});

test('modules compose: each copy comes from its own module version', () => {
    const { dir } = fixture(Object.assign(SOUND('1.0.0'), FRAME('1.0.1')));
    platform.sync(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'sound.py'), 'utf8'), 'print("one")\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'core', 'frame.c'), 'utf8'), 'int frame = 1;\n');
});

test('a block written before the modules is still found, and rewritten', () => {
    const { dir } = fixture(SOUND('1.0.0'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', '.gitignore'),
        '# platform: copies of platform/<version>/ files, pinned in this component\'s\n' +
        '# component.json or release.json; written by `node platform/platform.js sync`.\n' +
        '# Edit the originals in platform/, never these.\n/old.py\n/sound.py\n# end platform\n');
    fs.writeFileSync(path.join(dir, 'src', 'old.py'), 'old\n');
    platform.sync(dir);
    const text = fs.readFileSync(path.join(dir, 'src', '.gitignore'), 'utf8');
    assert.strictEqual(text.split('# end platform').length, 2, 'one block');
    assert.deepStrictEqual(platform.parseIgnore(text).names, ['sound.py']);
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'old.py')), 'a copy it no longer lists goes');
});

test('a .gitignore checked out with CRLF (Windows) keeps one block', () => {
    const { dir } = fixture(SOUND('1.0.0'));
    platform.sync(dir);
    const file = path.join(dir, 'src', '.gitignore');
    const crlf = fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(file, crlf);
    platform.sync(dir);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), crlf, 'left as it was');
    assert.strictEqual(crlf.split('# end platform').length, 2, 'one block');
});

test('a new pin brings the new version; a dropped module\'s copy and its block go', () => {
    const { dir } = fixture(Object.assign(SOUND('1.0.0'), FRAME('1.0.0')));
    platform.sync(dir);
    const file = path.join(dir, 'component.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.platform = SOUND('1.1.0');
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
    assert.deepStrictEqual(platform.sync(dir), ['src/sound.py']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'sound.py'), 'utf8'), 'print("two")\n');
    assert.ok(!fs.existsSync(path.join(dir, 'core', 'frame.c')), 'the dropped copy is gone');
    assert.ok(!fs.existsSync(path.join(dir, 'core', '.gitignore')), 'and its block, which was all the file held');
});

test('a malformed pin, an unsafe path, a shared copy or a missing module or version is refused', () => {
    [{},
        { version: '1.0.0', files: { 'src/a.py': 'tool/sound.py' } },
        { 'tool/sound': mod('1.0', { 'src/a.py': 'sound.py' }) },
        { 'tool/sound': mod('1.0.0', {}) },
        { 'tool/Sound': mod('1.0.0', { 'src/a.py': 'sound.py' }) },
        { 'other/sound': mod('1.0.0', { 'src/a.py': 'sound.py' }) },
        { 'tool/../sound': mod('1.0.0', { 'src/a.py': 'sound.py' }) },
        { 'tool/sound': mod('1.0.0', { '../a.py': 'sound.py' }) },
        { 'tool/sound': mod('1.0.0', { 'src/a.py': '../../../etc/passwd' }) },
        { 'tool/sound': mod('1.0.0', { 'src/.gitignore': 'sound.py' }) },
        { 'tool/sound': mod('1.0.0', { 'src/a.c': 'sound.py' }), 'native/frame': mod('1.0.0', { 'src/a.c': 'frame.c' }) }
    ].forEach((pin) => {
        const { dir } = fixture(pin);
        assert.throws(() => platform.sync(dir), /platform/, JSON.stringify(pin));
    });
    const { dir } = fixture(SOUND('9.9.9'));
    assert.throws(() => platform.sync(dir), /tool\/sound 9\.9\.9 does not exist \(have: 1\.0\.0, 1\.1\.0\)/);
    const nomod = fixture({ 'tool/nothing': mod('1.0.0', { 'src/x.py': 'x.py' }) });
    assert.throws(() => platform.sync(nomod.dir), /module tool\/nothing does not exist/);
    const missing = fixture({ 'tool/sound': mod('1.0.0', { 'src/x.py': 'nothing.py' }) });
    assert.throws(() => platform.sync(missing.dir), /has no tool\/sound\/1\.0\.0\/nothing\.py/);
});

test('modules and their versions are found, oldest first', () => {
    const { root } = fixture(SOUND('1.0.0'));
    const p = path.join(root, 'platform');
    assert.deepStrictEqual(platform.modules(p), ['tool/sound', 'native/frame']);
    assert.deepStrictEqual(platform.versions('native/frame', p), ['1.0.0', '1.0.1']);
    assert.deepStrictEqual(platform.versions('native/none', p), []);
    assert.deepStrictEqual(platform.versions('../x', p), []);
});

test('the packer ships the pinned version, and release.js counts it as shipped', () => {
    const { root, dir } = fixture(SOUND('1.1.0'));
    const files = untgz(buildArtifact(dir, path.join(root, 'out')));
    assert.strictEqual(String(files['files/sound.py']), 'print("two")\n');
    assert.strictEqual(files['component.json'].toString().indexOf('"platform"'), -1, 'the pin is not shipped');
    assert.deepStrictEqual(platform.shippedPaths(root, 'native/fix-tool'), ['platform/tool/sound/1.1.0/sound.py']);
});

test('this repository: every pin checks, every copy is its original', () => {
    platform.componentDirs().forEach((rel) => platform.sync(path.join(REPO, rel)));
    assert.deepStrictEqual(platform.check(null), []);
    const pinned = platform.componentDirs().filter((rel) => platform.pinOf(path.join(REPO, rel)));
    assert.ok(pinned.length >= 8, `pinned: ${pinned.join(', ')}`);
    assert.ok(platform.modules().length >= 8, `modules: ${platform.modules().join(', ')}`);
});

let failed = 0;
tests.forEach((t) => {
    try {
        t.fn();
        console.log(`ok   ${t.name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${t.name}\n     ${e.stack}`);
    }
});
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
