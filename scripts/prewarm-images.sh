#!/bin/sh
# Pré-aquece imagens Docker usadas pelos bots (evita pull no primeiro start)
set -e
NODE_IMG="${CONTAINER_IMAGE_NODE:-node:22-alpine}"
PY_IMG="${CONTAINER_IMAGE_PYTHON:-python:3.12-slim}"

echo ">>> Pull $NODE_IMG"
docker pull "$NODE_IMG"
echo ">>> Pull $PY_IMG"
docker pull "$PY_IMG"
echo ">>> Imagens prontas."
