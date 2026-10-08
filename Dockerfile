# syntax=docker/dockerfile:1
# Multi-stage build for Hotlap: build the web GUI, build the Rust binary, then
# ship a slim runtime that serves both on 0.0.0.0:8080 (reachable on the LAN).

# 1) Build the web GUI (outputs /web/dist, which the server serves)
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) Build the Rust release binary
FROM rust:1-bookworm AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p hotlap-cli

# 3) Runtime
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/target/release/hotlap /usr/local/bin/hotlap
COPY --from=web /web/dist /app/web/dist
ENV HOTLAP_WEB_DIR=/app/web/dist
# Historical downloads are cached here; mount a volume to persist them.
VOLUME ["/root/.cache/hotlap"]
EXPOSE 8080
# Binds all interfaces so other devices on the LAN can reach it.
CMD ["hotlap", "serve", "--no-open", "--addr", "0.0.0.0:8080"]
