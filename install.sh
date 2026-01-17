#!/bin/bash
set -e

CLAUDEX_DIR="$HOME/.claudex"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building claudex-server..."
cd "$SCRIPT_DIR/server"
go build -o "$CLAUDEX_DIR/claudex-server" .

# Copy web files
echo "Copying web files..."
rm -rf "$CLAUDEX_DIR/web"
cp -r "$SCRIPT_DIR/web" "$CLAUDEX_DIR/web"

# Create config if not exists
if [ ! -f "$CLAUDEX_DIR/config.json" ]; then
    echo '{"port": 9090}' > "$CLAUDEX_DIR/config.json"
    echo "Created default config.json"
fi

# Create sessions dir if not exists
mkdir -p "$CLAUDEX_DIR/sessions"

# Install launchd service
PLIST="$HOME/Library/LaunchAgents/com.claudex.server.plist"
cat > "$PLIST" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claudex.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>CLAUDEX_DIR/claudex-server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>CLAUDEX_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>CLAUDEX_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>CLAUDEX_DIR/server.log</string>
</dict>
</plist>
EOF

# Replace placeholder with actual path
sed -i '' "s|CLAUDEX_DIR|$CLAUDEX_DIR|g" "$PLIST"

# Reload service
echo "Reloading service..."
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Done! Server running at http://localhost:$(grep -o '"port":[^,}]*' "$CLAUDEX_DIR/config.json" | grep -o '[0-9]*')"
