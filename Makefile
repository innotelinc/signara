# ==========================================================================
# Signara — developer workflow
# Usage: make <target>   (see `make help`)
# ==========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help install dev dev:api dev:web build lint test typecheck \
        db:generate db:migrate db:seed db:studio \
        up up:dev up:prod down logs ps \
        backup backup:now restore \
        nginx:hosts nginx:cert \
        release docs

help: ## Show this help message
	@echo "Signara — developer workflow"
	@echo "Usage: make <target>"
	@grep -E '^[a-zA-Z_:%-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## ---- Local development ---------------------------------------------------

install: ## Install all workspace dependencies
	npm install

dev: ## Run API + web in watch mode (requires local Postgres/Redis/MinIO, or use `make up:dev`)
	npm run dev

dev:api: ## Run only the API in watch mode
	npm run dev -w @signara/api

dev:web: ## Run only the web app in watch mode
	npm run dev -w @signara/web

build: ## Build all workspaces
	npm run build

lint: ## Lint all workspaces
	npm run lint

test: ## Run all tests
	npm run test

typecheck: ## Typecheck all workspaces
	npm run typecheck

## ---- Database ------------------------------------------------------------

db:generate: ## Generate Prisma client from schema
	npm run db:generate -w @signara/database

db:migrate: ## Apply pending Prisma migrations
	npm run db:migrate -w @signara/database

db:seed: ## Seed the database with bootstrap data
	npm run db:seed -w @signara/database

db:studio: ## Open Prisma Studio against the database
	npm run db:studio -w @signara/database

## ---- Docker Compose ------------------------------------------------------

up: ## Start the full development stack (docker-compose.dev.yml)
	docker compose -f docker-compose.dev.yml up -d --build

up:dev: up ## Alias for `make up`

up:prod: ## Start the production stack (docker-compose.prod.yml)
	docker compose -f docker-compose.prod.yml up -d --build

down: ## Stop and remove all services (keeps volumes)
	docker compose -f docker-compose.dev.yml down

logs: ## Tail logs from all services
	docker compose -f docker-compose.dev.yml logs -f

ps: ## List service status
	docker compose -f docker-compose.dev.yml ps

## ---- Backup / Restore ----------------------------------------------------

backup: ## Run the backup job (Postgres + MinIO) against the production stack
	docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh

backup:now: backup ## Alias for `make backup`

restore: ## Restore the latest backup (interactive)
	docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh

## ---- NGINX Proxy Manager automation --------------------------------------

nginx:hosts: ## Create/update the four proxy hosts via NGINX Proxy Manager API
	python3 infra/nginx/npm-proxy-hosts.py --apply

nginx:cert: ## Request the wildcard Let's Encrypt certificate via NPM
	python3 infra/nginx/npm-proxy-hosts.py --cert-only

## ---- Release -------------------------------------------------------------

release: ## Tag a new release (e.g. `make release VERSION=0.1.0`)
	@test -n "$(VERSION)" || (echo "Usage: make release VERSION=x.y.z" && exit 1)
	git tag -a v$(VERSION) -m "Release v$(VERSION)"
	git push origin v$(VERSION)