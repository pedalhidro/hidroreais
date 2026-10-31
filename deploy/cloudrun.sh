#!/usr/bin/env bash
# Moves the API server from this machine to Cloud Run (scale to zero, one instance at most),
# keeping https://dimdim-api.pedalhidrografi.co. Run from the repo root, one phase at a time:
#   deploy/cloudrun.sh prepare   # image, state bucket, secrets: nothing changes for members
#   deploy/cloudrun.sh switch    # stops the local server, copies its state, starts Cloud Run
#   deploy/cloudrun.sh domain    # points dimdim-api at Cloud Run (delete its DNS record first)
#   deploy/cloudrun.sh update    # later: ship a new server version
set -euo pipefail

PROJECT=pedal-hidrografico
REGION=southamerica-east1
SERVICE=hidroreais-api
BUCKET=$PROJECT-hidroreais-data
REPO=hidroreais
IMAGE=$REGION-docker.pkg.dev/$PROJECT/$REPO/api:$(git rev-parse --short HEAD)
ENV_FILE=server/.env
SECRETS=(PIMLICO_API_KEY RELAYER_PRIVATE_KEY ADMIN_TOKEN VAPID_PRIVATE_KEY)

val() { grep -E "^$1=" "$ENV_FILE" | cut -d= -f2-; }
secret_name() { echo "$1" | tr 'A-Z_' 'a-z-'; }

build_and_push() {
  docker build -f server/Dockerfile -t "$IMAGE" .
  docker push "$IMAGE"
}

deploy_service() {
  local secrets="" s
  for s in "${SECRETS[@]}"; do secrets+="$s=$(secret_name "$s"):latest,"; done
  # ^|^ makes "|" the separator, because ALLOWED_ORIGIN itself contains commas.
  gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
    --execution-environment gen2 --min-instances 0 --max-instances 1 --cpu 1 --memory 512Mi \
    --allow-unauthenticated \
    --add-volume name=data,type=cloud-storage,bucket="$BUCKET" --add-volume-mount volume=data,mount-path=/data \
    --set-env-vars "^|^CHAIN_ID=$(val CHAIN_ID)|RPC_URL=$(val RPC_URL)|ALLOWED_ORIGIN=$(val ALLOWED_ORIGIN)|VAPID_PUBLIC_KEY=$(val VAPID_PUBLIC_KEY)|VAPID_SUBJECT=$(val VAPID_SUBJECT)|MAX_OPS_PER_DAY=$(val MAX_OPS_PER_DAY)|MAX_RELAYS_PER_DAY=$(val MAX_RELAYS_PER_DAY)|DATA_DIR=/data" \
    --set-secrets "${secrets%,}"
}

service_url() { gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)'; }

case "${1:-}" in
  prepare)
    gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
      cloudscheduler.googleapis.com --project "$PROJECT"
    gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||
      gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION" --project "$PROJECT"
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
    build_and_push
    gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 ||
      gcloud storage buckets create "gs://$BUCKET" --location "$REGION" --project "$PROJECT" --uniform-bucket-level-access
    sa="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
    gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$sa" --role roles/storage.objectUser >/dev/null
    for s in "${SECRETS[@]}"; do
      n=$(secret_name "$s")
      gcloud secrets describe "$n" --project "$PROJECT" >/dev/null 2>&1 ||
        gcloud secrets create "$n" --project "$PROJECT" --replication-policy automatic
      printf %s "$(val "$s")" | gcloud secrets versions add "$n" --project "$PROJECT" --data-file=- >/dev/null
      gcloud secrets add-iam-policy-binding "$n" --project "$PROJECT" --member "serviceAccount:$sa" \
        --role roles/secretmanager.secretAccessor >/dev/null
    done
    echo "Prepared. Next: deploy/cloudrun.sh switch"
    ;;
  switch)
    # Never run two servers at once: they share the relayer key and the state.
    systemctl --user stop hidroreais-server
    gcloud storage cp server/data/store.json "gs://$BUCKET/store.json"
    deploy_service
    url=$(service_url)
    gcloud scheduler jobs describe hidroreais-tick --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 &&
      verb=update || verb=create
    gcloud scheduler jobs "$verb" http hidroreais-tick --location "$REGION" --project "$PROJECT" \
      --schedule "* * * * *" --uri "$url/admin/tick" --http-method POST \
      --headers "Authorization=Bearer $(val ADMIN_TOKEN)"
    curl -fsS "$url/config" && echo
    echo "Cloud Run is serving at $url. Next: delete the DNS record for dimdim-api in Cloudflare,"
    echo "then deploy/cloudrun.sh domain"
    ;;
  domain)
    # ORIGIN_URL lives in wrangler.toml; check it matches this service.
    grep -q "$(service_url)" deploy/api-proxy/wrangler.toml || { echo "Set ORIGIN_URL in deploy/api-proxy/wrangler.toml to $(service_url)"; exit 1; }
    npx wrangler deploy --config deploy/api-proxy/wrangler.toml
    systemctl --user disable --now hidroreais-tunnel hidroreais-server
    echo "dimdim-api now goes to Cloud Run; the tunnel and the local server are off."
    ;;
  update)
    build_and_push
    deploy_service
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 1
    ;;
esac
