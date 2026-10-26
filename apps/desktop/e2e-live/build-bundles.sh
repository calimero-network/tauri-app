#!/usr/bin/env bash
# Builds the kv-store bundles the bundled-frontend specs install, from a
# checkout of calimero-network/apps with kv-store's frontend built into
# apps/kv-store/app/dist. Needs cargo-mero from the core tag the apps pin.
#
#   APPS_DIR  the apps checkout
#   OUT_DIR   where frontend.mpk and plain.mpk go
#   MEROD_VERSION  the merod the bundles will run on (merod-config.json pins it)
#
# frontend.mpk packs the frontend and declares no frontend link, so the node is
# the only place the desktop can learn it from. plain.mpk has neither. Each is a
# package of its own so the registry's kv-store releases stay the upgrade pair.
# Both lower the minimum runtime to MEROD_VERSION, older than the SDK they build with.
set -euo pipefail

manifest="$APPS_DIR/apps/kv-store/logic/Cargo.toml"
version=0.0.80
mkdir -p "$OUT_DIR"
cp "$manifest" "$OUT_DIR/Cargo.toml.orig"
trap 'cp "$OUT_DIR/Cargo.toml.orig" "$manifest"; rm -f "$OUT_DIR/Cargo.toml.orig" "$manifest.bak"' EXIT

bundle() { # name, package
  cargo mero bundle --manifest-path "$manifest" --dev --app-version "$version" \
    --package "com.calimero.kv-store-$1" --output "$OUT_DIR/$1.mpk"
}

sed -i.bak "s/^min-runtime-version = .*/min-runtime-version = \"$MEROD_VERSION\"/; /^frontend = /d" "$manifest"
bundle frontend
sed -i.bak '/^frontend-dir = /d' "$manifest"
bundle plain
