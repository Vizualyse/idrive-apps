#!/usr/bin/env python3
"""Static survey of CarPlay binaries in an extracted head-unit root file system.

    survey.py --rootfs <dir> --out <dir> [--target <path> ...]

Off-car and read-only. With no --target it surveys /usr/bin/carplay and every
libNme* in the root file system. A --target outside the root file system (for
example another firmware's carplay) is resolved AGAINST that root file system,
which is the dependency check for swapping a build in:

  * identity: size, SHA-256, GNU build-id, version strings;
  * loading: each DT_NEEDED resolved through the root file system (recursively),
    and each undefined dynamic symbol (with its version) checked against what
    the resolved libraries define;
  * second-screen evidence: where the CarPlay alt-screen vocabulary (keys the
    phone negotiates, Cinemo API names seen in carplay 22.28.3) occurs.

Writes survey.json and survey.md to --out. Needs pyelftools, readelf, c++filt.
"""
import argparse, hashlib, json, os, re, subprocess, sys

from elftools.elf.elffile import ELFFile
from elftools.elf.dynamic import DynamicSection
from elftools.common.exceptions import ELFError

# The vocabulary of the CarPlay alternate screen. Sources: re/references.md.
KEYWORDS = [
    # /info and SETUP keys, and session commands (MHI2-altScreen, AirPlay RE)
    "altScreen", "viewAreas", "viewArea", "safeArea", "adjacentViewAreas",
    "initialViewArea", "updateViewArea", "displayFeatures", "displays",
    "widthPixels", "heightPixels", "widthPhysical", "heightPhysical", "maxFPS",
    "primaryInputDevice", "initialURL", "altScreenSuggestUIURLs", "enabledFeatures",
    "suggestUI", "showUI", "stopUI", "changeMapZoomLevel", "instrumentcluster",
    "instructioncard", "streamConnectionID", "DataStream", "AirPlayStreamKey",
    "AirPlayStreamIV", "screenType", "cornerMasks", "focusTransfer",
    # Cinemo / BMW names seen in carplay 22.28.3 (waze-on-cluster)
    "SetInitialInfoResponse", "GetDisplaySource", "ShowUI", "ForceKeyframe",
    "AlternateDisplay", "ICSafeAreaProvider", "KombiVariant", "requestStream",
    "onSuggestUi", "SuggestUi", "NmeVfsSocket", "avb://", "mime_type=video/H264",
    "AirPlayReceiver", "ScreenStream", "SessionScreen",
]
VERSION_RE = re.compile(rb"(?i)(cinemo|nme|carplay|airplay)[^\x00\n]{0,40}?\d+\.\d+(\.\d+)?")
SEARCH_DIRS = ["lib", "lib64", "usr/lib", "usr/lib64", "lib/x86_64-linux-gnu", "usr/lib/x86_64-linux-gnu"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def is_elf(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def in_root(root, p):
    """A path inside the root file system, following symlinks within it."""
    p = p.lstrip("/")
    for _ in range(40):
        full = os.path.join(root, p)
        if os.path.islink(full):
            t = os.readlink(full)
            p = t.lstrip("/") if t.startswith("/") else os.path.normpath(os.path.join(os.path.dirname(p), t))
            continue
        return full
    return None


def elf_info(path):
    info = {"needed": [], "soname": None, "runpath": [], "build_id": None, "machine": None}
    with open(path, "rb") as f:
        elf = ELFFile(f)
        info["machine"] = elf["e_machine"]
        for sec in elf.iter_sections():
            if isinstance(sec, DynamicSection):
                for t in sec.iter_tags():
                    if t.entry.d_tag == "DT_NEEDED":
                        info["needed"].append(t.needed)
                    elif t.entry.d_tag == "DT_SONAME":
                        info["soname"] = t.soname
                    elif t.entry.d_tag in ("DT_RUNPATH", "DT_RPATH"):
                        info["runpath"] += (getattr(t, "runpath", None) or getattr(t, "rpath", "")).split(":")
            if sec.name == ".note.gnu.build-id":
                for n in sec.iter_notes():
                    if n["n_type"] == "NT_GNU_BUILD_ID":
                        info["build_id"] = n["n_desc"]
    return info


DYNSYM_RE = re.compile(r"^\s*\d+:\s+[0-9a-f]+\s+\d+\s+(\w+)\s+(\w+)\s+\w+\s+(\w+)\s+(\S+)")


def dynsyms(path):
    """[(name, version or '', defined, bind)] from readelf (it prints versions)."""
    out = subprocess.run(["readelf", "--dyn-syms", "-W", path], capture_output=True, text=True).stdout
    syms = []
    for line in out.splitlines():
        m = DYNSYM_RE.match(line)
        if not m:
            continue
        typ, bind, ndx, name = m.groups()
        ver = ""
        if "@" in name:
            name, _, ver = name.partition("@")
            ver = ver.lstrip("@")
        if not name:
            continue
        syms.append((name, ver, ndx != "UND", bind))
    return syms


def demangle(names):
    if not names:
        return []
    r = subprocess.run(["c++filt"], input="\n".join(names), capture_output=True, text=True)
    return r.stdout.splitlines()


def ld_conf_dirs(root):
    dirs = []
    def read(conf):
        try:
            for line in open(conf, errors="replace"):
                line = line.split("#")[0].strip()
                if line.startswith("include "):
                    import glob
                    for inc in sorted(glob.glob(os.path.join(root, line[8:].strip().lstrip("/")))):
                        read(inc)
                elif line:
                    dirs.append(line.lstrip("/"))
        except OSError:
            pass
    read(os.path.join(root, "etc/ld.so.conf"))
    return dirs


def resolve_closure(root, targets):
    """Resolve DT_NEEDED breadth-first. Returns ({soname: path}, {soname: [needed by]}, missing)."""
    dirs = SEARCH_DIRS + ld_conf_dirs(root)
    resolved, needed_by, missing = {}, {}, {}
    queue = [(t, None) for t in targets]
    seen = set()
    while queue:
        path, _ = queue.pop(0)
        if path in seen:
            continue
        seen.add(path)
        info = elf_info(path)
        extra = [d.replace("$ORIGIN", os.path.relpath(os.path.dirname(path), root)).lstrip("/") for d in info["runpath"] if d]
        for so in info["needed"]:
            needed_by.setdefault(so, []).append(os.path.basename(path))
            if so in resolved or so in missing:
                continue
            hit = None
            for d in extra + dirs:
                cand = in_root(root, os.path.join(d, so))
                if cand and os.path.isfile(cand) and is_elf(cand):
                    hit = cand
                    break
            if hit:
                resolved[so] = hit
                queue.append((hit, so))
            else:
                missing[so] = True
    return resolved, needed_by, sorted(missing)


def check_symbols(targets, resolved):
    """Undefined, non-weak symbols of the targets that nothing in the closure defines."""
    defined = {}
    for path in list(resolved.values()) + list(targets):
        for name, ver, is_def, _ in dynsyms(path):
            if is_def:
                defined.setdefault(name, set()).add(ver)
    unresolved = {}
    for t in targets:
        for name, ver, is_def, bind in dynsyms(t):
            if is_def or bind == "WEAK":
                continue
            have = defined.get(name)
            if have is None or (ver and ver not in have and "" not in have):
                unresolved.setdefault(os.path.basename(t), []).append(
                    {"symbol": name, "version": ver, "available_versions": sorted(have) if have else []})
    return unresolved


def strings_hits(path):
    data = open(path, "rb").read()
    hits = {}
    for kw in KEYWORDS:
        b = kw.encode()
        offs, i = [], data.find(b)
        while i != -1 and len(offs) < 50:
            # the whole printable string around the hit, for context
            s = i
            while s > 0 and 0x20 <= data[s - 1] < 0x7f and i - s < 200:
                s -= 1
            e = i + len(b)
            while e < len(data) and 0x20 <= data[e] < 0x7f and e - i < 200:
                e += 1
            offs.append({"offset": hex(i), "string": data[s:e].decode("ascii", "replace")})
            i = data.find(b, i + 1)
        if offs:
            hits[kw] = offs
    versions = sorted({m.group(0).decode("ascii", "replace") for m in VERSION_RE.finditer(data)})[:100]
    return hits, versions


def find_targets(root):
    out = []
    cp = in_root(root, "usr/bin/carplay")
    if cp and os.path.isfile(cp):
        out.append(cp)
    for dp, _, files in os.walk(root):
        for fn in files:
            if fn.startswith("libNme") and is_elf(os.path.join(dp, fn)) and not os.path.islink(os.path.join(dp, fn)):
                out.append(os.path.join(dp, fn))
    return sorted(set(out))


def survey(root, targets):
    report = {"rootfs": root, "targets": {}}
    resolved, needed_by, missing = resolve_closure(root, targets)
    report["closure"] = {"resolved": {k: os.path.relpath(v, root) for k, v in sorted(resolved.items())},
                         "missing": missing,
                         "missing_needed_by": {m: needed_by.get(m, []) for m in missing}}
    report["unresolved_symbols"] = check_symbols(targets, resolved)
    for t in targets:
        info = elf_info(t)
        syms = dynsyms(t)
        exported = [n for n, v, d, b in syms if d]
        dem = demangle(exported)
        kw_lower = [k.lower() for k in KEYWORDS]
        interesting = sorted({d for d in dem if any(k in d.lower() for k in kw_lower)})
        hits, versions = strings_hits(t)
        report["targets"][os.path.relpath(t, root) if t.startswith(root) else t] = {
            "size": os.path.getsize(t), "sha256": sha256(t), "build_id": info["build_id"],
            "machine": info["machine"], "soname": info["soname"], "needed": info["needed"],
            "exported_count": len(exported), "imported_count": sum(1 for s in syms if not s[2]),
            "exported_keyword_symbols": interesting[:300],
            "version_strings": versions, "keyword_hits": hits,
        }
    return report


def to_md(r):
    L = ["# CarPlay static survey", "", f"Root file system: `{r['rootfs']}`", ""]
    L += ["## Loading", ""]
    L.append(f"- Libraries resolved: {len(r['closure']['resolved'])}")
    L.append(f"- Libraries missing: {len(r['closure']['missing'])}")
    for m in r["closure"]["missing"]:
        L.append(f"  - `{m}` (needed by {', '.join(r['closure']['missing_needed_by'][m])})")
    n = sum(len(v) for v in r["unresolved_symbols"].values())
    L.append(f"- Undefined symbols nothing defines: {n}")
    for t, lst in r["unresolved_symbols"].items():
        for s in lst[:200]:
            av = f" (available: {', '.join(s['available_versions'])})" if s["available_versions"] else ""
            L.append(f"  - {t}: `{s['symbol']}`{'@' + s['version'] if s['version'] else ''}{av}")
    for t, d in r["targets"].items():
        L += ["", f"## `{t}`", "",
              f"- size {d['size']}, sha256 `{d['sha256']}`, build-id `{d['build_id']}`, {d['machine']}",
              f"- {d['exported_count']} exported, {d['imported_count']} imported dynamic symbols",
              f"- NEEDED: {', '.join(d['needed'])}"]
        if d["version_strings"]:
            L += ["", "Version strings:", ""] + [f"- `{v}`" for v in d["version_strings"][:30]]
        L += ["", "Second-screen vocabulary:", "", "| keyword | hits | first string |", "|---|---|---|"]
        for kw in KEYWORDS:
            h = d["keyword_hits"].get(kw)
            if h:
                first = h[0]["string"].replace("|", "\\|")[:120]
                L.append(f"| `{kw}` | {len(h)} | `{first}` |")
        absent = [k for k in KEYWORDS if k not in d["keyword_hits"]]
        L += ["", "Absent: " + ", ".join(f"`{k}`" for k in absent)]
        if d["exported_keyword_symbols"]:
            L += ["", "Exported symbols naming that vocabulary:", ""] + [f"- `{s}`" for s in d["exported_keyword_symbols"][:80]]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rootfs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--target", action="append", default=[])
    a = ap.parse_args()
    root = os.path.abspath(a.rootfs)
    targets = [os.path.abspath(t) for t in a.target] or find_targets(root)
    if not targets:
        sys.exit("no carplay or libNme* found in " + root)
    for t in targets:
        if not is_elf(t):
            sys.exit("not an ELF file: " + t)
    try:
        r = survey(root, targets)
    except ELFError as e:
        sys.exit("ELF error: %s" % e)
    os.makedirs(a.out, exist_ok=True)
    json.dump(r, open(os.path.join(a.out, "survey.json"), "w"), indent=1)
    open(os.path.join(a.out, "survey.md"), "w").write(to_md(r))
    print(to_md(r))


if __name__ == "__main__":
    main()
