# @yemreak/chrome-cdp

## Usage

```bash
# Install
bun install -g @yemreak/chrome-cdp

# Start Chrome in debug mode
chrome-cdp start
→ Chrome starting (port 9222)

# List tabs
chrome-cdp tabs
→ [{"id":"...","type":"page","title":"Google",...}]

# Execute JavaScript
chrome-cdp eval "document.title"
→ "Google"

chrome-cdp eval "document.querySelector('h1').textContent"
→ "Welcome"

# Take screenshot
chrome-cdp screenshot page.png
→ page.png

# Save HTML snapshot
chrome-cdp snapshot page.html
→ page.html

# Console logs
chrome-cdp console
→ [{"type":"log","args":["Hello"],"ts":1234567890}]

chrome-cdp console clear
→ []

# Network monitoring
chrome-cdp network 10
→ [{"url":"...","method":"GET","status":200}]

# Performance emulation
chrome-cdp emulate cpu 4
→ CPU throttling: 4x slowdown

chrome-cdp emulate network 3g
→ Network: 3g (↓750kb/s ↑250kb/s RTT:100ms)

chrome-cdp emulate device 375 667
→ Viewport: 375x667 @2x

# Performance trace
chrome-cdp trace 5 performance.json
→ Performance trace started (5s)...
→ performance.json

# Reset emulation
chrome-cdp reset
→ Emulation reset: cpu=1x, network=normal, viewport=default
```

## What This Does

Control Chrome via DevTools Protocol. Automation, testing, debugging - no Selenium, no Puppeteer.

**Pattern:**
- Chrome runs in debug mode (port 9222)
- CDP commands via WebSocket
- Direct browser control (eval JS, screenshot, network, performance)

**Why it works:**
- Native Chrome protocol (no third-party wrapper)
- WebSocket commands (instant response)
- Works with existing Chrome instance (no headless launch)
- Perfect for automation/testing/debugging

**Example flow:**
```bash
# Start debug Chrome
chrome-cdp start

# Open page manually or automate
chrome-cdp eval "window.location = 'https://example.com'"

# Wait for load
chrome-cdp eval "await new Promise(r => setTimeout(r, 2000))"

# Extract data
chrome-cdp eval "Array.from(document.querySelectorAll('a')).map(a => a.href)"

# Screenshot
chrome-cdp screenshot result.png
```

## How to Build

```typescript
// Chrome DevTools Protocol
// Start Chrome: chrome --remote-debugging-port=9222

// List tabs
const response = await fetch('http://127.0.0.1:9222/json')
const tabs = await response.json()

// Connect via WebSocket
const ws = new WebSocket(tabs[0].webSocketDebuggerUrl)

// Execute command
ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: 'document.title',
    returnByValue: true
  }
}))

// Receive result
ws.onmessage = (event) => {
  const { result } = JSON.parse(event.data)
  console.log(result.value)
}
```

**API Docs:** https://chromedevtools.github.io/devtools-protocol/

**Environment:**
- `CHROME_TAB_ID` - Target specific tab
- `CHROME_CDP_PORT` - Custom port (default: 9222)
- `CHROME_EVAL_TIMEOUT` - Timeout ms (default: 30000)

**License:** Apache-2.0
