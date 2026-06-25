.PHONY: lint lint-fix complexity complexity-py complexity-js complexity-cognitive

lint:
	npm run lint
	npm run lint:py
	npm run lint:recipes

lint-fix:
	npm run lint:fix || true
	npm run lint:py:fix || true
	$(MAKE) lint

complexity:
	@status=0; \
	$(MAKE) complexity-py || status=$$?; \
	$(MAKE) complexity-js || status=$$?; \
	$(MAKE) complexity-cognitive || status=$$?; \
	exit $$status

complexity-py:
	npm run complexity:py

complexity-js:
	npm run complexity:js

complexity-cognitive:
	npm run complexity:cognitive
