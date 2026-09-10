# Third-Party Notices

This file records third-party material committed to this repository and the
terms that accompany it. It is part of the distribution notice required by
the repository's Apache-2.0 license.

## Scope of the Apache-2.0 grant

The Apache-2.0 license applies only to original source code, documentation,
and configuration contributed to Wanderly by contributors who have the right
to grant that license. It does not replace the terms governing third-party
software, data, online services, trademarks, or material listed below.

## Geospatial reference data

| Material | Repository location | License / attribution |
| --- | --- | --- |
| Natural Earth Admin 0 Countries v5.1.2 | `apps/api/data/location-reference/countries.geojson`; derived browser boundary meshes | Public domain. Source: [Natural Earth](https://www.naturalearthdata.com/). |
| Natural Earth Admin 1 States, Provinces | `apps/api/data/location-reference/admin1.geojson` | Public domain. Source: [Natural Earth](https://www.naturalearthdata.com/). |
| GeoNames cities5000 | `apps/api/data/location-reference/cities5000.txt` | © GeoNames, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribute as “GeoNames” and link to [geonames.org](https://www.geonames.org/). |

The checked-in source manifests include dataset versions and checksums:

- `apps/api/data/location-reference/source-manifest.json`
- `apps/web/public/map-data/boundary-manifest.json`

## Software dependencies

Dependencies are installed from npm; they are not relicensed by this
repository. Their license metadata is recorded in the relevant lockfiles and
their own package distributions. Before redistributing a bundled artifact,
review every direct and transitive dependency's notice and license obligations.

## Online services and provider integrations

The source includes adapters for third-party services, including model,
identity, maps, travel, activities, and exchange-rate providers. Provider
credentials, accounts, live data, branding, and service access are not
included in this repository. Anyone deploying a fork must obtain their own
credentials and comply with each provider's current terms, quotas, attribution
requirements, and applicable law.

## Visual assets: release gate

The visual files under `apps/web/public/images/`, `apps/web/public/bot/`, and
`assets/` do not currently have a complete, verified provenance record in this
repository. They are therefore **not covered by the Apache-2.0 grant** and
must not be redistributed as part of an external release until the copyright
holder has documented their origin and granted an appropriate license.

For an external public release, either:

1. add an asset manifest with creator, source, license, and required
   attribution for every file; or
2. replace or remove the asset before release.

Do not infer permission from a filename, an AI-generation claim, or a local
copy of an image.
