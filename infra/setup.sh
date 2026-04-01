#!/bin/bash
# Post-boot setup: SCP code to the EC2 instance, install deps, configure cron.
# Usage: ./infra/setup.sh <instance-ip> <path-to-ssh-key>

set -euo pipefail

IP="${1:?Usage: setup.sh <instance-ip> <path-to-ssh-key>}"
KEY="${2:?Usage: setup.sh <instance-ip> <path-to-ssh-key>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no ec2-user@$IP"
SCP="scp -i $KEY -o StrictHostKeyChecking=no"

echo "=== Setting up NOAA radar pipeline on $IP ==="

# --- Wait for user-data to finish ---
echo "Waiting for instance provisioning to complete..."
for i in $(seq 1 60); do
  if $SSH "test -f /var/lib/cloud/instance/boot-finished" 2>/dev/null; then
    echo "  Instance ready."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "  Timed out waiting for provisioning."
    exit 1
  fi
  sleep 5
done

# --- Create directory structure ---
echo "Creating directory structure..."
$SSH "sudo -u mrms mkdir -p /home/mrms/noaa-radar-pipeline/scripts/mrms/color-ramps /home/mrms/noaa-radar-pipeline/scripts/hrrr/color-ramps /home/mrms/noaa-radar-pipeline/scripts/output/mrms-tiles /home/mrms/noaa-radar-pipeline/scripts/output/mrms-work /home/mrms/noaa-radar-pipeline/scripts/output/hrrr-tiles /home/mrms/noaa-radar-pipeline/scripts/output/hrrr-work /home/mrms/noaa-radar-pipeline/lib"

# --- Copy pipeline scripts ---
echo "Copying pipeline scripts..."
$SCP "$REPO_ROOT/scripts/generate-mrms-tiles.ts" "ec2-user@$IP:/tmp/generate-mrms-tiles.ts"
$SCP "$REPO_ROOT/scripts/upload-mrms-tiles.ts" "ec2-user@$IP:/tmp/upload-mrms-tiles.ts"
$SCP "$REPO_ROOT/scripts/generate-hrrr-tiles.ts" "ec2-user@$IP:/tmp/generate-hrrr-tiles.ts"
$SCP "$REPO_ROOT/scripts/upload-hrrr-tiles.ts" "ec2-user@$IP:/tmp/upload-hrrr-tiles.ts"

# Color ramps (MRMS)
$SCP "$REPO_ROOT/scripts/mrms/color-ramps/rain.txt" "ec2-user@$IP:/tmp/mrms-rain.txt"
$SCP "$REPO_ROOT/scripts/mrms/color-ramps/snow.txt" "ec2-user@$IP:/tmp/mrms-snow.txt"
$SCP "$REPO_ROOT/scripts/mrms/color-ramps/hail.txt" "ec2-user@$IP:/tmp/mrms-hail.txt"

# Color ramps (HRRR)
$SCP "$REPO_ROOT/scripts/hrrr/color-ramps/rain-accum.txt" "ec2-user@$IP:/tmp/hrrr-rain-accum.txt"
$SCP "$REPO_ROOT/scripts/hrrr/color-ramps/snow-accum.txt" "ec2-user@$IP:/tmp/hrrr-snow-accum.txt"
$SCP "$REPO_ROOT/scripts/hrrr/color-ramps/ice-accum.txt" "ec2-user@$IP:/tmp/hrrr-ice-accum.txt"

# lib and package files
$SCP "$REPO_ROOT/lib/r2-client.ts" "ec2-user@$IP:/tmp/r2-client.ts"
$SCP "$REPO_ROOT/package.json" "ec2-user@$IP:/tmp/package.json"
$SCP "$REPO_ROOT/package-lock.json" "ec2-user@$IP:/tmp/package-lock.json"
$SCP "$REPO_ROOT/tsconfig.json" "ec2-user@$IP:/tmp/tsconfig.json"

