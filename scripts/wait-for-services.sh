#!/usr/bin/env bash
set -euo pipefail

echo "Waiting for MongoDB..."
for i in $(seq 1 30); do
  if docker compose exec -T mongo mongosh --quiet --eval "db.adminCommand('ping').ok" >/dev/null 2>&1; then
    echo "  MongoDB ready"
    break
  fi
  [ "$i" -eq 30 ] && { echo "  MongoDB FAILED"; exit 1; }
  sleep 2
done

echo "Waiting for MinIO..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9000/minio/health/live >/dev/null 2>&1; then
    echo "  MinIO ready"
    break
  fi
  [ "$i" -eq 30 ] && { echo "  MinIO FAILED"; exit 1; }
  sleep 2
done

echo "Waiting for MinIO bucket..."
for i in $(seq 1 30); do
  if docker compose run --rm --entrypoint sh createbuckets -c \
    "mc alias set local http://minio:9000 wardrobe wardrobe123 >/dev/null 2>&1 && mc ls local/wardrobe-items >/dev/null 2>&1" \
    >/dev/null 2>&1; then
    echo "  MinIO bucket ready"
    break
  fi
  [ "$i" -eq 30 ] && { echo "  MinIO bucket FAILED"; exit 1; }
  sleep 2
done

echo "All services ready."
