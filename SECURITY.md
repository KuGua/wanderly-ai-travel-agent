# Security Policy

## Reporting a vulnerability or exposed secret

Please do not report vulnerabilities, credentials, personal data, or suspected
secret exposure in a public issue. Contact the repository owner privately and
include the affected commit or file path, a concise reproduction path, and any
rotation or containment steps already taken.

If a credential has been committed, treat it as exposed even if it was later
deleted: revoke or rotate it first, then assess history remediation and affected
systems. Do not paste the credential into an issue, pull request, log, or chat.

## Security boundaries

- Local `.env` files and credentials must remain untracked.
- Browser-visible `NEXT_PUBLIC_*` configuration must never contain a secret.
- Travel providers, model gateways, database access, callback signing, and
  identity credentials are server-side only.
- Production changes require the repository's normal review and CI process.