$SSH <<'REMOTE'
set -euo pipefail
sudo mv /tmp/generate-mrms-tiles.ts /home/mrms/noaa-radar-pipeline/scripts/
sudo mv /tmp/upload-mrms-tiles.ts /home/mrms/noaa-radar-pipeline/scripts/
sudo mv /tmp/generate-hrrr-tiles.ts /home/mrms/noaa-radar-pipeline/scripts/
sudo mv /tmp/upload-hrrr-tiles.ts /home/mrms/noaa-radar-pipeline/scripts/
sudo mv /tmp/mrms-rain.txt /home/mrms/noaa-radar-pipeline/scripts/mrms/color-ramps/rain.txt
sudo mv /tmp/mrms-snow.txt /home/mrms/noaa-radar-pipeline/scripts/mrms/color-ramps/snow.txt
sudo mv /tmp/mrms-hail.txt /home/mrms/noaa-radar-pipeline/scripts/mrms/color-ramps/hail.txt
sudo mv /tmp/hrrr-rain-accum.txt /home/mrms/noaa-radar-pipeline/scripts/hrrr/color-ramps/rain-accum.txt
sudo mv /tmp/hrrr-snow-accum.txt /home/mrms/noaa-radar-pipeline/scripts/hrrr/color-ramps/snow-accum.txt
sudo mv /tmp/hrrr-ice-accum.txt /home/mrms/noaa-radar-pipeline/scripts/hrrr/color-ramps/ice-accum.txt
sudo mv /tmp/r2-client.ts /home/mrms/noaa-radar-pipeline/lib/r2-client.ts
sudo mv /tmp/package.json /home/mrms/noaa-radar-pipeline/package.json
sudo mv /tmp/package-lock.json /home/mrms/noaa-radar-pipeline/package-lock.json
sudo mv /tmp/tsconfig.json /home/mrms/noaa-radar-pipeline/tsconfig.json
sudo chown -R mrms:mrms /home/mrms/noaa-radar-pipeline
REMOTE

echo "Files copied."

# --- Install npm dependencies ---
echo "Installing npm dependencies..."
$SSH "sudo -u mrms bash -c 'cd /home/mrms/noaa-radar-pipeline && npm install --ignore-scripts 2>&1 | tail -5'"

# --- Write environment file ---
echo "Writing environment file..."
if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "ERROR: $REPO_ROOT/.env not found. Copy .env.example to .env and fill in your credentials."
  exit 1
fi

$SCP "$REPO_ROOT/.env" "ec2-user@$IP:/tmp/pipeline-env"
$SSH "sudo mv /tmp/pipeline-env /home/mrms/.env && sudo chmod 600 /home/mrms/.env && sudo chown mrms:mrms /home/mrms/.env"

# --- Write MRMS wrapper script ---
echo "Writing wrapper scripts..."
$SSH <<'WRAPPER'
cat > /tmp/run-mrms.sh <<'SCRIPTEOF'
#!/bin/bash
set -euo pipefail

exec 200>/home/mrms/mrms.lock
flock -n 200 || { echo "$(date -u '+%Y-%m-%d %H:%M:%S') SKIP (locked)" >> /home/mrms/mrms.log; exit 0; }

cd /home/mrms/noaa-radar-pipeline
set -a; source /home/mrms/.env; set +a

npx tsx scripts/generate-mrms-tiles.ts
npx tsx scripts/upload-mrms-tiles.ts --keep 20

echo "$(date -u '+%Y-%m-%d %H:%M:%S') OK" >> /home/mrms/mrms.log
SCRIPTEOF
sudo mv /tmp/run-mrms.sh /home/mrms/run-mrms.sh
sudo chmod +x /home/mrms/run-mrms.sh
sudo chown mrms:mrms /home/mrms/run-mrms.sh
WRAPPER

$SSH <<'HRRR_WRAPPER'
cat > /tmp/run-hrrr.sh <<'SCRIPTEOF'
#!/bin/bash
set -euo pipefail

exec 200>/home/mrms/hrrr.lock
flock -n 200 || { echo "$(date -u '+%Y-%m-%d %H:%M:%S') SKIP (locked)" >> /home/mrms/hrrr.log; exit 0; }

cd /home/mrms/noaa-radar-pipeline
set -a; source /home/mrms/.env; set +a

npx tsx scripts/generate-hrrr-tiles.ts
npx tsx scripts/upload-hrrr-tiles.ts --keep 2

echo "$(date -u '+%Y-%m-%d %H:%M:%S') OK" >> /home/mrms/hrrr.log
SCRIPTEOF
sudo mv /tmp/run-hrrr.sh /home/mrms/run-hrrr.sh
sudo chmod +x /home/mrms/run-hrrr.sh
sudo chown mrms:mrms /home/mrms/run-hrrr.sh
HRRR_WRAPPER

# --- Enable cron ---
echo "Enabling cron (MRMS every 5 min, HRRR hourly at :30)..."
$SSH 'printf "*/5 * * * * /home/mrms/run-mrms.sh >> /home/mrms/mrms-cron.log 2>&1\n30 * * * * /home/mrms/run-hrrr.sh >> /home/mrms/hrrr-cron.log 2>&1\n" | sudo crontab -u mrms -'

echo ""
echo "=== Pipeline is live ==="
echo "  SSH:   ssh -i $(basename $KEY) ec2-user@$IP"
echo "  Logs:  ssh -i $(basename $KEY) ec2-user@$IP 'sudo -u mrms tail -f /home/mrms/mrms-cron.log'"
