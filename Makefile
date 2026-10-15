.PHONY: check accept test lint

check:
	@if command -v bun >/dev/null 2>&1; then \
		bun install && bun run check; \
	else \
		echo "bun not found; falling back to npm + tsc + biome (best effort)"; \
		npm install --no-audit --no-fund; \
		npx --no-install tsc --noEmit 2>/dev/null || npx tsc --noEmit; \
		npx --no-install @biomejs/biome check . 2>/dev/null || npx @biomejs/biome check .; \
		npm test; \
	fi

accept:
	@for w in 1 2 3; do \
		if [ -f "scripts/accept/wave-$$w.sh" ]; then \
			echo "--- accept: wave-$$w ---"; \
			bash "scripts/accept/wave-$$w.sh" || exit 1; \
		else \
			echo "warning: scripts/accept/wave-$$w.sh not yet implemented; skipping"; \
		fi; \
	done

test:
	@if command -v bun >/dev/null 2>&1; then \
		bun test --pass-with-no-tests; \
	else \
		npm test; \
	fi

lint:
	@if command -v bun >/dev/null 2>&1; then \
		bun run lint 2>/dev/null || bunx --bun @biomejs/biome check .; \
	else \
		npx @biomejs/biome check .; \
	fi
