import GLib from 'gi://GLib'
import type NMType from 'gi://NM'

import { LOG_PREFIX } from '../constants.js'
import { pathExists, readText } from './fs.js'


export type ConnectionKind = 'ethernet' | 'wifi' | 'vpn' | 'mobile' | 'bluetooth' | 'other' | 'disconnected' | 'unknown'

export type NetworkSample = {
	kind: ConnectionKind
	// connection name (e.g. Wi-Fi SSID)
	name: string | null
	localIp: string | null
	// bytes per second
	uploadRate: number
	downloadRate: number
}

type Counters = { rx: number, tx: number, timeUs: number }

const connectionKinds: Record<string, ConnectionKind> = {
	'802-3-ethernet': 'ethernet',
	'802-11-wireless': 'wifi',
	'vpn': 'vpn',
	'wireguard': 'vpn',
	'gsm': 'mobile',
	'cdma': 'mobile',
	'bluetooth': 'bluetooth',
}


let NM: typeof NMType | undefined

try {
	({ default: NM } = await import('gi://NM'))
} catch {
	console.error(`${LOG_PREFIX}: NetworkManager bindings are not available, connection info is disabled`)
}


/**
 * Read total rx/tx bytes over physical interfaces (those backed by a device,
 * so that bridges, veth pairs and VPN tunnels don't count traffic twice).
 **/
async function readCounters(): Promise<Counters | null> {
	const contents = await readText('/proc/net/dev')

	if (!contents) {
		return null
	}

	const all = { rx: 0, tx: 0 }
	const physical = { rx: 0, tx: 0, count: 0 }

	for (const line of contents.split('\n').slice(2)) {
		const [iface, data] = line.split(':').map(s => s.trim())

		if (!iface || !data || iface === 'lo') {
			continue
		}

		// Receive: bytes packets errs drop fifo frame compressed multicast | Transmit: bytes …
		const values = data.split(/\s+/).map(n => parseInt(n, 10))
		const rx = values[0] || 0
		const tx = values[8] || 0

		all.rx += rx
		all.tx += tx

		if (pathExists(`/sys/class/net/${iface}/device`)) {
			physical.rx += rx
			physical.tx += tx
			physical.count++
		}
	}

	const { rx, tx } = physical.count > 0 ? physical : all

	return { rx, tx, timeUs: GLib.get_monotonic_time() }
}


export default class NetworkProvider {
	#client: NMType.Client | null = null
	#prevCounters: Counters | null = null
	#destroyed = false

	constructor() {
		if (!NM) {
			return
		}

		const Client = NM.Client

		Client.new_async(null, (_source, result) => {
			try {
				const client = Client.new_finish(result)

				if (!this.#destroyed) {
					this.#client = client
				}
			} catch (e) {
				console.error(`${LOG_PREFIX}: failed to connect to NetworkManager: ${e}`)
			}
		})
	}

	async sample(): Promise<NetworkSample> {
		const counters = await readCounters()

		let uploadRate = 0
		let downloadRate = 0

		if (counters && this.#prevCounters) {
			const seconds = (counters.timeUs - this.#prevCounters.timeUs) / 1e6

			if (seconds > 0) {
				// counters may reset when an interface goes down
				uploadRate = Math.max(0, counters.tx - this.#prevCounters.tx) / seconds
				downloadRate = Math.max(0, counters.rx - this.#prevCounters.rx) / seconds
			}
		}

		this.#prevCounters = counters

		return { ...this.#getConnectionInfo(), uploadRate, downloadRate }
	}

	#getConnectionInfo(): Pick<NetworkSample, 'kind' | 'name' | 'localIp'> {
		if (!this.#client) {
			return { kind: 'unknown', name: null, localIp: null }
		}

		const connection = this.#client.get_primary_connection()

		if (!connection) {
			return { kind: 'disconnected', name: null, localIp: null }
		}

		const address = connection.get_ip4_config()?.get_addresses()[0]
			?? connection.get_ip6_config()?.get_addresses()[0]

		return {
			kind: connectionKinds[connection.get_connection_type()] ?? 'other',
			name: connection.get_id(),
			localIp: address?.get_address() ?? null,
		}
	}

	destroy() {
		this.#destroyed = true
		this.#client = null
	}
}
