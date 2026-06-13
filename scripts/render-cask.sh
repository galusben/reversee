#!/bin/sh
# Renders the Homebrew cask for a given version + dmg checksums.
# Usage: render-cask.sh <version> <arm64_sha256> <intel_sha256>
set -eu

VERSION="$1"
ARM_SHA="$2"
INTEL_SHA="$3"

cat <<EOF
cask "reversee" do
  arch arm: "-arm64", intel: ""

  version "${VERSION}"
  sha256 arm:   "${ARM_SHA}",
         intel: "${INTEL_SHA}"

  url "https://github.com/galusben/reversee/releases/download/v#{version}/Reversee-#{version}#{arch}.dmg"
  name "Reversee"
  desc "Reverse-proxy web debugger"
  homepage "https://github.com/galusben/reversee"

  auto_updates true

  app "Reversee.app"
  # Puts `reversee` on PATH so agents can run it headless:
  #   reversee --headless --allow-mcp-control
  binary "#{appdir}/Reversee.app/Contents/MacOS/Reversee", target: "reversee"

  zap trash: [
    "~/Library/Application Support/Reversee",
    "~/Library/Logs/Reversee",
    "~/Library/Preferences/ninja.reversee.plist",
    "~/Library/Saved Application State/ninja.reversee.savedState",
  ]
end
EOF
