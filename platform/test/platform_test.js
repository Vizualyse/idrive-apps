#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * The platform's mechanics (platform/platform.js): a pin's copies are
 * written byte for byte with a .gitignore block that lists them, beside what
 * a folder's .gitignore already said; a copy the pin drops goes, and so does
 * the block when nothing is left; a malformed pin, an unsafe path or a
 * missing version is refused; the packer (release/tool_artifact.js) ships
 * the pinned version's bytes and dates nothing itself; release.js counts the
 * platform files a component copies as shipped; and this repository's pins
 * pass `check`, every copy equal to its original.
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

/* A repo with platform 1.0.0 and 1.1.0 and one tool pinning `pin`. */
function fixture(pin) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vz-platform-test-'));
    const put = (rel, data) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), data);
    };
    put('platform/1.0.0/tool/sound.py', 'print("one")\n');
    put('platform/1.0.0/native/frame.c', 'int frame;\n');
    put('platform/1.1.0/tool/sound.py', 'print("two")\n');
    put('platform/1.1.0/native/frame.c', 'int frame;\n');
    put('native/fix-tool/src/server.js', 'console.log("hi");\n');
    put('native/fix-tool/component.json', JSON.stringify({
        id: 'fix-tool', kind: 'tool', version: '0.1.0', platform: pin,
        files: [{ path: 'server.js', from: 'src/server.js', mode: '0644' },
            { path: 'sound.py', from: 'src/sound.py', mode: '0644' }]
    }, null, 2));
    return { root, dir: path.join(root, 'native', 'fix-tool') };
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('sync writes the pinned copies and a .gitignore block listing them', () => {
    const { dir } = fixture({ version: '1.0.0', files: { 'src/sound.py': 'tool/sound.py', 'core/frame.c': 'native/frame.c' } });
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

test('a new pin brings the new version; a dropped copy and its block go', () => {
    const { dir } = fixture({ version: '1.0.0', files: { 'src/sound.py': 'tool/sound.py', 'core/frame.c': 'native/frame.c' } });
    platform.sync(dir);
    const file = path.join(dir, 'component.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.platform = { version: '1.1.0', files: { 'src/sound.py': 'tool/sound.py' } };
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
    assert.deepStrictEqual(platform.sync(dir), ['src/sound.py']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'sound.py'), 'utf8'), 'print("two")\n');
    assert.ok(!fs.existsSync(path.join(dir, 'core', 'frame.c')), 'the dropped copy is gone');
    assert.ok(!fs.existsSync(path.join(dir, 'core', '.gitignore')), 'and its block, which was all the file held');
});

test('a malformed pin, an unsafe path or a missing version is refused', () => {
    [{ version: '1.0', files: { 'src/a.py': 'tool/sound.py' } },
        { version: '1.0.0', files: {} },
        { version: '1.0.0', files: { '../a.py': 'tool/sound.py' } },
        { version: '1.0.0', files: { 'src/a.py': '../../etc/passwd' } },
        { version: '1.0.0', files: { 'src/.gitignore': 'tool/sound.py' } }
    ].forEach((pin) => {
        const { dir } = fixture(pin);
        assert.throws(() => platform.sync(dir), /platform/, JSON.stringify(pin));
    });
    const { dir } = fixture({ version: '9.9.9', files: { 'src/sound.py': 'tool/sound.py' } });
    assert.throws(() => platform.sync(dir), /9\.9\.9 does not exist/);
    const missing = fixture({ version: '1.0.0', files: { 'src/x.py': 'tool/nothing.py' } });
    assert.throws(() => platform.sync(missing.dir), /has no tool\/nothing\.py/);
});

test('the packer ships the pinned version, and release.js counts it as shipped', () => {
    const { root, dir } = fixture({ version: '1.1.0', files: { 'src/sound.py': 'tool/sound.py' } });
    const files = untgz(buildArtifact(dir, path.join(root, 'out')));
    assert.strictEqual(String(files['files/sound.py']), 'print("two")\n');
    assert.strictEqual(files['component.json'].toString().indexOf('"platform"'), -1, 'the pin is not shipped');
    assert.deepStrictEqual(platform.shippedPaths(root, 'native/fix-tool'), ['platform/1.1.0/tool/sound.py']);
});

test('this repository: every pin checks, every copy is its original', () => {
    platform.componentDirs().forEach((rel) => platform.sync(path.join(REPO, rel)));
    assert.deepStrictEqual(platform.check(null), []);
    const pinned = platform.componentDirs().filter((rel) => platform.pinOf(path.join(REPO, rel)));
    assert.ok(pinned.length >= 8, `pinned: ${pinned.join(', ')}`);
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
