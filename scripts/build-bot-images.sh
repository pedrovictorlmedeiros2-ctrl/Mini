#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_TAG="${CONTAINER_IMAGE_NODE:-atlantic-host-node:22}"
PY_TAG="${CONTAINER_IMAGE_PYTHON:-atlantic-host-python:3.12}"

echo ">>> Building $NODE_TAG"
docker build -t "$NODE_TAG" "$ROOT/docker/bot-node"

echo ">>> Building $PY_TAG"
docker build -t "$PY_TAG" "$ROOT/docker/bot-python"

echo ">>> Done. Set in .env:"
echo "CONTAINER_IMAGE_NODE=$NODE_TAG"
echo "CONTAINER_IMAGE_PYTHON=$PY_TAG"
