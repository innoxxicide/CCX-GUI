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
# Runs on macOS, Linux and Windows (Git Bash / MSYS). On Windows the IDE keeps a
# handle on the plugin directories while it runs, so the script refills existing
# directories instead of recreating them; close the IDE if a copy still fails.
#
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST="$REPO_ROOT/webview/dist/index.html"
SHOULD_BUILD=1
INSTALL_ALL=0
INSTALL_FULL=0

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
    Darwin*)              PLATFORM=macos ;;
    *)                    PLATFORM=linux ;;
esac

# Where the IDE keeps per-version configuration, and with it the plugins it
# installed itself. Each platform puts it somewhere different.
case "$PLATFORM" in
    windows) JETBRAINS=$(cygpath -u "${APPDATA:-$HOME/AppData/Roaming}")/JetBrains ;;
    macos)   JETBRAINS="$HOME/Library/Application Support/JetBrains" ;;
    linux)   JETBRAINS="${XDG_DATA_HOME:-$HOME/.local/share}/JetBrains" ;;
esac

# Native path for the Windows executables in the JDK — they cannot read the
# /c/... form Git Bash hands out. A no-op everywhere else.
to_native() {
    if [ "$PLATFORM" = "windows" ]; then
        cygpath -m "$1"
    else
        printf '%s' "$1"
    fi
}

# macOS ships shasum, most Linux images only sha256sum, Git Bash has both.
# Called with a file argument and with no argument at all (reading a pipe).
sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$@" | cut -d ' ' -f 1
    else
        sha256sum "$@" | cut -d ' ' -f 1
    fi
}

# The gradle wrapper needs a JDK 17 to run on, and local.properties only
# configures the compilation toolchain — so resolve it here too.
JDK_HOME=""
resolve_jdk() {
    if [ -n "$JDK_HOME" ]; then
        return
    fi

    local configured
    configured=$(sed -n 's/^java\.home=//p' "$REPO_ROOT/local.properties" 2>/dev/null | head -1)
    # local.properties is a java .properties file, so its backslashes are escaped.
    configured=${configured//\\\\/\\}

    if [ -z "$configured" ]; then
        configured="${JAVA_HOME:-}"
    fi
    if [ -z "$configured" ]; then
        case "$PLATFORM" in
            macos)   configured=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ;;
            linux)   configured=/usr/lib/jvm/java-17-openjdk ;;
            windows) configured="C:/Program Files/Eclipse Adoptium/jdk-17" ;;
        esac
    fi

    JDK_HOME=$(to_native "$configured")

    if [ ! -x "$JDK_HOME/bin/java" ]; then
        echo "JDK 17 not found at $JDK_HOME — install it" >&2
        case "$PLATFORM" in
            macos)   echo "(brew install openjdk@17)" >&2 ;;
            windows) echo "(winget install EclipseAdoptium.Temurin.17.JDK)" >&2 ;;
            linux)   echo "(apt install openjdk-17-jdk)" >&2 ;;
        esac
        echo "or point java.home in local.properties at your own copy." >&2
        exit 1
    fi
}

# Add the built page to a jar. Git Bash has no zip(1), so fall back to the jar
# tool from the JDK, which is guaranteed to be there anyway.
add_page_to_jar() {
    local jar=$1 staging=$2
    if command -v zip >/dev/null 2>&1; then
        (cd "$staging" && zip -q "$jar" html/claude-chat.html)
    else
        resolve_jdk
        "$JDK_HOME/bin/jar" uf "$(to_native "$jar")" -C "$(to_native "$staging")" html/claude-chat.html
    fi
}

# Refill a directory instead of recreating it. Windows refuses to remove a
# directory the running IDE holds a handle on, even when every file inside it
# can be replaced, so deleting the contents is as far as this may go.
refill_dir() {
    local dest=$1
    mkdir -p "$dest"
    find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || {
        echo "could not clear $dest — close the IDE and re-run" >&2
        exit 1
    }
}

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
    resolve_jdk

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
        refill_dir "$PLUGIN_DIR/lib"
        cp -R "$SOURCE/lib/." "$PLUGIN_DIR/lib/"

        cp "$SOURCE/ai-bridge.zip" "$SOURCE/ai-bridge.hash" "$PLUGIN_DIR/"
        refill_dir "$PLUGIN_DIR/ai-bridge"
        # Release archives carry entries with backslash separators, which makes
        # unzip warn and exit 1 while still extracting correctly — the file check
        # below is what decides whether the extraction is usable.
        unzip -q "$PLUGIN_DIR/ai-bridge.zip" -d "$PLUGIN_DIR/ai-bridge" || true

        if [ ! -f "$PLUGIN_DIR/ai-bridge/channel-manager.js" ]; then
            echo "ai-bridge did not extract into $PLUGIN_DIR (backup: $BACKUP)" >&2
            exit 1
        fi

        INSTALLED_JAR=$(ls "$PLUGIN_DIR"/lib/ccx-gui-*.jar | head -1)
        ACTUAL_HASH=$(unzip -p "$INSTALLED_JAR" html/claude-chat.html | sha256)
        EXPECTED_HASH=$(sha256 "$REPO_ROOT/src/main/resources/html/claude-chat.html")
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

    EXPECTED_HASH=$(sha256 "$DIST")

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
        add_page_to_jar "$JAR.new" "$STAGING"
        mv "$JAR.new" "$JAR"
        rm -rf "$STAGING"

        ACTUAL_HASH=$(unzip -p "$JAR" html/claude-chat.html | sha256)
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
