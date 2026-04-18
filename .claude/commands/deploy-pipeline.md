---
description: Pre-flight, deploy, and tail the pipeline on the EC2 instance
argument-hint: <instance-ip> <path-to-ssh-key.pem>
---

Wrap `infra/deploy.sh` with pre-flight checks and a log tail so deploys don't silently ship stale or broken code.

Arguments: `$ARGUMENTS`
- First arg: instance IP.
- Second arg: path to SSH key.

Both required. If either is missing, print the correct usage and stop.

Steps:

1. **Pre-flight checks. Stop on any failure and report which check failed.**
   - `git status --porcelain` must be empty. Dirty working tree → stop.
   - `git rev-parse HEAD` must equal `git rev-parse origin/main`. Local behind or ahead of origin → stop. Run `git fetch origin main` first to refresh.
   - Current branch must be `main`.
   - `npx tsc --noEmit` must pass.
2. **Deploy.** Run `./infra/deploy.sh <ip> <key>` and stream output. The script does `git fetch && git reset --hard origin/main` on the instance.
3. **Confirm the deployed SHA** matches local `HEAD` by inspecting the deploy script's output.
4. **Tail the cron logs** for 60 seconds so the user can see the next scheduled run land:
   ```
   ssh -i <key> ec2-user@<ip> 'sudo -u mrms tail -n 20 -f /home/mrms/mrms-cron.log /home/mrms/hrrr-cron.log'
   ```
   Run this with a timeout (use `timeout 60` on macOS with coreutils, or background it and kill after 60s).
5. Report: deployed SHA, time to next MRMS cron tick (MRMS runs every 5 min at `*/5`), time to next HRRR tick (HRRR runs hourly at `:30`).

Do not run the deploy if any pre-flight check fails. Do not force-push, skip checks, or modify `infra/deploy.sh` to work around failures — investigate the root cause.
