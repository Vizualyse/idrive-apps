#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * The Vizualyse platform: code every tool and app shares, kept once in
 * platform/<x.y.z>/ and copied into each component that pins a version of it.
 * platform/README.md says how to use it.
 *
 *   node platform/platform.js list                     which component pins which version
 *   node platform/platform.js sync [<dir>...]          write each component's copies (all by default)
 *   node platform/platform.js check [--base <ref>]     pins, copies, and frozen versions unchanged since <ref>
 *   node platform/platform.js new <x.y.z>              a new version, copied from the newest
 *   node platform/platform.js use <x.y.z> [<id>...] [--no-bump]
 *                                                      pin a version (all components by default)
 *                                                      and bump each component whose artifact changes
 *
 * A component pins a version in its own file: a tool in native/<id>/
 * component.json, an app in apps/<id>/release.json (neither is shipped to
 * the unit as is):
 *
 *   "platform": {
 *     "version": "1.0.0",
 *     "files": { "src/pcm_play.py": "tool/pcm_play.py", ... }   where the copy goes: what it copies
 *   }
 *
 * The copies sit where the component's code and build already look for them,
 * so nothing else changes. They are never committed: sync keeps a block in
 * a .gitignore beside them that lists them. The packer (release/
 * tool_artifact.js) and each app's tools/build.js sync before they build, so
 * a release always carries exactly the pinned version.
 *
 * A version is frozen once a newer one exists: a fix is a new version
 * (`new`), then `use` moves the components onto it. `check --base` refuses a
 * change to a frozen version.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PLATFORM = __dirname;
const REPO = path.resolve(PLATFORM, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const BEGIN = '# platform: copies of platform/<version>/ files, pinned in this component\'s';
const BEGIN2 = '# component.json or release.json; written by `node platform/platform.js sync`.';
const BEGIN3 = '# Edit the originals in platform/, never these.';
const END = '# end platform';

function compare(a, b) {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) {
            return x[i] - y[i];
        }
    }
    return 0;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeRel(p) {
    return typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.includes('\\') &&
        !p.split('/').some((s) => s === '..' || s === '.' || s === '');
}

/* The versions under a platform folder, oldest first. */
function versions(platformDir = PLATFORM) {
    return fs.readdirSync(platformDir).filter((n) => SEMVER.test(n) &&
        fs.statSync(path.join(platformDir, n)).isDirectory()).sort(compare);
}

/* The file of a component folder that holds its pin: component.json for a
 * tool, release.json for an app; null for neither. */
function pinFile(dir) {
    const tool = path.join(dir, 'component.json');
    if (fs.existsSync(tool)) {
        return tool;
    }
    const app = path.join(dir, 'release.json');
    return fs.existsSync(app) ? app : null;
}

/* A component folder's pin, { version, files: [[dest, src]...], file }, or
 * null when it has none. A component folder is native/<id> or apps/<id>, so
 * its platform folder is ../../platform. Throws on a malformed pin. */
function pinOf(dir) {
    const file = pinFile(dir);
    if (!file) {
        return null;
    }
    const p = readJson(file).platform;
    if (p === undefined) {
        return null;
    }
    const where = path.relative(REPO, file) || file;
    if (!p || typeof p !== 'object' || !SEMVER.test(p.version || '') || !p.files || typeof p.files !== 'object' ||
        Array.isArray(p.files) || !Object.keys(p.files).length) {
        throw new Error(`${where}: "platform" needs a x.y.z "version" and "files" (copy path: platform path)`);
    }
    const files = Object.keys(p.files).map((dest) => [dest, p.files[dest]]);
    files.forEach(([dest, src]) => {
        if (!safeRel(dest) || !safeRel(src) || path.posix.basename(dest) === '.gitignore') {
            throw new Error(`${where}: bad platform file "${dest}": "${src}"`);
        }
    });
    return { version: p.version, files, file };
}

function platformOf(dir) {
    return path.join(dir, '..', '..', 'platform');
}

/* The managed block of a .gitignore's text: { names, before, after }. */
function parseIgnore(text) {
    const lines = text.split('\n');
    const b = lines.indexOf(BEGIN);
    const e = lines.indexOf(END);
    if (b < 0 || e < b) {
        return { names: [], before: text, after: '' };
    }
    return {
        names: lines.slice(b + 1, e).filter((l) => l.startsWith('/')).map((l) => l.slice(1)),
        before: lines.slice(0, b).join('\n'),
        after: lines.slice(e + 1).join('\n')
    };
}

