# Self-hosting

Life Kernel is designed for a small single-user host. A 1–2 GB VPS is sufficient for the current text-only service; actual disk use is dominated by the user's vault and backups.

1. Copy `lifekernel.config.docker.example.json` to `lifekernel.config.json`. Vault paths are `/vaults/...` inside the container and `stateDir` is `/state` (a writable volume; the config itself is mounted read-only).
2. Set `LIFEKERNEL_API_TOKEN` (trusted clients), or `LIFEKERNEL_PUBLIC_URL` and `LIFEKERNEL_OWNER_SECRET` (ChatGPT and Claude.ai, see [remote mode](remote.md)). Keep them out of Git.
3. Set the exact HTTPS origin if a browser client will connect.
4. Find your user and group IDs with `id -u` and `id -g` on the server and put them in `.env` as `LIFEKERNEL_UID` and `LIFEKERNEL_GID` (both default to 1000). The container runs as that user, not as root, so the notes it writes in `./vaults` stay editable by you and by Obsidian. Any user ID works: the state volume is writable by everyone, like `/tmp`.
5. Start the server. `docker compose pull` fetches the published image (`ghcr.io/poyrazavsever/life-kernel`, for amd64 and arm64; set `LIFEKERNEL_VERSION` in `.env` to pin a release such as `0.2.0-beta.0`, otherwise it follows `latest`), then `docker compose up -d`. To build this checkout instead, run `docker compose up -d --build`. The image includes `git`, so `"history": "git"` and `lifekernel undo` work for a vault that is a git repository (run `git init` in the vault folder first). `docker compose ps` shows the container as healthy once `/health` answers.
6. Reverse proxy `127.0.0.1:8787` through Caddy, nginx, or a private tunnel with TLS.
7. Back up the Markdown vault and the state volume, which holds audit events, write receipts, tokens, and reminder state:

   ```bash
   docker run --rm -v lifekernel_lifekernel-state:/state -v "$PWD":/backup alpine tar czf /backup/lifekernel-state.tgz -C /state .
   ```

   The volume name is prefixed with the compose project name; `docker volume ls` shows it.

The compose file binds the host port to loopback. Preserve that binding. Remote exposure should happen through the TLS reverse proxy, ideally behind a VPN or identity-aware access layer.
