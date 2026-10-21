#!/usr/bin/env bash
# Build, test and install the native ClaudeRipple menu-bar app (apps/macos).
#
#   apps/macos/build.sh gen       regenerate ClaudeRipple.xcodeproj from project.yml (XcodeGen)
#   apps/macos/build.sh test      run the RippleKit unit tests (swift test)
#   apps/macos/build.sh build     Release build into $BUILD_DIR (default /tmp/clauderipple-mac-build)
#   apps/macos/build.sh install   build, copy to /Applications, launch
#   apps/macos/build.sh open      open the project in Xcode
#
# Signing: the first code-signing identity in the keychain is used if there is one (a free Apple
# Development certificate is enough; the app is not sandboxed, so no provisioning profile). Without
# one the build is unsigned, which runs locally but cannot post native notifications.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/clauderipple-mac-build}"
APP_NAME="ClaudeRipple"
SCHEME="RippleMac"

need_xcodegen() {
  command -v xcodegen >/dev/null || {
    echo "XcodeGen is missing: brew install xcodegen" >&2
    exit 1
  }
}

gen() {
  need_xcodegen
  (cd "$HERE" && xcodegen generate --quiet)
}

signing_args() {
  local id
  id="$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '[0-9A-F]{40}' | head -1 || true)"
  if [[ -n "$id" ]]; then
    echo "CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=$id PROVISIONING_PROFILE_SPECIFIER="
  else
    echo "CODE_SIGNING_ALLOWED=NO"
  fi
}

build() {
  gen
  # shellcheck disable=SC2046 # the signing settings are separate words on purpose
  xcodebuild -project "$HERE/$APP_NAME.xcodeproj" -scheme "$SCHEME" -configuration Release \
    -derivedDataPath "$BUILD_DIR/derived" $(signing_args) -quiet build
  echo "$BUILD_DIR/derived/Build/Products/Release/$APP_NAME.app"
}

case "${1:-build}" in
  gen) gen ;;
  test) (cd "$HERE/RippleKit" && swift test --scratch-path "$BUILD_DIR/spm") ;;
  build) build ;;
  install)
    app="$(build | tail -1)"
    osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$app" /Applications/
    open "/Applications/$APP_NAME.app"
    echo "Installed /Applications/$APP_NAME.app"
    ;;
  open) gen && open "$HERE/$APP_NAME.xcodeproj" ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
