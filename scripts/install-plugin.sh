#!/usr/bin/env bash
#
# Installs this repository into the CCX GUI plugin that the IDE loads.
#
# The IDE never reads the repository: it loads a compiled plugin, and the chat
# interface is read out of lib/ccx-gui-*.jar through a descriptor opened at IDE
# startup (see HtmlLoader). So the repository stays the single source of truth
# and this script regenerates the installed plugin from it.
#
#   scripts/install-plugin.sh              webview only — build and swap the page into the installed jar
#   scripts/install-plugin.sh --no-build   webview only — install the existing webview/dist build
#   scripts/install-plugin.sh --full       whole plugin — gradle buildPlugin, then replace lib/ and ai-bridge
#   scripts/install-plugin.sh --all        install into every IDE that has the plugin, not just the one in use
#
# Use --full after touching Java or ai-bridge, or after pulling upstream commits
# that did. A frontend built from a newer commit than the installed Java half
# silently loses whatever needs both sides.
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST="$REPO_ROOT/webview/dist/index.html"
JETBRAINS="$HOME/Library/Application Support/JetBrains"
SHOULD_BUILD=1
INSTALL_ALL=0
INSTALL_FULL=0

for ARG in "$@"; do
    if [ "$ARG" = "--no-build" ]; then
        SHOULD_BUILD=0
    elif [ "$ARG" = "--all" ]; then
        INSTALL_ALL=1
    elif [ "$ARG" = "--full" ]; then
        INSTALL_FULL=1
    else
        echo "unknown argument: $ARG (expected --no-build, --full and/or --all)" >&2
        exit 2
    fi
done

# Old IDE versions leave their config behind after an upgrade, and their plugin
# copy is an older release whose Java half does not match this build. Newest
# mtime is the IDE actually in use; --all overrides that.
PLUGIN_DIRS=""
while IFS= read -r IDE_DIR; do
    FOUND=$(find "$IDE_DIR" -maxdepth 2 -type d -path '*/plugins/ccx-gui' 2>/dev/null)
    if [ -n "$FOUND" ]; then
        PLUGIN_DIRS="$PLUGIN_DIRS$FOUND"$'\n'
        if [ "$INSTALL_ALL" = "0" ]; then
            break
        fi
    fi
done < <(ls -dt "$JETBRAINS"/*/ 2>/dev/null)

if [ -z "${PLUGIN_DIRS// }" ]; then
    echo "no installed CCX GUI plugin found under $JETBRAINS" >&2
    exit 1
fi

if [ "$INSTALL_FULL" = "1" ]; then
    # The gradle wrapper needs a JDK 17 to run on, and local.properties only
    # configures the compilation toolchain — so resolve it here too.
    JDK_HOME=$(sed -n 's/^java\.home=//p' "$REPO_ROOT/local.properties" 2>/dev/null | head -1)
    if [ -z "$JDK_HOME" ]; then
        JDK_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
    fi
    if [ ! -x "$JDK_HOME/bin/java" ]; then
        echo "JDK 17 not found at $JDK_HOME — install it (brew install openjdk@17)" >&2
        echo "or point java.home in local.properties at your own copy." >&2
        exit 1
    fi

    echo "==> gradlew buildPlugin"
    (cd "$REPO_ROOT" && JAVA_HOME="$JDK_HOME" ./gradlew buildPlugin --console=plain)

    ZIP=$(ls -t "$REPO_ROOT"/build/distributions/ccx-gui-*.zip 2>/dev/null | head -1)
    if [ -z "$ZIP" ]; then
        echo "gradle produced no plugin zip under build/distributions" >&2
        exit 1
    fi

    STAGING=$(mktemp -d)
    unzip -q "$ZIP" -d "$STAGING"
    SOURCE="$STAGING/ccx-gui"

    while IFS= read -r PLUGIN_DIR; do
        if [ -z "$PLUGIN_DIR" ]; then
            continue
        fi

        BACKUP="$STAGING/backup-$(basename "$(dirname "$(dirname "$PLUGIN_DIR")")")"
        cp -R "$PLUGIN_DIR" "$BACKUP"

        # Replace lib/ whole: releases add dependencies, and the jar is named
        # after the version, so keeping the old one would load two copies.
        rm -rf "$PLUGIN_DIR/lib"
        cp -R "$SOURCE/lib" "$PLUGIN_DIR/lib"

        cp "$SOURCE/ai-bridge.zip" "$SOURCE/ai-bridge.hash" "$PLUGIN_DIR/"
        rm -rf "$PLUGIN_DIR/ai-bridge"
        # Release archives carry entries with backslash separators, which makes
        # unzip warn and exit 1 while still extracting correctly — the file check
        # below is what decides whether the extraction is usable.
        unzip -q "$PLUGIN_DIR/ai-bridge.zip" -d "$PLUGIN_DIR/ai-bridge" || true

        if [ ! -f "$PLUGIN_DIR/ai-bridge/channel-manager.js" ]; then
            echo "ai-bridge did not extract into $PLUGIN_DIR (backup: $BACKUP)" >&2
            exit 1
        fi

        INSTALLED_JAR=$(ls "$PLUGIN_DIR"/lib/ccx-gui-*.jar | head -1)
        ACTUAL_HASH=$(unzip -p "$INSTALLED_JAR" html/claude-chat.html | shasum -a 256 | cut -d ' ' -f 1)
        EXPECTED_HASH=$(shasum -a 256 "$REPO_ROOT/src/main/resources/html/claude-chat.html" | cut -d ' ' -f 1)
        if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
            echo "install verification failed for $INSTALLED_JAR (backup: $BACKUP)" >&2
            exit 1
        fi

        echo "==> installed $(basename "$ZIP") into $PLUGIN_DIR"
        echo "    previous plugin kept at $BACKUP"
    done <<< "$PLUGIN_DIRS"
else
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

    EXPECTED_HASH=$(shasum -a 256 "$DIST" | cut -d ' ' -f 1)

    while IFS= read -r PLUGIN_DIR; do
        if [ -z "$PLUGIN_DIR" ]; then
            continue
        fi

        JAR=$(ls "$PLUGIN_DIR"/lib/ccx-gui-*.jar | head -1)
        STAGING=$(mktemp -d)
        mkdir -p "$STAGING/html"
        cp "$DIST" "$STAGING/html/claude-chat.html"

        # Write a copy and move it into place: a running IDE holds the jar open,
        # and zipping into it directly corrupts the archive under the live descriptor.
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
    done <<< "$PLUGIN_DIRS"
fi

echo
echo "Done. Reopening the chat panel is NOT enough — the interface is read through a"
echo "descriptor opened at IDE startup. Toggle the plugin off and on in"
echo "Settings -> Plugins, or restart the IDE."
