# Deploying Scipio UI

Scipio UI runs as a small Node server on the Scipio Mac mini (`10.20.0.9`), next to Ollama. People open it at `http://10.20.0.9:4173` over WireGuard.

The Node server only serves the app. Each person's browser calls Ollama at `http://10.20.0.9:11434` directly, which works because Ollama runs with `OLLAMA_ORIGINS=*`. That means the app only works while connected to WireGuard: off the VPN, the model list is empty.

Run it with Node directly rather than Docker. Docker on macOS runs inside a VM that reserves its own memory, and the models already use about 21GB of the mini's 24GB. The Node server uses well under 100MB.

## Install

On the Mac mini:

```bash
brew install node@24 git
git clone git@github.com:Twin-Lakes-Trading/hollama-tlt.git ~/scipio-ui
~/scipio-ui/deploy/install.sh
```

`install.sh` builds the app and installs it as a launch agent (`com.tlt.scipio-ui`). The agent starts at login and restarts if the server exits. To serve on a different port, run `PORT=8080 deploy/install.sh`. Running the script again replaces the existing agent.

Check it from a machine on WireGuard: `http://10.20.0.9:4173` should open straight to Sessions, with `scipio-code` and `scipio-think` in the model picker.

The launch agent runs under your user, like Ollama under `brew services`. If the mini is set up to bring Ollama back after a reboot, it brings Scipio UI back the same way.

## Update

After changes are pushed to `main`:

```bash
~/scipio-ui/deploy/update.sh
```

It pulls `main`, rebuilds, and restarts the server.

## Manage

| Task        | Command                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| View logs   | `tail -f ~/Library/Logs/scipio-ui.log`                                            |
| Restart     | `launchctl kickstart -k gui/$(id -u)/com.tlt.scipio-ui`                           |
| Status      | `launchctl print gui/$(id -u)/com.tlt.scipio-ui \| grep state`                    |
| Stop        | `launchctl bootout gui/$(id -u)/com.tlt.scipio-ui`                                |
| Start again | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tlt.scipio-ui.plist` |

## Notes

- **Node path:** the agent runs the `node` found on your `PATH` when `install.sh` ran. If you upgrade or remove that Node install (for example through Homebrew or nvm), run `install.sh` again.
- **Building by hand:** the build needs `PUBLIC_ADAPTER=docker-node`. Without it, the app is built for Cloudflare instead of as a Node server. The scripts set it for you.
- **Upstream Docker image:** upstream's [SELF_HOSTING.md](../SELF_HOSTING.md) uses `ghcr.io/fmaclen/hollama`. Don't use it: that's upstream's image, without the Scipio changes.
