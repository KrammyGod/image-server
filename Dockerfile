# Ubuntu 24.04 @ 2026-08-06
ARG UBUNTU_VERSION="24.04"
ARG SHASUM="sha256:b17516cd982bf06bdd5d5600253d12a8de017b9eb831cc052b532a0363d294f9"

FROM ubuntu:${UBUNTU_VERSION}@${SHASUM}
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

# Links the published package to this repo in the registry UI.
LABEL org.opencontainers.image.source=https://github.com/KrammyGod/image-server

# Only what fetching and verifying the NodeSource repository needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Install NodeJS
ARG NODE_MAJOR=24
ARG NODE_VERSION=24.19.0
ARG NPM_VERSION=11.19.0

RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    nodejs="${NODE_VERSION}"-1nodesource1 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@${NPM_VERSION} \
  && npm cache clean --force

# Create user and group
RUN groupadd -g 2000 -r node \
  && useradd -u 2000 -r -m -g node node

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=5000
EXPOSE 5000

USER node

CMD ["node", "."]
