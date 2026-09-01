#!/usr/bin/env bash
#
# Builds the webview and installs it into the CCX GUI plugin that the IDE loads.
#
# The IDE never reads this repository: it loads a compiled plugin, and the chat
# interface is read out of lib/ccx-gui-*.jar through a descriptor opened at IDE
# startup (see HtmlLoader). So the repository stays the single source of truth
# and this script regenerates the installed jar from it.
#
#   scripts/install-plugin.sh              build, then install into the IDE used last
#   scripts/install-plugin.sh --no-build   install the existing webview/dist build
#   scripts/install-plugin.sh --all        install into every IDE that has the plugin
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST="$REPO_ROOT/webview/dist/index.html"
JETBRAINS="$HOME/Library/Application Support/JetBrains"
SHOULD_BUILD=1
INSTALL_ALL=0

for ARG in "$@"; do
    if [ "$ARG" = "--no-build" ]; then
        SHOULD_BUILD=0
    elif [ "$ARG" = "--all" ]; then
        INSTALL_ALL=1
    else
        echo "unknown argument: $ARG (expected --no-build and/or --all)" >&2
        exit 2
    fi
done

if [ "$SHOULD_BUILD" = "1" ]; then
    cd "$REPO_ROOT/webview"
    if [ ! -d node_modules ]; then
        echo "==> npm install"
        npm install
    fi
    echo "==> npm run build"
    npm run build
fi

if [ ! -f "$DIST" ]; then
    echo "no build to install: $DIST is missing (drop --no-build)" >&2
    exit 1
fi

# Old IDE versions leave their config behind after an upgrade, and their plugin
# copy is an older release whose Java side does not match this frontend. Newest
# mtime is the IDE actually in use; --all overrides that.
TARGET_JARS=""
while IFS= read -r IDE_DIR; do
    JARS=$(find "$IDE_DIR" -maxdepth 4 -path '*/plugins/ccx-gui/lib/ccx-gui-*.jar' 2>/dev/null)
    if [ -n "$JARS" ]; then
        TARGET_JARS="$TARGET_JARS$JARS"$'\n'
        if [ "$INSTALL_ALL" = "0" ]; then
            break
        fi
    fi
done < <(ls -dt "$JETBRAINS"/*/ 2>/dev/null)

if [ -z "${TARGET_JARS// }" ]; then
    echo "no installed CCX GUI plugin found under $JETBRAINS" >&2
    exit 1
fi

EXPECTED_HASH=$(shasum -a 256 "$DIST" | cut -d ' ' -f 1)

while IFS= read -r JAR; do
    if [ -z "$JAR" ]; then
        continue
    fi

    STAGING=$(mktemp -d)
    mkdir -p "$STAGING/html"
    cp "$DIST" "$STAGING/html/claude-chat.html"

    # Write a copy and move it into place: a running IDE holds the jar open, and
    # zipping into it directly corrupts the archive under the live descriptor.
    cp "$JAR" "$JAR.new"
    (cd "$STAGING" && zip -q "$JAR.new" html/claude-chat.html)
    mv "$JAR.new" "$JAR"
    rm -rf "$STAGING"

    ACTUAL_HASH=$(unzip -p "$JAR" html/claude-chat.html | shasum -a 256 | cut -d ' ' -f 1)
    if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
        echo "install verification failed for $JAR" >&2
        exit 1
    fi

    echo "==> installed into $JAR"
done <<< "$TARGET_JARS"

echo
echo "Done. Reopening the chat panel is NOT enough — the interface is read through a"
echo "descriptor opened at IDE startup. Toggle the plugin off and on in"
echo "Settings -> Plugins, or restart the IDE."
