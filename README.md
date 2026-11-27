# Dayloop

A small self-hosted scheduler. You give it tasks; it places them into your working hours by priority, writes them to Google Calendar, and puts anything you miss back in the queue.

Each task has:

- a priority from 1 (critical) to 4 (low)
- a total length
- a smallest piece, the shortest block it may be split into
- optionally a place it has to happen

You set working hours per weekday, with one-off changes for single dates, and can tag each stretch of hours with a place. A task that needs a place is only planned into hours tagged with that place. Hours with no tag take only tasks that need no place.

## How planning works

Every 5 minutes, and after every change, Dayloop rebuilds the plan from the current time:

1. Free time is your hours minus busy time on the Google calendars you pick.
2. Tasks are placed in priority order, oldest first within a priority, each into the earliest free time that fits. No piece is shorter than the task's smallest piece.
3. A block that ends without being marked done gets a grace period (15 minutes by default). After that it counts as missed: it is removed and its time is planned again, later the same day if hours remain, otherwise the next day you have hours.
4. Only the difference is pushed to Google Calendar, so blocks that did not move keep their events.

In the app, a block under way offers **Done** and **Not now**. Not now holds the task until that block would have ended, then plans it again.

## Run it

Needs Docker with the Compose plugin.

```sh
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:8787 on the machine. Data lives in `./data/dayloop.db`; back up that one file.

Without Docker: `npm ci && npm run build && npm start` on Node 22.13 or newer.

## Reach it from your phone

Dayloop has no login. Do not expose it to the internet or your LAN; the Compose file binds it to the machine itself, and Tailscale makes it reachable from your own devices only.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8787
```

`tailscale serve` prints an address like `https://yourbox.your-tailnet.ts.net`. It needs MagicDNS and HTTPS certificates turned on in the Tailscale admin console. Install Tailscale on the phone, open that address in Safari, and use Share > Add to Home Screen.

Set `BASE_URL` in `.env` to that address, then `docker compose up -d` again.

## Connect Google Calendar

One-time setup in [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project and enable the **Google Calendar API**.
2. Under Google Auth Platform, set the app name, choose audience **External**, and **publish the app** (status "In production"). In Testing status Google expires the sign-in every 7 days. No verification is needed for your own use; you will click through an "unverified app" warning once.
3. Create an OAuth client of type **Web application**. Add the redirect URI shown in Dayloop's Settings tab: `BASE_URL` followed by `/oauth/callback`.
4. Put the client ID and secret in `.env` and run `docker compose up -d`.
5. In Dayloop, open Settings and choose **Connect Google Calendar**. Sign in as the account whose calendar you use.

Dayloop then creates a calendar called "Dayloop" for its blocks. On an iPhone it shows up in Apple Calendar under that Gmail account. If it does not, tick it at https://calendar.google.com/calendar/syncselect.

What Dayloop can do with your account is deliberately limited to three things: see when you are busy (not what the events are), list your calendars so you can choose which ones block time, and manage the calendar it created. It cannot read or change your own events.

## Keep the machine on

```sh
sudo systemctl enable --now docker
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Make Linux the default boot entry, and in the BIOS set the machine to power on after a power cut. `restart: unless-stopped` in the Compose file brings Dayloop back after reboots.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Count a block as missed after | 15 min | Grace period after a block ends |
| Gap between blocks | 0 min | Breathing room after each block |
| Plan ahead | 14 days | How far the plan reaches |
| Phone alert | When it starts | Calendar notification per block |
| Time zone | from `TZ` | Zone your hours are written in |

## Development

```sh
npm install
npm run dev     # server with reload on http://localhost:8787
npm test        # scheduler and planning-loop tests
```

| File | Role |
| --- | --- |
| `src/scheduler.ts` | The planning algorithm. Pure function, no I/O. |
| `src/hours.ts` | Turns weekly hours and one-off days into time windows |
| `src/planner.ts` | The loop: sweep missed blocks, plan, save, sync |
| `src/google.ts` | Sign-in, busy time, calendar events |
| `src/server.ts` | HTTP API and static files |
| `public/` | The phone app, plain JavaScript |

## Tested and not tested

The scheduler, the missed-block loop, the HTTP API and the phone app were tested, the app in a phone-sized Chrome. The Google Calendar code was written against the API documentation but has not been run against a live Google account, and the Docker image has not been built (its build steps were replayed by hand on Node 22). Expect to debug those two on first run.
