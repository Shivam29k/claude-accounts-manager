# Claude Accounts Manager

Switch Claude Code between your Claude subscriptions with one tap, and see how much of each account's limits is left.

![Claude Accounts Manager](docs/screenshot-desktop.png)

If you have more than one Claude subscription, you know the routine. An account hits its 5-hour limit, you SSH in, run `/login` and go through the browser flow. This app does it from a web page, on your phone if you like, and can switch on its own before you hit the limit.

## Features

- Save all your Claude logins (Pro, Max, Team). Sign in to each one once.
- See 5-hour, weekly and per-model usage for every account, with time left until reset.
- Switch accounts with one click. Running Claude Code sessions continue on the new account, no restart.
- Auto-switch when the active account reaches a limit you set, globally or per account.
- Auto-start idle accounts' 5-hour windows so they reset sooner.
- Token usage chart per account or per model.
- Warnings when something would bypass your subscription, such as an API key in the environment or extra usage turned on.

## Install

Needs Linux or WSL, Node.js 20+ and Claude Code. No npm dependencies. macOS isn't supported, because Claude Code keeps its login in the Keychain there.

```sh
git clone https://github.com/Shivam29k/claude-accounts-manager.git
cd claude-accounts-manager
npm start
```

Open http://127.0.0.1:4330. The account Claude Code is signed in with shows up right away.

To keep it running in the background (it has to, for auto-switch), use the systemd user service in `deploy/`:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/claude-accounts-manager.service ~/.config/systemd/user/
# set the node and checkout paths in ExecStart first
systemctl --user daemon-reload
systemctl --user enable --now claude-accounts-manager
loginctl enable-linger "$USER"
```

## Use it from your phone

The app only listens on 127.0.0.1. Put it on your [Tailscale](https://tailscale.com) network:

```sh
sudo tailscale serve --bg --https=10001 http://127.0.0.1:4330
```

Then open `https://<machine>.<tailnet>.ts.net:10001` and add it to your home screen. Set `CAM_ALLOWED_LOGINS` to your Tailscale login so nobody else on your tailnet can use it. Never expose it to the public internet. Whoever can open the page can switch your accounts.

## Add an account

1. Click **+ Add account**, then **Sign in with Claude**. Use **Copy link** to open it in a private window or another browser.
2. Sign in with the account you want to add and approve. If claude.ai is already signed in as someone else, use a private window.
3. Paste the code Claude shows and click **Add account**.

## Good to know

- **Auto-switch options** are behind the arrow next to the slider. Pick which limits count, and whether to go to the account with the most room or the next one in your list. Drag rows to reorder.
- **Per-account settings** live in each row's ⋯ menu: a custom limit, skipping the account in auto-switch, auto-start, sign in again, remove.
- **Auto-start** sends `hi` on Haiku through the Claude Code CLI, using only that account's token. It costs a few tokens and leaves your live login alone. At most once per 15 minutes per account.
- **The token chart** counts input, output and cache-write tokens from Claude Code's transcripts, on this machine only. Usage from before you installed the app shows as "Other".
- **A session didn't switch?** It's probably using an API key or another config directory. The app lists those at the top of the page.
- **Sign-in rate-limited?** Wait for the countdown, then try once with a fresh link. Retrying sooner can extend the block.

## Configuration

Environment variables. Everything else is set in the UI.

| Variable | Default | |
| --- | --- | --- |
| `CAM_PORT` | `4330` | Port |
| `CAM_HOST` | `127.0.0.1` | Address to listen on |
| `CAM_ALLOWED_LOGINS` | | Tailscale logins allowed in, comma-separated |
| `CAM_DATA_DIR` | `~/.claude-accounts-manager` | Saved accounts and backups |
| `CAM_CLAUDE_DIR` | `~/.claude` | Claude Code's config directory |
| `CAM_CLAUDE_BIN` | `claude` on `PATH` | Claude Code executable |

## How it works

Claude Code on Linux keeps its login in `~/.claude/.credentials.json`, and running sessions reload that file when it changes. The app keeps each account's tokens, refreshes them, and on a switch writes the chosen account's login into that file and `~/.claude.json`, leaving everything else in them as it was. Sign-in uses the same OAuth flow as `claude /login`, and usage comes from the endpoint behind Claude Code's `/usage`.

## Security

Saved logins are OAuth tokens stored in `~/.claude-accounts-manager/state.json` (mode 600), the same way Claude Code stores its own on Linux. The page never receives tokens, and the API rejects requests from other websites.

## Contributing

`npm test` runs the test suite. It needs no network and doesn't touch your Claude files.

## Disclaimer

Not affiliated with Anthropic. This relies on the same undocumented endpoints as Claude Code, so a Claude Code update can break it. Make sure your use of multiple subscriptions follows Anthropic's terms.

## License

MIT
