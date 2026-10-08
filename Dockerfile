# ─── Red Dog — Azure Container Apps / Standard Docker ────────────────────────
# Build context: Agents/Red Dog/Red Dog/
#
# The @agentic-ag/service-bus-client dependency is a local file: reference.
# To build correctly, copy the shared library into the Docker context first:
#
#   # One-time: build from project root
#   docker build \
#     -f "Agents/Red Dog/Red Dog/Dockerfile" \
#     -t reddog:latest \
#     "Agents/Red Dog/Red Dog"
#
#   # OR: copy the shared lib into this directory first
#   cp -r "../../../Backend/Azure IoT Hub Service Bus" ./vendor/service-bus-client
#
# See Dockerfile.iotedge for multi-arch IoT Edge builds.

FROM node:22-alpine AS builder

WORKDIR /app

# Copy vendor shared library if present (CI pipeline copies it here)
# Falls back gracefully if not present — npm ci will use the file: path
COPY vendor/ ./vendor/ 2>/dev/null || true

COPY package*.json ./

# Rewrite file: reference to vendored path if vendor/ exists
RUN if [ -d "vendor/service-bus-client" ]; then \
      node -e " \
        const fs = require('fs'); \
        const pkg = JSON.parse(fs.readFileSync('package.json','utf8')); \
        pkg.dependencies['@agentic-ag/service-bus-client'] = 'file:./vendor/service-bus-client'; \
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2)); \
      "; \
    fi

RUN npm ci --omit=dev

COPY src/ ./src/

# ─── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src          ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/vendor       ./vendor 2>/dev/null || true

RUN addgroup -g 1001 -S nodejs && \
    adduser  -S reddog -u 1001 -G nodejs && \
    chown -R reddog:nodejs /app

USER reddog

ENV API_PORT=3001
ENV GATEWAY_PORT=18789
EXPOSE 3001
EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:${API_PORT}/health 2>/dev/null || exit 1

CMD ["node", "src/reddog/index.js"]
