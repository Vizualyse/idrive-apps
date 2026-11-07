#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * The Vizualyse platform: code every tool and app shares, kept once as
 * modules, each versioned on its own (platform/<side>/<module>/<x.y.z>/), and
 * copied into each component that pins a version of it.
 * platform/README.md says how to use it.
 *
 *   node platform/platform.js list                     which component pins which module versions
 *   node platform/platform.js sync [<dir>...]          write each component's copies (all by default)
 *   node platform/platform.js check [--base <ref>]     pins, copies, and frozen versions unchanged since <ref>
 *   node platform/platform.js new <side/module> <x.y.z>
 *                                                      a new version, copied from the module's newest
 *                                                      (or a new, empty module)
 *   node platform/platform.js use <side/module> <x.y.z> [<id>...] [--no-bump]
 *                                                      pin a module version (every component using it by default)
 *                                                      and bump each component whose artifact changes
 *
 * <side> is tool (Node 8, mgu-python), app (iDrive app, OAP), common (both)
 * or native (C, compiled into a tool). A component pins in its own file: a
 * tool in native/<id>/component.json, an app in apps/<id>/release.json
 * (neither is shipped to the unit as is), one entry per module it uses:
 *
 *   "platform": {
 *     "common/qrcode": { "version": "1.0.0", "files": { "src/qrcode.js": "qrcode.js" } },
 *     "native/touch":  { "version": "1.0.1", "files": { "core/touch.c": "touch.c", "core/touch.h": "touch.h" } }
 *   }
 *
 * Each file is where the copy goes in the component : which file of the
 * module version it copies. The copies sit where the component's code and
 * build already look for them, so nothing else changes. They are never
 * committed: sync keeps a block in a .gitignore beside them that lists them.
 * The packer (release/tool_artifact.js) and each app's tools/build.js sync
 * before they build, so a release always carries exactly the pinned versions.
 *
 * A module version is frozen once a newer version of that module exists: a
 * fix is a new version (`new`), then `use` moves the components onto it.
 * `check --base` refuses a change to a frozen version.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PLATFORM = __dirname;
