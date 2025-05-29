#!/bin/bash

# 先删除现有的*.vsix文件
echo "正在清理旧的vsix文件..."
if ls *.vsix 1> /dev/null 2>&1; then
    rm *.vsix
    echo "旧的vsix文件已删除"
else
    echo "没有找到vsix文件，无需清理"
fi

# Exit immediately if a command exits with a non-zero status.
set -e

# Step 1: Package the VSCode extension into a VSIX file
echo "Packaging the VSCode extension..."
vsce package

# Step 2: Install the packaged extension into VSCode
echo "Installing the extension into VSCode..."
cursor --install-extension *.vsix --force
echo "Extension installed successfully!" 