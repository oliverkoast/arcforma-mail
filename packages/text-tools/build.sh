#!/bin/bash
# Builds "Arcforma Text.app" from the SwiftPM executable.
#
# Signing: prefers the local self-signed "Arcforma Dev" identity (created with
# scripts/make-identity.sh, the clipstack recipe). That gives a designated
# requirement pinned to the certificate rather than to the binary's cdhash, so
# the Accessibility grant survives rebuilds. Falls back to ad-hoc with a loud
# warning; there every rebuild invalidates the grant.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Arcforma Text.app"
IDENTITY="${ARCFORMA_SIGN_IDENTITY:-Arcforma Dev}"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/ArcformaText"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ArcformaText"
cp -R Resources/fonts "$APP/Contents/Resources/fonts"
cp Resources/arcforma-wordmark-ink.svg "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>                <string>Arcforma Text</string>
    <key>CFBundleDisplayName</key>         <string>Arcforma Text</string>
    <key>CFBundleIdentifier</key>          <string>ai.arcforma.text</string>
    <key>CFBundleExecutable</key>          <string>ArcformaText</string>
    <key>CFBundlePackageType</key>         <string>APPL</string>
    <key>CFBundleShortVersionString</key>  <string>0.1</string>
    <key>CFBundleVersion</key>             <string>1</string>
    <key>LSMinimumSystemVersion</key>      <string>14.0</string>
    <key>LSUIElement</key>                 <true/>
    <key>NSHighResolutionCapable</key>     <true/>
    <key>NSSupportsAutomaticTermination</key> <false/>
    <key>NSSupportsSuddenTermination</key>    <false/>
    <key>NSAccessibilityUsageDescription</key>
    <string>Arcforma Text reads the selected text in the app you are typing in and pastes the fixed version back over it.</string>
</dict>
</plist>
PLIST

# `security find-identity -v` lists only identities that pass trust evaluation,
# and a self-signed certificate shows CSSMERR_TP_NOT_TRUSTED, so the grep runs
# on the unfiltered listing. codesign itself signs with it fine.
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    codesign --force --sign "$IDENTITY" --timestamp=none "$APP" 2>&1 | sed 's/^/  codesign: /'
else
    echo "  codesign: WARNING identity '$IDENTITY' is not in the keychain; signing ad-hoc." >&2
    echo "  codesign: WARNING the Accessibility grant will NOT survive the next rebuild." >&2
    echo "  codesign: WARNING create the identity with scripts/make-identity.sh, then rebuild." >&2
    codesign --force --sign - --timestamp=none "$APP" 2>&1 | sed 's/^/  codesign: /'
fi
codesign -d -r- "$APP" 2>&1 | sed 's/^/  /'
echo "Built $APP"
