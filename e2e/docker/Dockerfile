# Linux environment for the end-to-end tests, for development machines that cannot run them natively
# (macOS: WKWebView has no WebDriver, so tauri-driver only works on Linux and Windows). Mirrors the
# "core" job of .github/workflows/ci.yml. Used by e2e/docker/run.sh.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive GGML_NATIVE=OFF CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git build-essential pkg-config \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev webkit2gtk-driver \
      xvfb x11-utils libasound2-dev cmake clang libclang-dev libdbus-1-dev dbus \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.94.1 \
    && cargo install tauri-driver --locked
WORKDIR /repo
