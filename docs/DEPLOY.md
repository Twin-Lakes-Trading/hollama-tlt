# Deploying Scipio UI

Scipio UI runs as a small Node server on the Scipio Mac mini (`10.20.0.9`), next to Ollama. People open it at `http://10.20.0.9:4173` over WireGuard.

The Node server only serves the app. Each person's browser calls Ollama at `http://10.20.0.9:11434` directly, which works because Ollama runs with `OLLAMA_ORIGINS=*`. That means the app only works while connected to WireGuard: off the VPN, the model list is empty.

Both Ollama and Scipio UI listen only on the mini's WireGuard address, `10.20.0.9`. Nothing on the mini's local network or the internet can connect to them, only WireGuard clients. Both install scripts check that this address belongs to the mini and refuse to install otherwise. If the mini's WireGuard address ever changes, run both scripts again with `BIND_ADDRESS=<new address>`.

Run it with Node directly rather than Docker. Docker on macOS runs inside a VM that reserves its own memory, and the models already use about 21GB of the mini's 24GB. The Node server uses well under 100MB.

## Keep the mini awake

By default macOS puts the mini to sleep when idle. Asleep, it drops off WireGuard, so the site and models become unreachable until someone wakes it. Turn sleep off once, when setting up the mini:

```bash
sudo pmset -a sleep 0 disksleep 0 powernap 0 autorestart 1 womp 1
pmset -g | grep -E " sleep|disksleep|autorestart|womp"
```

The second command should show `sleep 0`, `disksleep 0`, `autorestart 1` and `womp 1`.

| Setting         | Why                                                                         |
| --------------- | --------------------------------------------------------------------------- |
| `sleep 0`       | Never sleeps, so it stays on WireGuard                                      |
| `disksleep 0`   | Keeps the disk awake, so the first request after a quiet stretch isn't slow |
| `powernap 0`    | Stops the short background wake-ups ("DarkWake") that come with sleeping    |
| `autorestart 1` | Powers back on by itself after a power cut                                  |
| `womp 1`        | Can be woken over the network if it ever does sleep                         |

Also turn on **System Settings → Energy → Prevent automatic sleeping when the display is off**.

To check whether the mini has been sleeping, run `pmset -g log | grep -E "Entering Sleep|Wake from" | tail -5`.

## Install

On the Mac mini:

```bash
brew install node@24 git python
git clone git@github.com:Twin-Lakes-Trading/hollama-tlt.git ~/scipio-ui
~/scipio-ui/deploy/install-ollama.sh
~/scipio-ui/deploy/install-searxng.sh
~/scipio-ui/deploy/install.sh
```

`install-ollama.sh` runs Ollama as its own launch agent (`com.tlt.ollama`) that listens on the WireGuard address, so WireGuard clients can reach it. It replaces `brew services`: settings like `OLLAMA_HOST` in your shell profile or set with `launchctl setenv` don't reliably reach the Homebrew service, so Ollama ends up listening on `localhost` only and the model list stays empty. The script stops `brew services` and the Ollama app, then starts Ollama with these settings:

| Setting                  | Value             | Why                                                         |
| ------------------------ | ----------------- | ----------------------------------------------------------- |
| `OLLAMA_HOST`            | `10.20.0.9:11434` | Reachable over WireGuard only                               |
| `OLLAMA_ORIGINS`         | `*`               | Lets the browser call Ollama from the Scipio UI page        |
| `OLLAMA_KEEP_ALIVE`      | `-1`              | Keeps the loaded model in memory                            |
| `OLLAMA_FLASH_ATTENTION` | `1`               | Same as Homebrew's service                                  |
| `OLLAMA_KV_CACHE_TYPE`   | `q8_0`            | Same as Homebrew's service; keeps 16K context in GPU memory |

To change a setting, edit [deploy/com.tlt.ollama.plist](../deploy/com.tlt.ollama.plist) and run the script again.

