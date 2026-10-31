# Server image for Cloud Run. Build from the repo root (the server reads ../deployments):
#   docker build -f server/Dockerfile -t hidroreais-api .
FROM node:24-slim
WORKDIR /app
COPY deployments ./deployments
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY server ./server
WORKDIR /app/server
# State lives on a Cloud Storage volume mounted here; secrets and settings come from the service env.
ENV DATA_DIR=/data
CMD ["npx", "tsx", "src/index.ts"]
