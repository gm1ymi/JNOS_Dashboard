# JNOS 2.0 Web Dashboard

A real-time web console for [JNOS 2.0](https://en.wikipedia.org/wiki/NOS_(networking_software)) packet radio systems. Tails your JNOS logs and spool files and streams updates to a browser dashboard over WebSockets — no page refresh needed.

## Features

- **System Console** — live tail of the daily JNOS log (system, AX.25, and TCP events), with the last 5 lines loaded on startup and automatic rollover at midnight.
- **AX.25 Trace** — live tail of `trace.log`.
- **MHeard List** — stations heard, with interface, elapsed time since last heard (`DD:HH:MM:SS`), and byte count.
- **BBS / Mailbox Activity** — parsed `queue`/`deliver` events from `mail.log`, showing time, type, sender, recipient, and subject, newest first.
- **Header stats** — real-time JNOS uptime (ticks continuously in the browser, resynced from `AxHeardFile`) and a live MBox Users count (tracked from `MBOX (...) login` / `exit` lines).

## Requirements

- A Linux server (tested on Debian 11) with an existing, running JNOS 2.0 installation
- [Node.js](https://nodejs.org/) 20.x LTS or newer
- npm (bundled with Node.js)
- Read access, for whichever user runs this dashboard, to:
  - `/jnos/logs/` (daily rotated JNOS log files)
  - `/jnos/AxHeardFile`
  - `/jnos/spool/mail.log`
  - `/jnos/trace.log`

### npm dependencies

Installed automatically via `npm install` — declared in `package.json`:

| Package | Purpose |
|---|---|
| [`express`](https://www.npmjs.com/package/express) | Serves the static dashboard page |
| [`socket.io`](https://www.npmjs.com/package/socket.io) | Real-time updates pushed to the browser |
| [`tail`](https://www.npmjs.com/package/tail) | Follows log files as JNOS writes to them |

## Installation

### 1. Install Node.js

Most distro package managers ship an outdated Node version. On Debian/Ubuntu, use NodeSource to get a current LTS release:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v      # should print v20.x.x or newer
npm -v
```

### 2. Get the project files onto the server

Create a directory for the project and upload the files into it, matching this layout exactly:

```
jnos-dashboard/
├── package.json
├── server.js
└── public/
    └── index.html
```

`server.js` and `package.json` go in the project root. **`index.html` must go inside a `public/` subfolder** — the server serves static files from `public/`, so the dashboard won't load if `index.html` is placed anywhere else.

```bash
mkdir -p ~/jnos-dashboard/public
```

Then upload/copy the three files into place, e.g. via `scp` from your local machine:

```bash
scp package.json server.js you@your-server:~/jnos-dashboard/
scp index.html you@your-server:~/jnos-dashboard/public/
```

(Or clone this repo directly on the server with `git clone`, which will already have the correct folder structure.)

### 3. Install dependencies

```bash
cd ~/jnos-dashboard
npm install
```

### 4. Configure file paths

Open `server.js` and confirm these constants match your actual JNOS installation:

```js
const LOG_DIR = '/jnos/logs/';
const HEARD_FILE_PATH = '/jnos/AxHeardFile';
const MAIL_LOG_PATH = '/jnos/spool/mail.log';
const TRACE_LOG_PATH = '/jnos/trace.log';
```

Update any of these if your JNOS install uses different paths. Make sure the user that will run the Node process can **read** all four.

### 5. Test it

```bash
node server.js
```

You should see:

```
JNOS Web Console running on port 3000
```

Open `http://<your-server-ip>:3000` in a browser. Check the terminal output for any file-permission or path errors. Press `Ctrl+C` to stop when done testing.

### 6. Open the firewall port (if applicable)

```bash
sudo ufw allow 3000/tcp
```

### 7. Run it as a persistent service (recommended)

So the dashboard survives reboots and restarts automatically if it crashes. Create `/etc/systemd/system/jnos-dashboard.service`:

```ini
[Unit]
Description=JNOS 2.0 Web Dashboard
After=network.target

[Service]
Type=simple
User=jnosuser
WorkingDirectory=/home/jnosuser/jnos-dashboard
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Replace `jnosuser` and the `WorkingDirectory` path with your actual username/install path — ideally a non-root user that has read access to the JNOS log/spool directories.

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable jnos-dashboard
sudo systemctl start jnos-dashboard
sudo systemctl status jnos-dashboard
```

View logs going forward:

```bash
journalctl -u jnos-dashboard -f
```

## Updating

To deploy a newer version of `server.js` or `public/index.html`, overwrite the file(s) in place and restart the service:

```bash
sudo systemctl restart jnos-dashboard
```

(`index.html` is served statically — a browser hard-refresh may be needed to pick up frontend changes without a service restart, since browsers cache static assets.)

## Known limitations

- **Active socket / port state** has no wired data source yet — JNOS doesn't expose this as a simple file the way MHeard and the logs are read here.
- **MBox Users** count starts at 0 on server startup and is seeded only from the last 5 lines of the day's log, so a user already logged in before the dashboard started won't be reflected until they log out and back in.
