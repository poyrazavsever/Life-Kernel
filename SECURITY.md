# Security policy

Life Kernel can expose private notes. Treat its token and every mounted vault as sensitive.

## Supported mode

The developer preview supports one trusted user. Local stdio is safest. HTTP mode requires a bearer token, validates browser origins, defaults to `127.0.0.1`, and should sit behind HTTPS when used remotely.

Do not publish port 8787 directly to the internet. Use a reverse proxy, a private network or VPN, a long random token, read-only mounts where possible, backups, and narrow vault routes.

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not place secrets or real vault samples in an issue.
