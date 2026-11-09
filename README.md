# Cursor Fuel

Short name: **fuel**.

Unofficial Cursor sidebar extension that shows your plan spend for the current billing cycle: included usage, on-demand spend, the team spend limit, and cycle dates — without opening the browser.

**Not affiliated with Anysphere or Cursor.** “Cursor” is a trademark of its respective owners. This project reads the signed-in editor session. It is not an official product.

## Requirements

- [Cursor](https://cursor.com) on macOS, with VS Code engine `^1.128` (see `engines.vscode` in `package.json`)
- A signed-in Cursor account

**Two Node versions (on purpose):**

- **Run** (inside Cursor): Node **24** — extension host. The `.vsix` is built with esbuild `target: node24` and only uses host APIs (`fetch`, `AbortSignal.timeout`, `node:sqlite`).
- **Build** (on your machine): Node **26.13** + **pnpm 12.18** — from `.nvmrc` and `packageManager`. For `pnpm install` / `check` / `test` / `package` only.

`package.json` → `engines` lists **only** `vscode`, so it is not read as “Cursor must run Node 26”.

UI copy is **French**. Code, commits, and this README are **English**. Amounts are **USD**.

## Sign-in

Fuel uses the Cursor account already signed in on this Mac. The first refresh can ask for the Keychain item **Cursor Safe Storage**. Allow it once. A denial stays quiet until **Rafraîchir**. Fuel does not store or log the session token.

## Privacy

- **Account** → `state.vscdb`, keys `cursorAuth/cachedEmail`, `cursorAuth/cachedScopedProfile` (name), and `cursorAuth/cachedTeam` (team), via `node:sqlite` read-only.
- **Editor session** → `cursorAuth/accessToken` from that same DB, decrypted with the Keychain item `Cursor Safe Storage`, used only for `GET https://cursor.com/api/usage-summary`.
- **Last snapshot** → `globalState` for instant display after reload.
- No telemetry. No Team API key.

## Install

```bash
git clone https://github.com/lucasboucher/fuel.git
cd fuel
fnm use
pnpm install
pnpm package
cursor --install-extension ./fuel-1.1.0.vsix --force
```

Reload the Cursor window. Open the Fuel view. Allow the Keychain prompt if macOS asks.

Optional: set `"workbench.activityBar.orientation": "vertical"` if the activity-bar badge is hidden in the top bar layout.

## Usage

The TreeView shows your name and email, with the team settings under them (team, on-demand on or off, and the team limit while on-demand is on). Then **Usage inclus** (total and model pools), **Dépenses** (total first, then included and on-demand, in USD), and **Cycle** (start, last refresh, end). The view title has **Rafraîchir** and **Voir sur cursor.com**. The activity-bar badge is `totalPercentUsed`, rounded.

Fuel loads once Cursor has started, so the badge is there before you open the view. Refresh runs every 5 minutes while the window is focused, sooner on manual refresh or when returning focus to a stale snapshot. One request at a time, 10 s timeout, exponential backoff after errors.

## Development

```bash
fnm use   # reads .nvmrc → Node 26.13
pnpm install
pnpm check
pnpm test
```

- SemVer in `package.json`
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- Branch: `main` only
- Lint / format: Biome (`pnpm lint`, `pnpm lint:fix`)
- Runtime target: keep esbuild on `node24` so the `.vsix` matches Cursor’s extension host

## License

MIT. See [LICENSE](LICENSE).
