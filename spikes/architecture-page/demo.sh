#!/usr/bin/env bash
# Writes out/basket.html: the page for a basket PR that both changes the target, adding basket sharing (basket#16's
# design, test/fixtures/target-changes/sharing.json), and drifts from it, with the basket controller importing the
# repository (the controller-imports-repository variant).
#
# Needs `npm run build` at the repo root and `npm install` here.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
bearing=$(cd "$here/../.." && pwd)
fixtures=$bearing/test/fixtures
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

g() { git -C "$work" -c user.name=Demo -c user.email=demo@example.com "$@"; }

cp -R "$fixtures/basket/repo/." "$work"
ln -s "$bearing/node_modules" "$work/node_modules"
cp "$fixtures/basket/workspace.json" "$work/architecture/workspace.json"
perl -pi -e 's/workspace\.dsl/workspace.json/' "$work/.bearing/config.yaml"
g init -q -b main
g add .
g commit -q -m main

g switch -q -c share-a-basket
cp "$fixtures/target-changes/sharing.json" "$work/architecture/workspace.json"
cp -R "$fixtures/basket/variants/controller-imports-repository/." "$work"
g add .
g commit -q -m "Share a basket"

# The fixture's issues, with the sharing story the new design serves.
node -e '
  const issues = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  issues.push({ ...issues[0], number: 5, title: "Share a basket", body: "**Story**\nAs a shopper, I want to share my basket by email, so that someone else can buy it.\n\n**Acceptance criteria**\n1. Given a shopper with items in their basket, when they share it with an email address, then that address is sent a link to it." });
  require("fs").writeFileSync(process.argv[2], JSON.stringify(issues));
' "$fixtures/basket/issues.json" "$work/issues.json"

cd "$work"
BEARING_ISSUES_FILE=$work/issues.json node "$here/build.mjs" --repo "$work" --base main --out "$here/out/basket.html"