const REPO = path.resolve(PLATFORM, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const SIDES = ['tool', 'app', 'common', 'native'];
const MODULE = /^(tool|app|common|native)\/[a-z0-9][a-z0-9_-]*$/;
/* what else may sit in platform/ */
const OWN = ['platform.js', 'README.md', 'BUILDING-APPS.md', 'test'];
const BEGIN = '# platform: copies of platform/<side>/<module>/<version>/ files, pinned in';
const BEGIN2 = '# this component\'s component.json or release.json; written by `node platform/platform.js sync`.';
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

function isDir(p) {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

/* The modules under a platform folder, as side/module, sorted. */
function modules(platformDir = PLATFORM) {
    const out = [];
    SIDES.forEach((side) => {
        const d = path.join(platformDir, side);
        if (isDir(d)) {
            fs.readdirSync(d).sort().forEach((m) => {
                if (isDir(path.join(d, m))) {
                    out.push(`${side}/${m}`);
                }
            });
        }
    });
    return out;
}

/* A module's versions, oldest first ([] for no such module). */
function versions(mod, platformDir = PLATFORM) {
    const d = path.join(platformDir, mod || '');
    if (!MODULE.test(mod || '') || !isDir(d)) {
        return [];
    }
    return fs.readdirSync(d).filter((n) => SEMVER.test(n) && isDir(path.join(d, n))).sort(compare);
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

/* A component folder's pin, or null when it has none:
 *   { file, modules: [{ name, version }], files: [[dest, src, module]] }
 * with src relative to the platform folder (side/module/version/file). A
 * component folder is native/<id> or apps/<id>, so its platform folder is
 * ../../platform. Throws on a malformed pin. */
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
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length) {
        throw new Error(`${where}: "platform" needs one entry per module: { "<side>/<module>": { "version": "x.y.z", "files": {...} } }`);
    }
    const mods = [];
    const files = [];
    Object.keys(p).forEach((name) => {
        const m = p[name];
        if (!MODULE.test(name)) {
            throw new Error(`${where}: "${name}" is not a platform module (<${SIDES.join('|')}>/<name>)`);
        }
        if (!m || typeof m !== 'object' || !SEMVER.test(m.version || '') || !m.files || typeof m.files !== 'object' ||
            Array.isArray(m.files) || !Object.keys(m.files).length) {
            throw new Error(`${where}: platform module "${name}" needs a x.y.z "version" and "files" (copy path: module file)`);
        }
        mods.push({ name, version: m.version });
        Object.keys(m.files).forEach((dest) => {
            const src = m.files[dest];
            if (!safeRel(dest) || !safeRel(src) || path.posix.basename(dest) === '.gitignore') {
                throw new Error(`${where}: bad platform file "${dest}": "${src}" (${name})`);
            }
            if (files.some((f) => f[0] === dest)) {
                throw new Error(`${where}: platform file "${dest}" is copied by two modules`);
            }
            files.push([dest, `${name}/${m.version}/${src}`, name]);
        });
    });
    return { file, modules: mods, files };
}

function platformOf(dir) {
    return path.join(dir, '..', '..', 'platform');
}

/* A .gitignore's text with LF line ends ('' when there is none): a Windows
 * checkout (core.autocrlf) has CRLF, and the block must still be found, or
 * sync would add a second one. */
function readIgnore(file) {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
}

/* The managed block of a .gitignore's text: { names, before, after }. */
function parseIgnore(text) {
    const lines = text.split('\n');
    // a block written before the modules (with another first line) is ours too
    const b = lines.findIndex((l) => l.startsWith('# platform: copies of platform/'));
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

/* The copies a pin writes, by folder (relative to the component). */
function ignoresFor(pin) {
    const byDir = new Map();
    pin.files.forEach(([dest]) => {
        const d = path.posix.dirname(dest);
        byDir.set(d, (byDir.get(d) || []).concat(path.posix.basename(dest)));
    });
    return byDir;
}

/* Writes a component's copies from its pinned module versions and the
 * .gitignore blocks that list them; removes copies it wrote before that the
 * pin no longer names. Returns the copies written, or [] without a pin. */
function sync(dir) {
    dir = path.resolve(dir);
    const pin = pinOf(dir);
    const byDir = pin ? ignoresFor(pin) : new Map();
    // folders whose block lists copies the pin dropped
    walkIgnores(dir).forEach((d) => {
        if (!byDir.has(d)) {
            byDir.set(d, []);
        }
    });
    if (!pin && !byDir.size) {
        return [];
    }
    const root = platformOf(dir);
    const where = pin && path.relative(REPO, pin.file);
    if (pin) {
        pin.modules.forEach((m) => {
            const have = versions(m.name, root);
            if (!have.length) {
                throw new Error(`${where}: platform module ${m.name} does not exist (have: ${modules(root).join(', ')})`);
            }
            if (have.indexOf(m.version) < 0) {
                throw new Error(`${where}: platform ${m.name} ${m.version} does not exist (have: ${have.join(', ')})`);
            }
        });
    }
    const written = [];
    byDir.forEach((names, d) => {
        const folder = path.join(dir, d);
        const ignore = path.join(folder, '.gitignore');
        const existing = readIgnore(ignore);
        parseIgnore(existing).names.filter((n) => names.indexOf(n) < 0).forEach((n) => {
            fs.rmSync(path.join(folder, n), { force: true });
        });
        names.forEach((n) => {
            const dest = d === '.' ? n : `${d}/${n}`;
            const src = pin.files.find((f) => f[0] === dest)[1];
            const from = path.join(root, src);
            if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
                throw new Error(`${where}: platform has no ${src}`);
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
            } else if (e.name === '.gitignore' && parseIgnore(readIgnore(path.join(d, e.name))).names.length) {
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
    return pin ? pin.files.map(([, src]) => `platform/${src}`) : [];
}

function idOf(relDir) {
    const file = pinFile(path.join(REPO, relDir));
    return readJson(file).id || path.basename(relDir);
}

function git(args) {
    return cp.execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/* Problems, as strings: the platform's layout, pins, copies and their
 * .gitignore blocks; with a base ref, frozen versions changed since it. */
function check(base) {
    const problems = [];
    fs.readdirSync(PLATFORM).forEach((n) => {
        if (OWN.indexOf(n) < 0 && SIDES.indexOf(n) < 0) {
            problems.push(`platform/${n}: not a side (${SIDES.join(', ')}); a module version lives in platform/<side>/<module>/<x.y.z>/`);
        }
    });
    SIDES.forEach((side) => {
        const d = path.join(PLATFORM, side);
        if (isDir(d)) {
            fs.readdirSync(d).forEach((m) => {
                if (!MODULE.test(`${side}/${m}`) || !isDir(path.join(d, m))) {
                    problems.push(`platform/${side}/${m}: not a module (lower case letters, digits, _ and -; a folder)`);
                }
            });
        }
    });
    const mods = modules().filter((m) => MODULE.test(m));
    mods.forEach((m) => {
        const have = versions(m);
        if (!have.length) {
            problems.push(`platform/${m} has no x.y.z version folder`);
        }
        fs.readdirSync(path.join(PLATFORM, m)).forEach((n) => {
            if (n !== 'CHANGELOG.md' && have.indexOf(n) < 0) {
                problems.push(`platform/${m}/${n}: a module holds its CHANGELOG.md and x.y.z version folders only`);
            }
        });
        const log = path.join(PLATFORM, m, 'CHANGELOG.md');
        const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
        have.forEach((v) => {
            if (!text.includes(`## ${v}`)) {
                problems.push(`platform/${m}/CHANGELOG.md has no "## ${v}" entry`);
            }
        });
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
        const missing = pin.modules.filter((m) => versions(m.name).indexOf(m.version) < 0);
        missing.forEach((m) => problems.push(`${rel} pins platform ${m.name} ${m.version}, which does not exist`));
        pin.files.filter(([, , mod]) => !missing.some((m) => m.name === mod)).forEach(([dest, src]) => {
            const from = path.join(PLATFORM, src);
            if (!fs.existsSync(from)) {
                problems.push(`${rel} copies platform/${src}, which does not exist`);
            }
            if (tracked.has(`${rel}/${dest}`)) {
                problems.push(`${rel}/${dest} is committed: it is a copy of platform/${src} (git rm --cached it)`);
            }
            const to = path.join(dir, dest);
            if (fs.existsSync(to) && fs.existsSync(from) && !fs.readFileSync(to).equals(fs.readFileSync(from))) {
                problems.push(`${rel}/${dest} differs from platform/${src}: edit the platform's, then sync`);
            }
        });
        ignoresFor(pin).forEach((names, d) => {
            const ignore = path.join(dir, d, '.gitignore');
            const text = readIgnore(ignore);
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
            mods.forEach((m) => {
                const have = versions(m);
                have.slice(0, -1).forEach((v) => {
                    const changed = git(['diff', '--name-only', base, '--', `platform/${m}/${v}/`]);
                    const existed = git(['ls-tree', '--name-only', base, `platform/${m}/${v}/`]);
                    if (changed && existed) {
                        problems.push(`platform/${m} ${v} is frozen (${have[have.length - 1]} is newer) but changed since ${base}: ` +
                            changed.split('\n').join(', '));
                    }
                });
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

function cmdNew(mod, version) {
    if (!MODULE.test(mod || '') || !SEMVER.test(version || '')) {
        throw new Error(`usage: new <${SIDES.join('|')}>/<module> <x.y.z>`);
    }
    const have = versions(mod);
    const newest = have[have.length - 1];
    if (newest && compare(version, newest) <= 0) {
        throw new Error(`the newest ${mod} is ${newest}; a new one must be higher`);
    }
    const dir = path.join(PLATFORM, mod);
    const to = path.join(dir, version);
    const log = path.join(dir, 'CHANGELOG.md');
    if (newest) {
        copyTree(path.join(dir, newest), to);
    } else {
        fs.mkdirSync(to, { recursive: true });
    }
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') :
        `# ${mod}\n\nA version is frozen once a newer one exists. A component moves to a new\n` +
        `one with \`node platform/platform.js use ${mod} <version>\`.\n`;
    const head = text.indexOf('\n## ');
    const entry = `\n## ${version}\n\n- (what changed, and which components it affects)\n`;
    fs.writeFileSync(log, head < 0 ? text + entry : text.slice(0, head) + entry.trimEnd() + '\n' + text.slice(head));
    console.log(newest ? `platform/${mod}/${version}: copied from ${newest}. Make the change there, describe it in ${mod}/CHANGELOG.md,` :
        `platform/${mod}/${version}: a new module. Put its files there, describe it in ${mod}/CHANGELOG.md,`);
    console.log(newest ? `then: node platform/platform.js use ${mod} ${version}` :
        'then pin it in each component that uses it (component.json / release.json "platform")');
}

/* The patch version after v. */
function nextPatch(v) {
    const [a, b, c] = v.split('.').map(Number);
    return `${a}.${b}.${c + 1}`;
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\/-]/g, (c) => '\\' + c);
}

/* Moves one module's pin in a component's file, keeping its formatting. */
function setPin(file, mod, from, to) {
    const text = fs.readFileSync(file, 'utf8');
    const re = new RegExp('("' + escapeRe(mod) + '"\\s*:\\s*\\{\\s*"version"\\s*:\\s*")(\\d+\\.\\d+\\.\\d+)(")');
    const m = text.match(re);
    if (!m || m[2] !== from) {
        throw new Error(`${path.relative(REPO, file)}: expected "${mod}": { "version": "${from}", ... } in "platform"`);
    }
    fs.writeFileSync(file, text.replace(re, `$1${to}$3`));
}

function cmdUse(mod, version, ids, bump) {
    if (!MODULE.test(mod || '') || !SEMVER.test(version || '')) {
        throw new Error(`usage: use <${SIDES.join('|')}>/<module> <x.y.z> [<id>...] [--no-bump]`);
    }
    const have = versions(mod);
    if (have.indexOf(version) < 0) {
        throw new Error(have.length ? `no ${mod} ${version} (have: ${have.join(', ')})` : `no platform module ${mod}`);
    }
    const users = componentDirs().map((rel) => ({ rel, id: idOf(rel), pin: pinOf(path.join(REPO, rel)) }))
        .filter((c) => c.pin && c.pin.modules.some((m) => m.name === mod))
        .map((c) => Object.assign(c, { from: c.pin.modules.find((m) => m.name === mod).version }));
    ids.forEach((id) => {
        if (!users.some((c) => c.id === id)) {
            throw new Error(`no component "${id}" uses ${mod} (users: ${users.map((c) => c.id).join(', ') || 'none'}); ` +
                'add the module to its "platform" by hand');
        }
    });
    const chosen = users.filter((c) => (!ids.length || ids.indexOf(c.id) >= 0) && c.from !== version);
    if (!chosen.length) {
        console.log(`nothing to do: ${ids.length ? ids.join(', ') : 'every user of ' + mod} already on ${version}`);
        return;
    }
    // the module's files a component copies, relative to the version folder
    const filesOf = (c) => c.pin.files.filter((f) => f[2] === mod).map(([, src]) => src.split('/').slice(3).join('/'));
    // every file each one copies must exist in the new version before any is changed
    chosen.forEach((c) => filesOf(c).forEach((f) => {
        if (!fs.existsSync(path.join(PLATFORM, mod, version, f))) {
            throw new Error(`${c.id} copies ${f}, which ${mod} ${version} lacks`);
        }
    }));
    const release = bump ? require(path.join(REPO, 'release', 'release.js')) : null;
    const comps = release ? release.components() : [];
    chosen.forEach((c) => {
        const differs = filesOf(c).filter((f) =>
            !fs.readFileSync(path.join(PLATFORM, mod, c.from, f)).equals(fs.readFileSync(path.join(PLATFORM, mod, version, f))));
        setPin(c.pin.file, mod, c.from, version);
        console.log(`${c.id}: ${mod} ${c.from} -> ${version}` +
            (differs.length ? ` (changed: ${differs.join(', ')})` : ' (its files are unchanged)'));
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
    const users = new Map();
    componentDirs().forEach((rel) => {
        const pin = pinOf(path.join(REPO, rel));
        const id = idOf(rel);
        console.log(`${id.padEnd(22)} ${pin ? pin.modules.map((m) => `${m.name}@${m.version}`).join('  ') : '-'}`);
        (pin ? pin.modules : []).forEach((m) => {
            const k = `${m.name}@${m.version}`;
            users.set(k, (users.get(k) || []).concat(id));
        });
    });
    console.log('');
    modules().forEach((m) => {
        const have = versions(m);
        have.forEach((v) => {
            const ids = users.get(`${m}@${v}`) || [];
            console.log(`${(m + ' ' + v).padEnd(36)} ${ids.length ? ids.join(', ') : 'unused'}` +
                (v === have[have.length - 1] ? '  [newest, open]' : '  [frozen]'));
        });
    });
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
        return cmdNew(args[0], args[1]);
    case 'use':
        return cmdUse(args[0], args[1], args.slice(2), !rest.includes('--no-bump'));
    default:
        process.stdout.write(fs.readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].split('\n').slice(1, 17)
            .map((l) => l.replace(/^ \* ?/, '')).join('\n') + '\n');
        process.exitCode = cmd ? 2 : 0;
    }
    return undefined;
}

// filled in place, before main: release.js (which `use` loads) requires this module back
Object.assign(module.exports, { modules, versions, pinOf, sync, check, shippedPaths, componentDirs, compare, ignoreText, parseIgnore });

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (e) {
        console.error(`platform: ${e.message}`);
        process.exitCode = 1;
    }
}
