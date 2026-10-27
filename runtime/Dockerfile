FROM node:24.22.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash git ripgrep build-essential python3 ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64 -o /usr/local/bin/herdr && echo '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d  /usr/local/bin/herdr' | sha256sum -c - && chmod 755 /usr/local/bin/herdr
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd && echo '8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55  /usr/local/bin/ttyd' | sha256sum -c - && chmod 755 /usr/local/bin/ttyd
COPY package.json package-lock.json /opt/agents/
RUN cd /opt/agents && npm ci --no-audit --no-fund && test "$(node_modules/.bin/codex --version)" = 'codex-cli 0.162.1' && test "$(node_modules/.bin/pi --version)" = '1.3.0'
RUN node --input-type=module -e 'import {openaiCodexOAuth} from "/opt/agents/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js"; if (typeof openaiCodexOAuth.refresh !== "function") process.exit(1)'
RUN curl -fsSL https://static.devin.ai/cli/3000.11.205/devin-3000.11.205-x86_64-unknown-linux.tar.gz -o /tmp/devin.tar.gz && echo '2e65c8b93682258fc91f5e4cead92e3698338cebf1b31dbc32a3201cb63705c4  /tmp/devin.tar.gz' | sha256sum -c - && mkdir /opt/devin-cli && tar -xzf /tmp/devin.tar.gz -C /opt/devin-cli && rm /tmp/devin.tar.gz && /opt/devin-cli/bin/devin --version
COPY helper.py /opt/substrate/
ENV PATH=/opt/devin-cli/bin:/opt/agents/node_modules/.bin:${PATH}
WORKDIR /workspace
ENTRYPOINT ["python3", "/opt/substrate/helper.py"]
CMD []