function ignoreText(existing, names) {
    const cur = parseIgnore(existing);
    const block = names.length ? [BEGIN, BEGIN2, BEGIN3].concat(names.slice().sort().map((n) => `/${n}`), END).join('\n') + '\n' : '';
    const before = cur.before.replace(/\n*$/, '');
    const after = cur.after.replace(/^\n*/, '');
    return [before, block.replace(/\n$/, ''), after.replace(/\n*$/, '')].filter((s) => s).join('\n\n') + (before || block || after ? '\n' : '');
}

/* The .gitignore texts a pin needs, by folder (relative to the component),
 * from the folders' current texts. */
function ignoresFor(dir, pin) {
    const byDir = new Map();
    pin.files.forEach(([dest]) => {
        const d = path.posix.dirname(dest);
        byDir.set(d, (byDir.get(d) || []).concat(path.posix.basename(dest)));
    });
    return byDir;
}

/* Writes a component's copies from its pinned version and the .gitignore
 * blocks that list them; removes copies it wrote before that the pin no
 * longer names. Returns the copies written, or [] without a pin. */
function sync(dir) {
    dir = path.resolve(dir);
    const pin = pinOf(dir);
    const byDir = pin ? ignoresFor(dir, pin) : new Map();
    // folders whose block lists copies the pin dropped
    walkIgnores(dir).forEach((d) => {
        if (!byDir.has(d)) {
            byDir.set(d, []);
        }
    });
    if (!pin && !byDir.size) {
        return [];
    }
    const root = pin && path.join(platformOf(dir), pin.version);
    if (pin && !fs.existsSync(root)) {
        throw new Error(`${path.relative(REPO, pin.file)}: platform ${pin.version} does not exist (have: ${versions(platformOf(dir)).join(', ')})`);
    }
    const written = [];
    byDir.forEach((names, d) => {
        const folder = path.join(dir, d);
        const ignore = path.join(folder, '.gitignore');
        const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
        parseIgnore(existing).names.filter((n) => names.indexOf(n) < 0).forEach((n) => {
            fs.rmSync(path.join(folder, n), { force: true });
        });
        names.forEach((n) => {
            const dest = d === '.' ? n : `${d}/${n}`;
            const src = pin.files.find((f) => f[0] === dest)[1];
            const from = path.join(root, src);
            if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
                throw new Error(`${path.relative(REPO, pin.file)}: platform ${pin.version} has no ${src}`);
            }
            fs.mkdirSync(folder, { recursive: true });
            const to = path.join(folder, n);
            const data = fs.readFileSync(from);
            if (!fs.existsSync(to) || !fs.readFileSync(to).equals(data)) {
                fs.writeFileSync(to, data);
            }
            written.push(dest);
        });
        const text = ignoreText(existing, names);
        if (text !== existing) {
            if (text) {
                fs.writeFileSync(ignore, text);
            } else {
                fs.rmSync(ignore, { force: true });
            }
        }
    });
    return written.sort();
}

/* The folders (relative, posix) under a component holding a managed block. */
function walkIgnores(dir) {
    const out = [];
    const walk = (d, rel) => {
        fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
            if (e.isDirectory()) {
                if (e.name !== 'build' && e.name !== 'node_modules' && e.name !== 'third_party' && !e.name.startsWith('.')) {
                    walk(path.join(d, e.name), rel === '.' ? e.name : `${rel}/${e.name}`);
                }
            } else if (e.name === '.gitignore' && parseIgnore(fs.readFileSync(path.join(d, e.name), 'utf8')).names.length) {
                out.push(rel);
            }
        });
    };
    walk(dir, '.');
    return out;
}

/* Every component folder of a repo tree, relative: native/<id>, apps/<id>. */
function componentDirs(root = REPO) {
    const out = [];
    [['native', 'component.json'], ['apps', 'release.json']].forEach(([top, file]) => {
        const t = path.join(root, top);
        if (!fs.existsSync(t)) {
            return;
        }
        fs.readdirSync(t).sort().forEach((id) => {
            if (fs.existsSync(path.join(t, id, file))) {
                out.push(`${top}/${id}`);
            }
        });
    });
    return out;
}

/* What a component ships from the platform, as repo paths (release.js dates
 * builds by them). */
function shippedPaths(root, relDir) {
    const pin = pinOf(path.join(root, relDir));
    return pin ? pin.files.map(([, src]) => `platform/${pin.version}/${src}`) : [];
}

function idOf(relDir) {
    const file = pinFile(path.join(REPO, relDir));
    return readJson(file).id || path.basename(relDir);
}

