FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.142.5
ENV CODEX_HOME=/home/codex/.codex

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-client \
      openssh-server \
      procps \
      tmux \
 && rm -f /etc/ssh/ssh_host_* \
 && npm install --global "@openai/codex@${CODEX_VERSION}" \
 && useradd --create-home --home-dir /home/codex --shell /bin/bash --password NP codex \
 && install -d -m 0700 -o codex -g codex /home/codex/.ssh /home/codex/.codex \
 && install -d -m 0700 -o codex -g codex /home/codex/projects \
 && install -d -m 0700 -o root -g root /var/lib/ssh-host-keys \
 && rm -rf /var/lib/apt/lists/*

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/ssh-worker-entrypoint
RUN chmod 0755 /usr/local/bin/ssh-worker-entrypoint

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/ssh-worker-entrypoint"]
