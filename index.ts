#!/usr/bin/env bun

const [command, ...args] = process.argv.slice(2)
const TAB_ID = process.env.CHROME_TAB_ID

if (!command || command === '--help' || command === '-h') {
	console.log(`Usage: chrome-cdp <command> [OPTIONS]

BEHAVIOURS:
  # First setup:
  chrome-cdp start
  → Chrome started in debug mode (port 9222)
  chrome-cdp tabs
  → [{"id":"...","type":"page","title":"Google",...}]

  # Page inspect:
  chrome-cdp eval "document.title"
  → "Google"
  chrome-cdp screenshot [file.png]
  chrome-cdp snapshot [file.html]
  chrome-cdp console
  chrome-cdp console clear

  # Network debug:
  chrome-cdp network [duration]
  → [{"url":"...","method":"GET","status":200}]

  # Performance test:
  chrome-cdp emulate cpu 4
  chrome-cdp emulate network 3g
  chrome-cdp emulate device 375 667
  chrome-cdp trace [duration] [file.json]
  chrome-cdp reset
  → Reset emulation

ENVIRONMENT:
  CHROME_TAB_ID        Specific tab (eval/screenshot/snapshot)
  CHROME_CDP_PORT      Custom port (default: 9222)
  CHROME_EVAL_TIMEOUT  Timeout ms (default: 30000)`)
	process.exit(2)
}

const AVAILABLE_COMMANDS = ['start', 'tabs', 'eval', 'screenshot', 'snapshot', 'console', 'network', 'emulate', 'trace', 'reset'] as const

if (!AVAILABLE_COMMANDS.includes(command as any)) {
	throw new Error(`Unknown command: ${command}\nAvailable: ${AVAILABLE_COMMANDS.join(', ')}`)
}

type CDPTab = {
	id: string
	type: string
	title: string
	url: string
	webSocketDebuggerUrl: string
}

async function getCDPTabs(params: { port: number }): Promise<CDPTab[]> {
	const response = await fetch(`http://127.0.0.1:${params.port}/json`)
	if (!response.ok) {
		throw new Error(`CDP not available on port ${params.port}. Start Chrome with: chrome --remote-debugging-port=${params.port}`)
	}
	return (await response.json()) as CDPTab[]
}

async function getActiveTab(params: { port: number; tabId?: string }): Promise<CDPTab> {
	const tabs = await getCDPTabs({ port: params.port })

	if (params.tabId) {
		const tab = tabs.find(t => t.id === params.tabId)
		if (!tab) throw new Error(`Tab not found: ${params.tabId}`)
		return tab
	}

	const pageTabs = tabs.filter(t => t.type === 'page')
	if (pageTabs.length === 0) {
		throw new Error('No page tabs found')
	}

	return pageTabs[0]!
}

async function executeCDP(params: { wsUrl: string; method: string; params?: Record<string, unknown>; timeout?: number }): Promise<any> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(params.wsUrl)
		const id = 1

		const timeoutMs = params.timeout || 30000
		const timeout = setTimeout(() => {
			ws.close()
			reject(new Error(`CDP request timeout (${timeoutMs}ms)`))
		}, timeoutMs)

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: params.method,
					params: params.params || {}
				})
			)
		}

		ws.onmessage = event => {
			const response = JSON.parse(event.data)
			if (response.id === id) {
				clearTimeout(timeout)
				if (response.error) {
					const errorMsg = [
						'CDP Error:',
						`  Message: ${response.error.message}`,
						response.error.code ? `  Code: ${response.error.code}` : '',
						response.error.data ? `  Data: ${JSON.stringify(response.error.data)}` : ''
					]
						.filter(Boolean)
						.join('\n')
					reject(new Error(errorMsg))
				} else {
					resolve(response.result)
				}
				ws.close()
			}
		}

		ws.onerror = () => {
			clearTimeout(timeout)
			ws.close()
			reject(new Error('WebSocket connection failed'))
		}
	})
}

const CDP_PORT = parseInt(process.env.CHROME_CDP_PORT || '9222')

