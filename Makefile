SWIFT_SOURCES := $(wildcard agents/macos/Sources/*.swift)
AGENT_BIN     := agents/macos/build/cairn-agent-macos
SWIFT_TARGET  := $(shell /usr/bin/uname -m)-apple-macos13.0

$(AGENT_BIN): $(SWIFT_SOURCES)
	@mkdir -p $(dir $@)
	swiftc -O -whole-module-optimization -target $(SWIFT_TARGET) -framework AppKit -framework Carbon -o $@ $(SWIFT_SOURCES)

.PHONY: agent clean
agent: $(AGENT_BIN)
clean:
	rm -rf agents/macos/build
