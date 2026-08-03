FROM docker.io/library/node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        coreutils \
        curl \
        findutils \
        git \
        python3 \
        ripgrep \
        tar \
        unzip \
    && npm install --global pnpm@9.15.4 \
    && rm -rf /var/lib/apt/lists/*

COPY bridge.mjs /usr/local/lib/qqbot-workspace/bridge.mjs

RUN mkdir -p /workspace \
    && chmod 0755 /usr/local/lib/qqbot-workspace/bridge.mjs

WORKDIR /workspace

LABEL io.qqbot.workspace-runtime="v1"

CMD ["sleep", "infinity"]
