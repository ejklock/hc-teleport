FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS hc-build

# herdr-core publishes tags and no release assets, so hc is built from the
# pinned tag; Zig builds the terminal library its build script needs.
ARG TARGETARCH
ARG HC_TAG=v0.1.19
ARG HC_COMMIT=06793ede1bedb1fed8d22d3cae476d3eb239edf0
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256_AMD64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ARG ZIG_SHA256_ARM64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) zig_arch=x86_64; zig_sha="${ZIG_SHA256_AMD64}" ;; \
      arm64) zig_arch=aarch64; zig_sha="${ZIG_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/zig.tar.xz "https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz"; \
    echo "${zig_sha}  /tmp/zig.tar.xz" | sha256sum -c -; \
    mkdir /opt/zig; \
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
    rm /tmp/zig.tar.xz

RUN git clone --branch "${HC_TAG}" --depth 1 https://github.com/herdrdev/herdr-core.git /src

WORKDIR /src
RUN test "$(git rev-parse HEAD)" = "${HC_COMMIT}" \
    && git submodule update --init --depth 1

ENV PATH="/opt/zig:${PATH}"
RUN cargo build --release --locked -p herdr-core


FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server openssh-client git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd /Volumes/Developer/www/test-org \
    && chmod 1777 /Volumes/Developer/www/test-org

COPY --from=hc-build /src/target/release/herdr-core /usr/local/bin/herdr-core
RUN ln -s herdr-core /usr/local/bin/hc

COPY --chmod=0755 fake-claude /usr/local/bin/claude
COPY --chmod=0755 claude-klock /usr/local/bin/claude-klock

# One machine per container: the user, home and role come from the
# environment, so the Mac and the box differ only by how they are started.
COPY --chmod=0755 <<'EOF' /usr/local/bin/bed-entrypoint
#!/bin/sh
set -eu
useradd --create-home --home-dir "$BED_HOME" --shell /bin/bash "$BED_USER"
usermod --password '*' "$BED_USER"
ssh-keygen -A
ssh_dir="$BED_HOME/.ssh"
install -d -m 700 -o "$BED_USER" -g "$BED_USER" "$ssh_dir"
case "$BED_ROLE" in
  source)
    install -m 600 -o "$BED_USER" -g "$BED_USER" /run/bed/key "$ssh_dir/id_ed25519"
    cat > "$ssh_dir/config" <<CONFIG
Host dest
  User box
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
CONFIG
    chown "$BED_USER:$BED_USER" "$ssh_dir/config"
    ;;
  dest)
    install -m 600 -o "$BED_USER" -g "$BED_USER" /run/bed/key.pub "$ssh_dir/authorized_keys"
    ;;
  *)
    echo "unknown BED_ROLE: $BED_ROLE" >&2
    exit 1
    ;;
esac
exec /usr/sbin/sshd -D -e
EOF

ENTRYPOINT ["/usr/local/bin/bed-entrypoint"]
