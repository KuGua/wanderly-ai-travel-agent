# Open-source release checklist

## Purpose

This checklist governs a public release of Wanderly source code. It distinguishes
the Apache-2.0-licensed project source from third-party materials and operational
access that cannot be granted by this repository.

## Required before publishing

1. **Confirm contributor authority.** Every contributor confirms that they may
   contribute their original code and documentation under Apache-2.0.
2. **Scan the complete Git history.** Run Gitleaks with a full clone and all
   reachable refs before changing repository visibility. The CI workflow keeps
   continuous secret detection in place, but does not replace this explicit
   release gate:

   ```bash
   gitleaks git --log-opts="--all" .
   ```

   Rotate any detected credential before considering history cleanup. Deleting a
   secret from the working tree does not remove it from prior commits.
3. **Review the notices.** Verify every statement in
   [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), preserve GeoNames
   attribution, and review bundled dependency notices for release artifacts.
4. **Clear the visual-asset gate.** Add verified provenance and a redistributable
   license for every tracked image, or remove/replace that image. Until then,
   the visual asset directories are excluded from the Apache-2.0 grant.
5. **Check GitHub and deployment configuration.** Confirm that Actions logs,
   issue templates, release artifacts, environment variables, deployment
   settings, and linked cloud resources contain no credentials or personal data.
6. **Publish only the code—not access.** Remove local runtime files, do not
   distribute provider accounts or keys, and make clear that forks must supply
   their own provider credentials and comply with provider terms.

If this repository is owned by a GitHub organization, configure the required
`GITLEAKS_LICENSE` as an encrypted repository or organization secret before
relying on the CI workflow. It must never be committed to this repository.

## Release decision

The repository is ready to be licensed as open-source code once the above steps
are complete. It is not ready to be described as a fully redistributable public
repository while the visual-asset gate remains open.
