# Deploy

Target: the team's GCP VM (Debian 12, Caddy already running). The hostname is still to be decided.

1. Node 24 LTS (≥ 24.12) and `uv` on the box.
2. `git clone` into `/home/ggtwo/sentinel-er`, `npm ci`, `uv sync`, `npm run build -w apps/console`.
3. Copy `.env` (chmod 600). `NODE_ENV=production` needs `OPERATOR_PASSCODE`.
4. Copy the national seed tables into `data/seeds/` (built on a machine that can reach data.cms.gov).
5. `sudo cp deploy/*.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now sentinel-science sentinel-core`
6. Paste `Caddyfile.snippet` into the Caddyfile with the real hostname, then `sudo systemctl reload caddy`.
7. Point the Twilio number's voice URL at `https://<host>/voice/inbound` and its status callback at `/voice/status`.

Model training never runs on this box. Train on a laptop and commit the artifacts.
