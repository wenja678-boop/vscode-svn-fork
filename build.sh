#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# Step 1: Package the VSCode extension into a VSIX file
echo "Packaging the VSCode extension..."
vsce package

# Step 2: Install the packaged extension into VSCode
echo "Installing the extension into VSCode..."
cursor --install-extension *.vsix

echo "Extension installed successfully!" 