function git(args) {
    return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/* Problems, as strings: pins, copies and their .gitignore blocks; with a
 * base ref, frozen versions changed since it. */
function check(base) {
    const problems = [];
    const have = versions();
    if (!have.length) {
        problems.push('platform/ has no x.y.z version folder');
    }
    have.forEach((v) => {
        const log = path.join(PLATFORM, v, 'CHANGELOG.md');
        if (!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes(`## ${v}`)) {
            problems.push(`platform/${v}/CHANGELOG.md has no "## ${v}" entry`);
        }
    });
    let tracked = new Set();
    try {
        tracked = new Set(git(['ls-files']).split('\n'));
    } catch (e) {
        problems.push(`git ls-files: ${e.message}`);
    }
    componentDirs().forEach((rel) => {
        const dir = path.join(REPO, rel);
        let pin;
        try {
            pin = pinOf(dir);
        } catch (e) {
            problems.push(e.message);
            return;
        }
        if (!pin) {
            return;
        }
        if (have.indexOf(pin.version) < 0) {
            problems.push(`${rel} pins platform ${pin.version}, which does not exist`);
            return;
        }
        pin.files.forEach(([dest, src]) => {
            const from = path.join(PLATFORM, pin.version, src);
            if (!fs.existsSync(from)) {
                problems.push(`${rel} copies platform/${pin.version}/${src}, which does not exist`);
            }
            if (tracked.has(`${rel}/${dest}`)) {
                problems.push(`${rel}/${dest} is committed: it is a copy of platform/${pin.version}/${src} (git rm --cached it)`);
            }
            const to = path.join(dir, dest);
            if (fs.existsSync(to) && fs.existsSync(from) && !fs.readFileSync(to).equals(fs.readFileSync(from))) {
                problems.push(`${rel}/${dest} differs from platform/${pin.version}/${src}: edit the platform's, then sync`);
            }
        });
        ignoresFor(dir, pin).forEach((names, d) => {
            const ignore = path.join(dir, d, '.gitignore');
            const text = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
            if (ignoreText(text, names) !== text) {
                problems.push(`${rel}/${d === '.' ? '' : d + '/'}.gitignore does not list the platform copies (run sync, commit it)`);
            }
        });
    });
    if (base) {
        let ok = true;
        try {
            git(['cat-file', '-e', `${base}^{commit}`]);
        } catch (e) {
            ok = false;
            console.log(`check: no commit ${base} here; frozen versions not checked`);
        }
        if (ok) {
            have.slice(0, -1).forEach((v) => {
                const changed = git(['diff', '--name-only', base, '--', `platform/${v}/`]);
                const existed = git(['ls-tree', '--name-only', base, `platform/${v}/`]);
                if (changed && existed) {
                    problems.push(`platform/${v} is frozen (${have[have.length - 1]} is newer) but changed since ${base}: ` +
                        changed.split('\n').join(', '));
                }
            });
        }
    }
    return problems;
}

function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    fs.readdirSync(from, { withFileTypes: true }).forEach((e) => {
        const a = path.join(from, e.name);
        const b = path.join(to, e.name);
        if (e.isDirectory()) {
            copyTree(a, b);
        } else {
            fs.copyFileSync(a, b);
        }
    });
}

function cmdNew(version) {
    if (!SEMVER.test(version || '')) {
        throw new Error('usage: new <x.y.z>');
    }
    const have = versions();
    const newest = have[have.length - 1];
    if (newest && compare(version, newest) <= 0) {
        throw new Error(`the newest version is ${newest}; a new one must be higher`);
    }
    const to = path.join(PLATFORM, version);
    copyTree(path.join(PLATFORM, newest), to);
    const log = path.join(to, 'CHANGELOG.md');
    const text = fs.readFileSync(log, 'utf8');
    const head = text.indexOf('\n## ');
    const entry = `\n## ${version}\n\n- (what changed, and which components it affects)\n`;
    fs.writeFileSync(log, head < 0 ? text + entry : text.slice(0, head) + entry.trimEnd() + '\n' + text.slice(head));
    console.log(`platform/${version}: copied from ${newest}. Make the change there, describe it in its CHANGELOG.md,`);
    console.log(`then: node platform/platform.js use ${version}`);
}

/* The patch version after v. */
function nextPatch(v) {
    const [a, b, c] = v.split('.').map(Number);
    return `${a}.${b}.${c + 1}`;
}

