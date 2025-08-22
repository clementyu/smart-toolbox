#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "--- Starting NFC Library Management System Setup ---"

# Update package list
sudo apt-get update

# Install curl to download nvm
echo "--- Installing curl ---"
sudo apt-get install curl -y

# --- NVM (Node Version Manager) Installation ---
echo "--- Installing NVM (Node Version Manager) ---"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# Source nvm script to make it available in the current shell session
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# --- Node.js Installation ---
echo "--- Installing Node.js v22 ---"
nvm install 22

echo "--- Setting Node.js v22 as the default version ---"
nvm alias default 22
nvm use default

# --- Project Dependency Installation ---
echo "--- Installing required npm modules ---"
npm install
echo "You can now run the application with: node index.js"
