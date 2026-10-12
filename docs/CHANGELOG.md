# Scipio Changelog

Changes made in this fork of [Hollama](https://github.com/fmaclen/hollama). Upstream releases are listed on [Hollama's releases page](https://github.com/fmaclen/hollama/releases).

## 0.37.0 — 2026-10-11

First Scipio release, built on Hollama 0.36.0.

### Branding

- Renamed the app from Hollama to Scipio in the sidebar and browser tab title.
- Replaced the logo and favicon with the Scipio helmet. The sidebar logo turns white in dark mode, and the favicon sits on a white tile so it stays visible on dark browser tabs.
- Removed the Message of the Day page and its sidebar link.
- Removed the GitHub link from the sidebar.

### Scipio server preset

- A new browser starts with the Scipio Ollama server (`http://10.20.0.9:11434`) already enabled, so it can chat without any setup. The server is only reachable over WireGuard.
- The model list only shows `scipio-*` models (`scipio-code` and `scipio-think`).
- People who save their own server list keep it. Deleting or changing the Scipio server isn't undone on reload.

### Model loading state

- The Scipio server fits only one model in memory at a time, so switching models can delay the first reply by 10–30 seconds. While a model loads, the reply shows "Loading … into memory, this can take up to 30 seconds…" instead of looking frozen. Scipio checks whether the model is loaded at the same moment it sends the message, so the check doesn't slow the reply.

### Known limitations

- The session Controls panel still lets people raise the context length (`num_ctx`) above 16K. That can push the Scipio server past its GPU memory limit, so leave it unset unless you've tested it.
- Data saved in the browser still uses `hollama-*` storage names. Renaming them would make existing browsers lose their chats.
- The update checker and desktop app build settings still point at upstream Hollama.
