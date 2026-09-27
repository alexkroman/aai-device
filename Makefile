# One entry point for every check. Run from an ESP-IDF shell (`. ~/esp/esp-idf-v5.5/export.sh`).
#
#   make check        EVERYTHING that doesn't need the board: lint, firmware builds, host
#                     tests, fuzzing, coverage floor, SDK contract, memory budget, agent tests.
#                     Also warns when firmware changed since the on-device tests last passed.
#   make test-device  on-device Unity tests (board plugged in, `make agent` running)
#   make test-e2e     acoustic end-to-end (production firmware, speakers on, agent running)
#   make format       rewrite C, Python and TS to the house style
#
# Rule: a check that isn't reachable from `make check` will rot. Add new ones there.

FW        := firmware
LLVM      := $(shell brew --prefix llvm 2>/dev/null)/bin
IDF_PY    := $(or $(IDF_PYTHON_ENV_PATH),$(HOME)/.espressif/python_env/idf5.5_py3.11_env)/bin/python
SYSROOT   := --extra-arg=-isysroot$(shell xcrun --show-sdk-path 2>/dev/null)
C_SOURCES := $(shell find $(FW)/main $(FW)/components $(FW)/test -name '*.[ch]' -not -path '*/build*' \
               -not -path '*/managed_components/*')
UNIT_SRCS := $(FW)/components/aai_device/protocol.c \
             $(wildcard $(FW)/test/host/test_*.c)
FUZZ_SRCS := $(wildcard $(FW)/test/fuzz/fuzz_*.c)
FUZZ_SECS ?= 15
DEVICE_STAMP := $(FW)/test/device/.last-pass

.PHONY: check require-idf lint lint-format lint-tidy lint-cppcheck lint-python lint-agent \
        build-firmware test-host test-fuzz test-coverage check-contract check-size test-agent \
        device-freshness test-device test-e2e format agent flash monitor

check: require-idf lint build-firmware test-host test-fuzz test-coverage check-contract check-size \
       test-agent device-freshness
	@printf '\n✅ make check passed\n'

require-idf:
	@test -n "$$IDF_PATH" || { echo "Run from an ESP-IDF shell: . ~/esp/esp-idf-v5.5/export.sh"; exit 1; }

# ---- lint -------------------------------------------------------------------

lint: lint-format lint-tidy lint-cppcheck lint-python lint-agent

lint-format:
	$(LLVM)/clang-format --dry-run --Werror $(C_SOURCES)

lint-tidy: $(FW)/build-host/compile_commands.json $(FW)/build-fuzz/compile_commands.json
	$(LLVM)/clang-tidy -p $(FW)/build-host --quiet $(SYSROOT) $(UNIT_SRCS)
	$(LLVM)/clang-tidy -p $(FW)/build-fuzz --quiet $(SYSROOT) $(FUZZ_SRCS)

# The ESP-dependent modules can't go through clang-tidy (Xtensa flags/asm), so cppcheck
# analyzes them against the real ESP-IDF compile database.
lint-cppcheck: build-firmware
	cppcheck --project=$(FW)/build/compile_commands.json \
	  --file-filter='*/components/aai_device/*' --file-filter='*/main/main.c' \
	  --enable=warning,performance,portability --inline-suppr --error-exitcode=1 -q \
	  --suppress=missingIncludeSystem --suppress='*:*/managed_components/*' \
	  --suppress='*:*/esp-idf-v5.5/*' --check-level=exhaustive

lint-python:
	ruff check $(FW)
	ruff format --check $(FW)

lint-agent:
	cd agent && pnpm run lint

# ---- firmware ---------------------------------------------------------------

# Both apps: production firmware and the on-device test app (-Werror on our code).
build-firmware: require-idf
	cd $(FW) && idf.py build >/dev/null
	cd $(FW)/test/device && idf.py build >/dev/null
	@echo "firmware + test app build clean"

check-size: build-firmware
	cd $(FW) && idf.py size --format json2 --output-file build/size.json >/dev/null
	python3 $(FW)/tools/check_size.py $(FW)/build/size.json $(FW)/build/aai_device.bin $(FW)/partitions.csv

check-contract:
	python3 $(FW)/tools/check_protocol_contract.py $(or $(AAI_SDK),$(HOME)/Code/aai/agent)

