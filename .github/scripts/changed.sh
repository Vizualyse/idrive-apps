#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Did a component change since the push's or pull request's base? For the
# Test workflow's slow steps that only matter then (Moonlight against
# Sunshine, Steam's bundles). A component is its folder (its pins in
# component.json included), the platform module versions it pins, and any
# EXTRA paths its build reads from elsewhere. No base to compare with (a new
# branch, a force push): changed.
#
#   BASE=<sha> sh .github/scripts/changed.sh NAME DIR [EXTRA...]
#
# Writes NAME=true|false to $GITHUB_OUTPUT (stdout without it).
set -eu
name=$1 dir=$2
shift 2
paths="$dir/ $(node -e '
    const c = require(require("path").resolve(process.argv[1], "component.json"));
    const p = c.platform || {};
    console.log(Object.keys(p).map((m) => "platform/" + m + "/" + p[m].version + "/").join(" "));' "$dir") $*"
if [ -n "${BASE:-}" ] && git cat-file -e "$BASE^{commit}" 2>/dev/null && git diff --quiet "$BASE" HEAD -- $paths; then
    echo "$name: unchanged since $BASE ($paths)"
    r=false
else
    echo "$name: changed (or no base to compare with): $paths"
    r=true
fi
echo "$name=$r" >> "${GITHUB_OUTPUT:-/dev/stdout}"
