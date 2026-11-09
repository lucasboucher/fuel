# Cursor Fuel

Short name: **fuel**.

Unofficial Cursor sidebar extension that shows your team plan spend for the current billing cycle: included usage (total + Cursor / other model pools), on-demand spend, optional per-user limit, and cycle dates — without opening the browser.

**Not affiliated with Anysphere or Cursor.** “Cursor” is a trademark of its respective owners. This project uses the public Team Admin API and is not an official product.

## Requirements

- [Cursor](https://cursor.com) (VS Code engine `^1.128`)
- A **Team** plan with permission to create an Admin API key
- Node **26.13** (via [fnm](https://github.com/Schniz/fnm)) and **pnpm 12.18** to build the `.vsix`

UI copy is **French**. Code, commits, and this README are **English**.

## API key

Fuel needs a **Team** Admin API key (not a user key), stored only in the editor secret storage.

1. Open [Cursor Dashboard → Spending](https://cursor.com/dashboard/spending) (or Team settings → API keys).
2. Create a key with **read-only / View member usage** access when offered.
   - Legacy Team keys (`crsr_…`) with read scope work.
   - Fine-grained keys (`grok_…`) need a usage-read scope; Fuel tries Basic auth, then Bearer on `401`.
3. In Cursor: open the **Fuel** activity-bar view → **Définir la clé**, or run **Cursor Fuel: Définir la clé d’API**.

Anyone with that key can read team member usage. Prefer read-only, rotate if leaked, revoke from the dashboard when done. Fuel never sends the key to the view, logs, or this repository.

## Privacy

- **API key** → `SecretStorage` only.
- **Email** → read once from the local Cursor DB (`state.vscdb`, key `cursorAuth/cachedEmail`) via `node:sqlite` (read-only) to match your row in `POST /teams/spend`.
- **Last snapshot** → `globalState` for instant display after reload.
- No telemetry. No second API.

## Install

```bash
git clone https://github.com/lucasboucher/fuel.git
cd fuel
fnm use
pnpm install
pnpm package
cursor --install-extension ./fuel-1.0.0.vsix --force
```

Reload the Cursor window. Open the Fuel view, paste the Team API key, then refresh.

Optional: set `"workbench.activityBar.orientation": "vertical"` if the activity-bar badge is hidden in the top bar layout.

## Usage

The TreeView shows identity, **Usage** (Total inclus + model pools), **Dépenses**, **Cycle**, and a dashboard link. The activity-bar badge is `totalPercentUsed` only (rounded).

Refresh runs every 15 minutes while the view is visible and the window is focused; sooner on manual refresh or when returning focus to a stale snapshot. One request at a time, 10 s timeout, exponential backoff after errors.

## Development

```bash
fnm use
pnpm install
pnpm check
pnpm test
```

- SemVer in `package.json`
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- Branch: `main` only
- Lint / format: Biome (`pnpm lint`, `pnpm lint:fix`)

## License

MIT. See [LICENSE](LICENSE).
