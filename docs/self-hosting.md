# Self-hosting

Life Kernel is designed for a small single-user host. A 1–2 GB VPS is sufficient for the current text-only service; actual disk use is dominated by the user's vault and backups.

1. Copy `lifekernel.config.example.json` to `lifekernel.config.json` and map each vault path to `/vaults/...` inside the container.
2. Generate a long random `LIFEKERNEL_API_TOKEN` and keep it out of Git.
3. Set the exact HTTPS origin if a browser client will connect.
4. Run `docker compose up -d --build`.
5. Reverse proxy `127.0.0.1:8787` through Caddy, nginx, or a private tunnel with TLS.
6. Back up the Markdown vault and `.lifekernel-data` audit/receipt directory.

The compose file binds the host port to loopback. Preserve that binding. Remote exposure should happen through the TLS reverse proxy, ideally behind a VPN or identity-aware access layer.
