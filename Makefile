# Shortcuts for running Dayloop on the home box. Run `make` to list them.

.DEFAULT_GOAL := help
.PHONY: help update up down restart logs status test

help: ## List these commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-9s %s\n", $$1, $$2}'

# Pull first, then rebuild. `up -d --build` swaps the running container for
# the new one by itself, so the app stays up while the image builds, and if
# the pull or the build fails the old version keeps running.
update: ## Get the latest code from main and restart on it
	git pull --ff-only origin main
	docker compose up -d --build
	@docker compose ps

up: ## Start (or rebuild and restart) the app
	docker compose up -d --build

down: ## Stop the app. Data and backups stay on disk
	docker compose down

restart: ## Restart without rebuilding, e.g. after editing .env
	docker compose up -d --force-recreate

logs: ## Follow the app's log. Ctrl-C to stop watching
	docker compose logs -f --tail=100

status: ## Show whether the app is running
	@docker compose ps

test: ## Run the test suite (needs Node 22.13+ and `npm install`)
	npm test
