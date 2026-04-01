#!/bin/bash
# Deploy latest code from main to the pipeline instance.
# Usage: ./infra/deploy.sh <instance-ip> <path-to-ssh-key>

set -euo pipefail

IP="${1:?Usage: deploy.sh <instance-ip> <path-to-ssh-key>}"
KEY="${2:?Usage: deploy.sh <instance-ip> <path-to-ssh-key>}"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no ec2-user@$IP"

echo "Deploying to $IP..."

$SSH "sudo -u mrms bash -c '
  cd /home/mrms/noaa-radar-pipeline
  git fetch origin main
  git reset --hard origin/main
  echo \"Deployed: \$(git log --oneline -1)\"
'"

echo "Done. Next cron run will use the new code."