try {
	if (command === 'start') {
		const testResponse = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).catch(() => null)

		if (testResponse?.ok) {
			console.log(`Chrome already running (port ${CDP_PORT})`)
			process.exit(0)
		}

		Bun.spawn(['sh', '-c', `nohup '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=${CDP_PORT} --user-data-dir="${process.env.HOME}/Library/Application Support/Google/Chrome-Debug" > /dev/null 2>&1 &`], {
			stdout: 'ignore',
			stderr: 'ignore'
		})

		console.log(`Chrome starting (port ${CDP_PORT})`)
	} else if (command === 'tabs') {
		const tabs = await getCDPTabs({ port: CDP_PORT })
		console.log(JSON.stringify(tabs, null, 2))
	} else if (command === 'eval') {
		let code = args[0]

		if (code === '-') {
			code = await Bun.stdin.text()
		}

		if (!code) {
			throw new Error('Code string required')
		}

		if (/\bawait\b/.test(code) && !/^\s*\(?\s*async\s*\(/.test(code)) {
			const hasExplicitReturn = /\breturn\b/.test(code)
			code = hasExplicitReturn ? `(async () => { ${code} })()` : `(async () => { return (${code}) })()`
		}

		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })

		let result
		try {
			result = await executeCDP({
				wsUrl: tab.webSocketDebuggerUrl,
				method: 'Runtime.evaluate',
				params: {
					expression: code,
					returnByValue: true,
					awaitPromise: true
				},
				timeout: parseInt(process.env.CHROME_EVAL_TIMEOUT || '30000')
			})
		} catch (error) {
			if (error instanceof Error && error.message.includes('timeout')) {
				const helpMsg = [
					error.message,
					'',
					'Tab may be frozen (e.g., infinite loop).',
					`Tab ID: ${tab.id}`,
					'',
					'To recover:',
					'  1. Close frozen tab manually in Chrome',
					'  2. Or use: chrome-cdp tabs'
				].join('\n')
				throw new Error(helpMsg)
			}
			throw error
		}

		if (result.exceptionDetails) {
			const ex = result.exceptionDetails
			const errorLines = [
				`${ex.text}`,
				ex.exception?.description || ex.exception?.value || '',
				ex.url ? `  at ${ex.url}:${ex.lineNumber}:${ex.columnNumber}` : '',
				ex.stackTrace ? '\nStack trace:' : '',
				...(ex.stackTrace?.callFrames.map((f: any) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`) || [])
			]
				.filter(Boolean)
				.join('\n')
			throw new Error(errorLines)
		}

		console.log(JSON.stringify(result.result.value, null, 2))
	} else if (command === 'screenshot') {
		const filename = args[0] || 'screenshot.png'

		if (await Bun.file(filename).exists()) {
			throw new Error(`File exists: ${filename}`)
		}

		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })
		const result = await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Page.captureScreenshot',
			params: { format: 'png' }
		})

		const buffer = Buffer.from(result.data, 'base64')
		await Bun.write(filename, buffer)
		console.log(filename)
	} else if (command === 'snapshot') {
		const filename = args[0] || 'snapshot.html'

		if (await Bun.file(filename).exists()) {
			throw new Error(`File exists: ${filename}`)
		}

		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })
		const result = await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Runtime.evaluate',
			params: {
				expression: 'document.documentElement.outerHTML',
				returnByValue: true
			}
		})

		await Bun.write(filename, result.result.value)
		console.log(filename)
	} else if (command === 'console') {
		const subcommand = args[0]
		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })

		if (subcommand === 'clear') {
			await executeCDP({
				wsUrl: tab.webSocketDebuggerUrl,
				method: 'Runtime.evaluate',
				params: {
					expression: `
						window.__consoleLogs = []
						sessionStorage.removeItem('__consoleLogs')
						'Console cleared'
					`,
					returnByValue: true
				}
			})
			console.log('[]')
			process.exit(0)
		}

		await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Runtime.evaluate',
			params: {
				expression: `
					if (!window.__consoleLogs) {
						window.__consoleLogs = []

						const persist = () => sessionStorage.setItem('__consoleLogs', JSON.stringify(window.__consoleLogs))

						try {
							const stored = sessionStorage.getItem('__consoleLogs')
							if (stored) window.__consoleLogs = JSON.parse(stored)
						} catch {}

						const orig = {
							log: console.log,
							error: console.error,
							warn: console.warn
						}
						console.log = (...args) => {
							window.__consoleLogs.push({type:'log', args, ts: Date.now()})
							persist()
							orig.log(...args)
						}
						console.error = (...args) => {
							window.__consoleLogs.push({type:'error', args, ts: Date.now()})
							persist()
							orig.error(...args)
						}
						console.warn = (...args) => {
							window.__consoleLogs.push({type:'warn', args, ts: Date.now()})
							persist()
							orig.warn(...args)
						}
					}
				`,
				returnByValue: true
			}
		})

		const result = await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Runtime.evaluate',
			params: {
				expression: 'window.__consoleLogs || []',
				returnByValue: true
			}
		})

		console.log(JSON.stringify(result.result.value, null, 2))
	} else if (command === 'network') {
		const duration = parseInt(args[0] || '0') || 5
		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })
		const ws = new WebSocket(tab.webSocketDebuggerUrl)
		const requests: Array<{ url: string; method: string; status: number }> = []

		ws.onopen = () => {
			ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }))
		}

		ws.onmessage = event => {
			const message = JSON.parse(event.data)
			if (message.method === 'Network.responseReceived') {
				const { url, method, status } = message.params.response
				requests.push({ url, method, status })
			}
		}

		const networkTimeout = setTimeout(() => {
			console.log(JSON.stringify(requests, null, 2))
			ws.close()
			process.exit(0)
		}, duration * 1000)

		ws.onerror = () => {
			clearTimeout(networkTimeout)
			ws.close()
		}
	} else if (command === 'emulate') {
		const subcommand = args[0]
		if (!subcommand) {
			throw new Error('Emulate subcommand required\nAvailable: cpu, network, device')
		}

		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })

		if (subcommand === 'cpu') {
			const rate = parseFloat(args[1] || '0')
			if (!rate || rate < 1) {
				throw new Error('CPU throttling rate must be >= 1 (e.g., 4 for 4x slowdown)')
			}

			await executeCDP({
				wsUrl: tab.webSocketDebuggerUrl,
				method: 'Emulation.setCPUThrottlingRate',
				params: { rate }
			})

			console.log(`CPU throttling: ${rate}x slowdown`)
		} else if (subcommand === 'network') {
			const preset = args[1]
			if (!preset) {
				throw new Error('Network preset required (offline, 3g, 4g, wifi)')
			}

			type NetworkProfile = { offline: boolean; downloadThroughput: number; uploadThroughput: number; latency: number }
		const profiles: Record<string, NetworkProfile> = {
				offline: { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 },
				'3g': { offline: false, downloadThroughput: (750 * 1024) / 8, uploadThroughput: (250 * 1024) / 8, latency: 100 },
				'4g': { offline: false, downloadThroughput: (4 * 1024 * 1024) / 8, uploadThroughput: (3 * 1024 * 1024) / 8, latency: 20 },
				wifi: { offline: false, downloadThroughput: (30 * 1024 * 1024) / 8, uploadThroughput: (15 * 1024 * 1024) / 8, latency: 2 }
			}

			const profile = profiles[preset]
			if (!profile) {
				throw new Error(`Unknown network preset: ${preset}\nAvailable: ${Object.keys(profiles).join(', ')}`)
			}

			await executeCDP({
				wsUrl: tab.webSocketDebuggerUrl,
				method: 'Network.emulateNetworkConditions',
				params: profile
			})

			console.log(
				`Network: ${preset} (${profile.offline ? 'offline' : `↓${Math.round((profile.downloadThroughput * 8) / 1024)}kb/s ↑${Math.round((profile.uploadThroughput * 8) / 1024)}kb/s RTT:${profile.latency}ms`})`
			)
		} else if (subcommand === 'device') {
			const width = parseInt(args[1] || '0')
			const height = parseInt(args[2] || '0')
			const deviceScaleFactor = parseFloat(args[3] || '2')

			if (!width || !height) {
				throw new Error('Device emulation requires width and height (e.g., chrome-cdp emulate device 375 667)')
			}

			await executeCDP({
				wsUrl: tab.webSocketDebuggerUrl,
				method: 'Emulation.setDeviceMetricsOverride',
				params: {
					width,
					height,
					deviceScaleFactor,
					mobile: true
				}
			})

			console.log(`Viewport: ${width}x${height} @${deviceScaleFactor}x`)
		} else {
			throw new Error(`Unknown emulate subcommand: ${subcommand}\nAvailable: cpu, network, device`)
		}
	} else if (command === 'trace') {
		const duration = parseInt(args[0] || '0') || 5
		const filename = args[1] || 'trace.json'

		if (await Bun.file(filename).exists()) {
			throw new Error(`File exists: ${filename}`)
		}

		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })

		const ws = new WebSocket(tab.webSocketDebuggerUrl)
		const chunks: any[] = []
		let traceId = 1

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: traceId++,
					method: 'Tracing.start',
					params: {
						categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler,v8.execute'
					}
				})
			)

			console.log(`Performance trace started (${duration}s)...`)

			setTimeout(() => {
				ws.send(
					JSON.stringify({
						id: traceId++,
						method: 'Tracing.end'
					})
				)
			}, duration * 1000)
		}

		ws.onmessage = event => {
			const message = JSON.parse(event.data)

			if (message.method === 'Tracing.dataCollected') {
				chunks.push(...message.params.value)
			} else if (message.method === 'Tracing.tracingComplete') {
				clearTimeout(traceTimeout)
				const trace = JSON.stringify(chunks, null, 2)
				Bun.write(filename, trace).then(() => {
					console.log(filename)
					ws.close()
					process.exit(0)
				})
			}
		}

		const traceTimeout = setTimeout(
			() => {
				ws.close()
				throw new Error('Trace timeout')
			},
			(duration + 5) * 1000
		)

		ws.onerror = () => {
			clearTimeout(traceTimeout)
			ws.close()
		}
	} else if (command === 'reset') {
		const tab = await getActiveTab({ port: CDP_PORT, tabId: TAB_ID })

		await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Emulation.setCPUThrottlingRate',
			params: { rate: 1 }
		})

		await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Network.emulateNetworkConditions',
			params: {
				offline: false,
				downloadThroughput: -1,
				uploadThroughput: -1,
				latency: 0
			}
		})

		await executeCDP({
			wsUrl: tab.webSocketDebuggerUrl,
			method: 'Emulation.clearDeviceMetricsOverride'
		})

		console.log('Emulation reset: cpu=1x, network=normal, viewport=default')
	}
} catch (error) {
	console.error('Error:', error instanceof Error ? error.message : String(error))
	process.exit(1)
}

export {}
