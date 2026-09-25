import { readText } from './fs.js'


export type MemorySample = {
	// utilization in [0, 1]
	usage: number
	// all sizes are in bytes
	total: number
	used: number
	available: number
	cached: number
	swapTotal: number
	swapUsed: number
}


/**
 * Sample memory usage from `/proc/meminfo`, the same way `free` and GNOME System Monitor do:
 * used memory is everything that is not reported as available.
 **/
export default async function getMemorySample(): Promise<MemorySample | null> {
	const contents = await readText('/proc/meminfo')

	if (!contents) {
		return null
	}

	const info: Record<string, number> = {}

	for (const line of contents.split('\n')) {
		const match = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line)

		if (match) {
			// values are in KiB
			info[match[1]] = parseInt(match[2], 10) * 1024
		}
	}

	const total = info['MemTotal'] ?? 0

	if (total <= 0) {
		return null
	}

	const available = info['MemAvailable'] ?? (info['MemFree'] ?? 0) + (info['Cached'] ?? 0)
	const used = Math.max(0, total - available)

	return {
		usage: used / total,
		total,
		used,
		available,
		cached: (info['Cached'] ?? 0) + (info['Buffers'] ?? 0) + (info['SReclaimable'] ?? 0),
		swapTotal: info['SwapTotal'] ?? 0,
		swapUsed: Math.max(0, (info['SwapTotal'] ?? 0) - (info['SwapFree'] ?? 0)),
	}
}
