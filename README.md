# Solvent AI

Desktop AI assistant with multi-provider support, RAG pipeline, and coding tools.

## Quick Start

### Prerequisites
- Node.js 20+
- npm

### Setup

```bash
# 1. Install dependencies
npm install
cd frontend && npm install && cd ..
cd backend && npm install && cd ..

# 2. Configure environment
cp .env.example .env
# Edit .env and add your API keys

# 3. Generate a secure session secret
npm run generate-secret
# Copy the output into BACKEND_INTERNAL_SECRET in your .env

# 4. Run the app
npm run dev
```

The frontend will be at http://localhost:5173 and the backend at http://localhost:3001.

### Desktop Mode (Electron)

```bash
npm run desktop
```

### Full Desktop Launch (starts backend + frontend + electron)

**Linux/Mac:**
```bash
./start.sh
```

**Windows:**
```bat
start.bat
```

## Production Build

**Linux/Mac:**
```bash
./build-release.sh
```

**Windows:**
```bat
build-release.bat
```

Output goes to the `release/` directory.

## Providers

Configure which AI providers to use in `backend/settings.json`. Supported:
- Groq
- Fireworks
- OpenRouter
- DashScope (Qwen)
- Cerebras
- DeepSeek
- Gemini
- Ollama (local)
- HuggingFace

At least one provider API key is needed in your `.env`.

## Platform Support

Runs on Linux, macOS, and Windows. Cross-platform scripts and platform detection are built in.