`install.sh` builds the app and installs it as a launch agent (`com.tlt.scipio-ui`), listening on `10.20.0.9:4173`. The agent starts at login and restarts if the server exits. To serve on a different port, run `PORT=8080 deploy/install.sh`. Running the script again replaces the existing agent.

`install-searxng.sh` installs [SearXNG](https://docs.searxng.org), the search engine behind web search, in `~/searxng` and runs it as a launch agent (`com.tlt.searxng`) on `127.0.0.1:8888`. Only the Scipio UI server on the mini talks to it, so it isn't reachable from anywhere else, including WireGuard. Its settings are in `~/searxng/settings.yml`, created from [deploy/searxng-settings.yml](../deploy/searxng-settings.yml) on first install and kept on later runs. Run the script again to update SearXNG. It needs Python 3.10 or newer; macOS ships 3.9, hence `brew install python`. Scipio UI finds it at `http://127.0.0.1:8888` by default; set `SEARXNG_URL` in the Scipio UI launch agent to use another address.

Check it from a machine on WireGuard: `http://10.20.0.9:4173` should open straight to Sessions, with `scipio-code` and `scipio-think` in the model picker.

All three launch agents run under your user and start when it logs in, so the mini needs to log that user in automatically after a reboot. If they start before WireGuard is up, they can't bind to `10.20.0.9` yet; launchd keeps restarting them, so they come up a few seconds after WireGuard does.

## Update

After changes are pushed to `main`:

```bash
~/scipio-ui/deploy/update.sh
```

It pulls `main`, rebuilds, and restarts the server. If a release changes a file in `deploy/`, run `install.sh` or `install-ollama.sh` again so the launch agent picks up the change; the release's changelog will say so.

## Manage

| Task        | Command                                                                           |
| ----------- | --------------------------------------------------------------------------------- |
| Ollama logs | `tail -f ~/Library/Logs/ollama.log`                                               |
| Search logs | `tail -f ~/Library/Logs/searxng.log`                                              |
| View logs   | `tail -f ~/Library/Logs/scipio-ui.log`                                            |
| Restart     | `launchctl kickstart -k gui/$(id -u)/com.tlt.scipio-ui`                           |
| Status      | `launchctl print gui/$(id -u)/com.tlt.scipio-ui \| grep state`                    |
| Stop        | `launchctl bootout gui/$(id -u)/com.tlt.scipio-ui`                                |
| Start again | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tlt.scipio-ui.plist` |

## Notes

- **Checking Ollama:** `lsof -iTCP:11434 -sTCP:LISTEN` on the mini should show `10.20.0.9:11434`. If it shows `localhost:11434` or `*:11434`, Ollama was started by something other than `com.tlt.ollama`; run `deploy/install-ollama.sh` again.
- **Ollama commands on the mini:** because Ollama no longer listens on `localhost`, commands like `ollama list` or `ollama show scipio-think` need the address: `OLLAMA_HOST=10.20.0.9 ollama list`. To skip typing it, add `export OLLAMA_HOST=10.20.0.9` to `~/.zshrc`.
- **Checking search:** `curl "http://127.0.0.1:8888/search?q=test&format=json"` on the mini should return JSON with `results`. A few engines (often Brave or DuckDuckGo) refusing requests with "too many requests" or a CAPTCHA is normal; the others cover for them.
- **Node path:** the agent runs the `node` found on your `PATH` when `install.sh` ran. If you upgrade or remove that Node install (for example through Homebrew or nvm), run `install.sh` again.
- **Building by hand:** the build needs `PUBLIC_ADAPTER=docker-node`. Without it, the app is built for Cloudflare instead of as a Node server. The scripts set it for you.
- **Upstream Docker image:** upstream's [SELF_HOSTING.md](../SELF_HOSTING.md) uses `ghcr.io/fmaclen/hollama`. Don't use it: that's upstream's image, without the Scipio changes.
