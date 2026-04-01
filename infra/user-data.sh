#!/bin/bash
# EC2 User Data — provisions a t4g.nano for the MRMS radar tile pipeline.
# Phase 1: Install system packages, create user, set up swap.
# Phase 2 (post-boot): SCP the code and npm install via setup.sh.

set -euxo pipefail

# --- System packages ---
dnf install -y gdal310 gdal310-python-tools python3 git nodejs20 npm cronie

# Ensure crond is running
systemctl enable crond
systemctl start crond

# --- Swap (512 MB — safety net for GDAL memory spikes) ---
dd if=/dev/zero of=/swapfile bs=1M count=512
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# --- App user ---
useradd -m -s /bin/bash mrms

# --- Log rotation ---
cat > /etc/logrotate.d/mrms <<'LOGEOF'
/home/mrms/mrms.log /home/mrms/mrms-cron.log {
    daily
    rotate 7
    missingok
    notifempty
    compress
}
LOGEOF

echo "=== Phase 1 complete — ready for setup.sh ==="
