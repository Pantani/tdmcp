.PHONY: lint lint-fix

lint:
	npm run lint
	npm run lint:py
	npm run lint:recipes

lint-fix:
	npm run lint:fix || true
	npm run lint:py:fix || true
	$(MAKE) lint
