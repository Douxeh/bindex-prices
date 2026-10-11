# bindex-prices

Daily price data for the Bindex iOS app, served from GitHub Pages:
`https://douxeh.github.io/bindex-prices/v1/`.

Every night a GitHub Action (`.github/workflows/update-prices.yml`) runs
`scripts/build.mjs`, which combines:

- **Scrydex**: every English Pokémon card, USD prices per variant and
  condition, graded prices (PSA/BGS/CGC/SGC) and 1–180 day trends.
- **Cardmarket price guide**: the public daily download, EUR trend/avg/low
  per product including reverse holo.

Cardmarket products have no card numbers, so they are matched to cards by
expansion (card-name overlap) and, within a name, by price rank. Stamped,
cosmos and jumbo variants get no EUR price, because they are separate products
on Cardmarket.

## Files

| Path | Contents |
| --- | --- |
| `v1/meta.json` | Run time, counts, Scrydex credits used |
| `v1/sets.json` | All expansions with card count and set value |
| `v1/sets/<setId>.json` | Every card with prices per variant |
| `v1/history/<setId>.json` | Daily `[date, usd, eur, estimated?]` points per `cardId\|variant` (400 days) |
| `v1/search.json` | `[id, name, number, setId, rarity, image]` for every card |

History is carried over from the previous deploy. The first points of a new
series are seeded from the reported trends and flagged as estimated.

## Secrets

`SCRYDEX_API_KEY` and `SCRYDEX_TEAM_ID` (repository secrets).

## Run locally

```bash
SCRYDEX_API_KEY=… SCRYDEX_TEAM_ID=… ONLY_SETS=sv3pt5 OUT_DIR=public node scripts/build.mjs
```
