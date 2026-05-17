#!/bin/bash
set -e

echo "=== KB Knowledge Base Setup ==="
echo ""

# Check deps
command -v node >/dev/null 2>&1 || { echo "❌ Need Node.js >= 20. Install: https://nodejs.org"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ Need pnpm. Install: npm install -g pnpm@9"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "❌ Need Python 3.10+. Install: brew install python3"; exit 1; }

echo "✅ Node $(node -v), pnpm $(pnpm -v), Python $(python3 --version)"

# Install Node deps
echo ""
echo "📦 Installing Node dependencies..."
pnpm install

# Install Python deps for clustering
echo ""
echo "📦 Installing Python dependencies (umap, hdbscan, scikit-learn)..."
pip3 install -q umap-learn hdbscan scikit-learn numpy 2>/dev/null || \
  pip3 install -q --break-system-packages umap-learn hdbscan scikit-learn numpy

# Config
DATA_DIR="${KB_DATA_DIR:-$HOME/kb_data}"
echo ""
echo "📂 Data directory: $DATA_DIR"
mkdir -p "$DATA_DIR"

# .env template
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️  Edit .env with your LLM and embedding API keys before starting."
  echo "   LLM_BASE_URL=   (e.g. https://api.deepseek.com)"
  echo "   LLM_API_KEY=    (your API key)"
  echo "   EMBEDDING_BASE_URL=  (e.g. https://api.siliconflow.cn/v1)"
  echo "   EMBEDDING_API_KEY=   (your API key)"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "To start:  pnpm start"
echo "Server:    http://localhost:7823"
echo "Health:    curl http://localhost:7823/api/health"
echo ""
echo "=== Agent Integration ==="
echo "Any agent (Hermes / Claude Code / OpenClaw) connects via REST API:"
echo ""
echo "1. Register: POST /api/agent/create"
echo '   {"agent_id":"my-agent","permissions":["read","write","structural","admin"]}'
echo "   → Returns api_key"
echo ""
echo "2. Onboard:   POST /api/agent/invoke"
echo '   {"agent_id":"my-agent","api_key":"...","tool_name":"agent_onboarding"}'
echo "   → Returns KB snapshot + quick-start guide"
echo ""
echo "3. Start working: suggest_context → deep_analyze → create_reflection"