function setPin(file, from, to) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /("platform"\s*:\s*\{\s*"version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
    const m = text.match(re);
    if (!m || m[2] !== from) {
        throw new Error(`${path.relative(REPO, file)}: expected "platform": { "version": "${from}", ... }`);
    }
    fs.writeFileSync(file, text.replace(re, `$1${to}$3`));
}

function cmdUse(version, ids, bump) {
    if (!SEMVER.test(version || '')) {
        throw new Error('usage: use <x.y.z> [<id>...] [--no-bump]');
    }
    if (versions().indexOf(version) < 0) {
        throw new Error(`no platform ${version} (have: ${versions().join(', ')})`);
    }
    const pinned = componentDirs().map((rel) => ({ rel, id: idOf(rel), pin: pinOf(path.join(REPO, rel)) }))
        .filter((c) => c.pin);
    ids.forEach((id) => {
        if (!pinned.some((c) => c.id === id)) {
            throw new Error(`no component "${id}" pins the platform (have: ${pinned.map((c) => c.id).join(', ')})`);
        }
    });
    const chosen = pinned.filter((c) => (!ids.length || ids.indexOf(c.id) >= 0) && c.pin.version !== version);
    if (!chosen.length) {
        console.log(`nothing to do: ${ids.length ? ids.join(', ') : 'every component'} already on ${version}`);
        return;
    }
    // every file each one copies must exist in the new version before any is changed
    chosen.forEach((c) => c.pin.files.forEach(([, src]) => {
        if (!fs.existsSync(path.join(PLATFORM, version, src))) {
            throw new Error(`${c.id} copies ${src}, which platform ${version} lacks`);
        }
    }));
    const release = bump ? require(path.join(REPO, 'release', 'release.js')) : null;
    const comps = release ? release.components() : [];
    chosen.forEach((c) => {
        const differs = c.pin.files.filter(([, src]) =>
            !fs.readFileSync(path.join(PLATFORM, c.pin.version, src)).equals(fs.readFileSync(path.join(PLATFORM, version, src))));
        setPin(c.pin.file, c.pin.version, version);
        console.log(`${c.id}: platform ${c.pin.version} -> ${version}` +
            (differs.length ? ` (changed: ${differs.map((f) => f[1]).join(', ')})` : ' (its files are unchanged)'));
        if (release) {
            // a tool's artifact is dated by what it ships, so any new pin changes its bytes;
            // an app's source package only when a file it copies changed
            const comp = comps.find((x) => x.id === c.id);
            if (comp && (comp.kind === 'tool' || differs.length)) {
                release.bump(c.id, nextPatch(comp.version));
            }
        }
        sync(path.join(REPO, c.rel));
    });
    console.log('next: CHANGELOG entries for the bumped apps, the tests, commit; publish with the Release workflow');
}

function cmdList() {
    const have = versions();
    const users = new Map(have.map((v) => [v, []]));
    componentDirs().forEach((rel) => {
        const pin = pinOf(path.join(REPO, rel));
        const id = idOf(rel);
        console.log(`${id.padEnd(22)} ${pin ? `platform ${pin.version}  (${pin.files.length} files)` : '-'}`);
        if (pin) {
            users.set(pin.version, (users.get(pin.version) || []).concat(id));
        }
    });
    console.log('');
    users.forEach((ids, v) => console.log(`platform ${v}: ${ids.length ? ids.join(', ') : 'unused (can be removed)'}` +
        (v === have[have.length - 1] ? '  [newest, open]' : '  [frozen]')));
}

function main(argv) {
    const [cmd, ...rest] = argv;
    const args = rest.filter((a) => !a.startsWith('--'));
    switch (cmd) {
    case 'list':
        return cmdList();
    case 'sync': {
        const dirs = args.length ? args.map((a) => path.resolve(a)) : componentDirs().map((r) => path.join(REPO, r));
        dirs.forEach((d) => {
            const n = sync(d).length;
            if (n) {
                console.log(`${path.relative(REPO, d).split(path.sep).join('/')}: ${n} platform files`);
            }
        });
        return undefined;
    }
    case 'check': {
        const i = rest.indexOf('--base');
        const problems = check(i >= 0 ? rest[i + 1] : null);
        problems.forEach((p) => console.error(`platform: ${p}`));
        if (problems.length) {
            process.exitCode = 1;
        } else {
            console.log('platform: ok');
        }
        return undefined;
    }
    case 'new':
        return cmdNew(args[0]);
    case 'use':
        return cmdUse(args[0], args.slice(1), !rest.includes('--no-bump'));
    default:
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].split('\n').slice(1, 13)
            .map((l) => l.replace(/^ \* ?/, '')).join('\n') + '\n');
        process.exitCode = cmd ? 2 : 0;
    }
    return undefined;
}

// filled in place, before main: release.js (which `use` loads) requires this module back
Object.assign(module.exports, { versions, pinOf, sync, check, shippedPaths, componentDirs, compare, ignoreText, parseIgnore });

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`platform: ${e.message}`);
        process.exitCode = 1;
    }
}