# ---- host tests (Homebrew LLVM: only upstream ASan has LeakSanitizer on macOS) --------

$(FW)/build-host/compile_commands.json:
	CC=$(LLVM)/clang cmake -S $(FW)/test/host -B $(FW)/build-host -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON >/dev/null

$(FW)/build-fuzz/compile_commands.json:
	CC=$(LLVM)/clang cmake -S $(FW)/test/host -B $(FW)/build-fuzz -G Ninja -DFUZZ=ON \
	  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON >/dev/null

# ASan + LeakSanitizer + UBSan, all fatal
test-host: $(FW)/build-host/compile_commands.json
	cmake --build $(FW)/build-host
	ctest --test-dir $(FW)/build-host --output-on-failure

# libFuzzer on the network-facing code. The corpus accumulates in build-fuzz/ between
# runs, so every `make check` starts from what previous runs discovered.
test-fuzz: $(FW)/build-fuzz/compile_commands.json
	cmake --build $(FW)/build-fuzz
	@for t in protocol pcm; do \
	  mkdir -p $(FW)/build-fuzz/corpus-$$t; \
	  if ASAN_OPTIONS=detect_leaks=1 LSAN_OPTIONS=suppressions=$(FW)/test/fuzz/lsan.supp \
	    $(FW)/build-fuzz/fuzz_$$t -max_total_time=$(FUZZ_SECS) -artifact_prefix=$(FW)/build-fuzz/ \
	    $(FW)/build-fuzz/corpus-$$t $(FW)/test/fuzz/corpus/$$t 2>$(FW)/build-fuzz/fuzz_$$t.log; then \
	    echo "fuzz_$$t: $$(grep -Eo 'Done [0-9]+ runs' $(FW)/build-fuzz/fuzz_$$t.log), clean"; \
	  else tail -40 $(FW)/build-fuzz/fuzz_$$t.log; echo "fuzz_$$t FAILED; crash input in $(FW)/build-fuzz/"; exit 1; fi; \
	done

test-coverage:
	CC=$(LLVM)/clang cmake -S $(FW)/test/host -B $(FW)/build-cov -G Ninja -DCOVERAGE=ON >/dev/null
	cmake --build $(FW)/build-cov
	rm -f $(FW)/build-cov/*.profraw
	cd $(FW)/build-cov && for t in test_*; do LLVM_PROFILE_FILE=$$t.profraw ./$$t >/dev/null || exit 1; done
	$(LLVM)/llvm-profdata merge -o $(FW)/build-cov/all.profdata $(FW)/build-cov/*.profraw
	$(LLVM)/llvm-cov export -summary-only -instr-profile=$(FW)/build-cov/all.profdata \
	  $(FW)/build-cov/test_protocol > $(FW)/build-cov/summary.json
	python3 $(FW)/tools/check_coverage.py $(FW)/build-cov/summary.json

test-agent:
	cd agent && pnpm test

# The hardware suites can't run without the board, so `make check` at least says so loudly
# when firmware has changed since they last passed.
device-freshness:
	@if [ ! -f $(DEVICE_STAMP) ]; then echo "⚠️  on-device tests have never passed here: run make test-device"; \
	elif [ -n "$$(find $(FW)/main $(FW)/components $(FW)/test/device/main -name '*.[ch]' -newer $(DEVICE_STAMP))" ]; then \
	  echo "⚠️  firmware changed since on-device tests last passed: run make test-device"; \
	else echo "on-device tests are current"; fi

# ---- hardware ---------------------------------------------------------------

test-device: require-idf
	cd $(FW)/test/device && $(IDF_PY) -m pytest && touch .last-pass

test-e2e: require-idf
	cd $(FW)/test/e2e && $(IDF_PY) -m pytest

# ---- dev --------------------------------------------------------------------

format:
	$(LLVM)/clang-format -i $(C_SOURCES)
	ruff check --fix $(FW) && ruff format $(FW)
	cd agent && pnpm run lint:fix

agent:
	cd agent && AAI_DEV_HOST=0.0.0.0 node $(HOME)/Code/aai/agent/packages/aai-cli/bin.mjs dev -p 3000

flash: require-idf
	cd $(FW) && idf.py build flash

monitor: require-idf
	cd $(FW) && idf.py monitor
