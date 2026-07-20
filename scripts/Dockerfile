# ── Inkwell AppImage builder ──────────────────────────────────────────────────
# Builds a self-contained AppImage with Electron bundled inside.
# Usage:
#   docker build -t inkwell-builder .
#   docker run --rm -v "$(pwd)/dist:/app/dist" inkwell-builder
#
FROM node:20-bullseye-slim

# System deps for electron-builder + AppImage
RUN apt-get update && apt-get install -y \
    git curl fuse libfuse2 \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libx11-xcb1 libxcb-dri3-0 libxcomposite1 \
    libxcursor1 libxdamage1 libxfixes3 libxi6 \
    libxrandr2 libxrender1 libxss1 libxtst6 \
    libasound2 libpangocairo-1.0-0 libpango1.0-0 \
    libgdk-pixbuf2.0-0 libgtk-3-0 libgbm1 \
    ca-certificates unzip \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# Install all deps including electron binary
RUN npm install

COPY . .

# Build AppImage
ENV ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true
RUN npx electron-builder --linux AppImage --x64

CMD ["sh", "-c", "echo '✓ Build completata: dist/*.AppImage' && ls dist/*.AppImage"]
