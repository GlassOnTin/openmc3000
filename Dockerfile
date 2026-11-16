FROM node:22-bookworm-slim

ARG BUILD_VERSION
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="aarch64|amd64"

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ble \
    && /opt/ble/bin/pip install --no-cache-dir bleak==0.22.3
ENV BLE_PYTHON=/opt/ble/bin/python
COPY package.json ./
COPY bridge/package.json bridge/package-lock.json ./bridge/
RUN cd bridge && npm ci --omit=dev
COPY bridge/ ./bridge/
COPY src/ ./src/
CMD ["node", "--experimental-strip-types", "bridge/addon.mjs"]
