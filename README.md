# Dayloop

A small self-hosted scheduler. You give it tasks; it places them into your working hours by priority, writes them to Google Calendar, and puts anything you miss back in the queue.

Each task has:

- a priority from 1 (critical) to 4 (low)
- a total length
- a smallest piece, the shortest block it may be split into
- optionally the named blocks of hours it may go in
- optionally a deadline: a date it must be done by the end of

You set working hours per weekday, with one-off changes for single dates.

## Named blocks

Each block of hours can be given a name, such as `focus`, `home` or `review`. A task or habit can then be limited to the blocks you pick for it, any number of them:

- Picked `focus`: only planned into focus blocks.
- Picked `focus` and `home`: planned into either, whichever comes first.
- Nothing picked: planned anywhere in your hours, except strict blocks.

A named block has a switch, **Only for work that picks it**. With it on, the block is strict: work with nothing picked stays out, and only tasks and habits that pick the block's name are planned into it. Use it to keep a block for particular work, such as an end-of-day review hour, without having to pick blocks on everything else.

A block with no name takes only work that has nothing picked, and cannot be strict.

Names are yours to choose. They can describe a place, a kind of attention or a time of day.

## Deadlines

Priority decides the order until a deadline is at risk. Dayloop first plans by priority, then checks every task that has a deadline. Any that would not be finished in time is running out of time: it moves ahead of everything else, including priority 1 work and habits, and the plan is rebuilt. Several such tasks go earliest deadline first.

"In time" means the deadline minus a cushion, 24 hours by default (Settings, "Finish deadline work early by"). The cushion leaves room for a missed block; set it to 0 to plan right up to the deadline.

A task that cannot be finished by its deadline even at the front is still planned first, and the Plan and Tasks tabs say it won't be finished in time. An overdue task stays at the front until it is done. A deadline further away than the planning period (14 days by default) has no effect yet.

## Habits

A habit is work that repeats. It is planned into your hours like a task and ranks against tasks by the same priority. There are three kinds:

| Kind | You set | How it is planned |
| --- | --- | --- |
| Every day | time each day | One sitting a day |
| Days a week | number of days, time each day | One sitting a day, on that many different days from Monday to Sunday |
| Hours a week | weekly total, smallest piece, optional most-in-one-day | Pieces across Monday to Sunday, earliest first, up to the daily limit |

A missed sitting is planned again later in the same day or week, like any missed block. What is still undone when the day or week ends lapses; it does not carry over, so a bad week does not leave a pile behind it.

A weekly habit added partway through a week asks for a proportional share of that first week. Within a priority, habits are placed before open-ended tasks because they have a deadline.

How a habit repeats cannot be changed after it is created; delete it and add a new one. Pausing a habit takes its blocks off the plan until you resume it.

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

Open http://localhost:8787 on the machine.

## Where your data lives

Everything is in one SQLite file, `./data/dayloop.db`, next to `docker-compose.yml`: tasks, hours, settings and the Google sign-in. `./data` is an ordinary folder on the machine that the container is given access to. It is not a Docker-managed volume, so `docker compose down`, `down -v`, rebuilding the image and `docker system prune` do not touch it. Deleting the folder itself, or the disk failing, is what would lose it.

### Backups

Dayloop writes a full copy of the database to `./backups` every 24 hours and keeps the newest 14 (`BACKUP_KEEP` in `.env`). It checks on startup and every hour, so a machine that was off catches up when it comes back. Settings shows the last backup and has a **Back up now** button.

Each copy is a complete, standalone SQLite file named `dayloop-YYYYMMDD-HHMMSS.db`. It includes your Google sign-in, so treat the folder as private. Both `data` and `backups` are in `.gitignore`.

These copies protect against a deleted or damaged database. They are on the same disk, so they do not protect against the disk failing; for that, sync `./backups` somewhere else.

To restore:

```sh
docker compose down
cp backups/dayloop-20261201-090000.db data/dayloop.db
rm -f data/dayloop.db-wal data/dayloop.db-shm
docker compose up -d
```

Without Docker, backups go to `data/backups` unless `BACKUP_DIR` is set.

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
| Finish deadline work early by | 24 h | Cushion before a deadline; see Deadlines |
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
| `src/habits.ts` | Turns habits into per-day and per-week task rows; progress |
| `src/google.ts` | Sign-in, busy time, calendar events |
| `src/server.ts` | HTTP API and static files |
| `src/backup.ts` | Daily database copies and retention |
| `public/` | The phone app, plain JavaScript |

## Tested and not tested

The scheduler, the missed-block loop, habits, deadlines, the HTTP API and the phone app were tested, the app in a phone-sized Chrome. The Google Calendar code was written against the API documentation but has not been run against a live Google account, and the Docker image has not been built (its build steps were replayed by hand on Node 22). Expect to debug those two on first run.
