#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PACKAGE="$ROOT/macos/ScreenCaptureCollector"
CONFIGURATION=${CONFIGURATION:-release}
APP="$ROOT/macos/build/ScreenCaptureCollector.app"

swift build --package-path "$PACKAGE" --configuration "$CONFIGURATION"
BIN=$(swift build --package-path "$PACKAGE" --configuration "$CONFIGURATION" --show-bin-path)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN/ScreenCaptureCollector" "$APP/Contents/MacOS/ScreenCaptureCollector"
chmod 755 "$APP/Contents/MacOS/ScreenCaptureCollector"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Screen Capture Collector</string>
	<key>CFBundleExecutable</key>
	<string>ScreenCaptureCollector</string>
	<key>CFBundleIdentifier</key>
	<string>com.my-discord-agent.screen-capture-collector</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>ScreenCaptureCollector</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

echo "Built $APP"
echo "Launch with: open '$APP'"
