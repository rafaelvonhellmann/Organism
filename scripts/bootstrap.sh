#!/usr/bin/env bash
# Organism Bootstrap — Week 1 Setup
# Run once from the Organism root directory.
# Requires: Node.js 20+, pnpm, Python 3.11+

set -euo pipefail

echo "=== Organism Bootstrap ==="
echo ""

# 1. Node packages
echo "Installing Node packages..."
pnpm install

# 2. State directory
echo "Creating state directory..."
mkdir -p "${HOME}/.organism/state" e2e/screenshots

# 3. Copy env file if not present
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env — fill in your API keys before running agents."
fi

# 4. Python MCP sidecar
echo "Setting up Python MCP sidecar..."
cd packages/mcp-sidecar
python -m venv venv
./venv/Scripts/activate.bat 2>/dev/null || source venv/bin/activate 2>/dev/null || true
pip install -r requirements.txt -q
cd ../..

# 5. Initialize database
echo "Initializing database..."
pnpm run migrate

# 6. Health check
echo ""
echo "Running health check..."
pnpm run health-check

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "Next steps:"
echo "  1. Fill in API keys in .env"
echo "  2. Start dashboard: pnpm run dashboard"
echo "  3. Run certification: pnpm run smoke-test"
