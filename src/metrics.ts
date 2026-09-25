import createCpuGenerator, { type CpuSample } from './dataProviders/cpu.js'
import getMemorySample, { type MemorySample } from './dataProviders/memory.js'
import getStorageSample, { type StorageSample } from './dataProviders/storage.js'
import getBatterySample, { type BatterySample } from './dataProviders/battery.js'
import createCpuTemperatureProvider from './dataProviders/temperature.js'
import NetworkProvider, { type NetworkSample } from './dataProviders/network.js'


// Number of samples kept for sparklines
export const HISTORY_LENGTH = 60

export type MetricsSnapshot = {
	cpu: CpuSample
	cpuTemperature: number | null
	memory: MemorySample | null
	storage: StorageSample | null
	battery: BatterySample | null
	network: NetworkSample
	history: {
		cpu: number[]
		memory: number[]
	}
}

const settle = async <T>(promise: Promise<T>, fallback: T): Promise<T> => {
	try {
		return await promise
	} catch (e) {
		console.error(e)

		return fallback
	}
}

const pushLimited = (history: number[], value: number) => {
	history.push(value)

	if (history.length > HISTORY_LENGTH) {
		history.splice(0, history.length - HISTORY_LENGTH)
	}
}


/**
 * Collects all system metrics at once and keeps a short history for charts.
 **/
export default class MetricsSampler {
	#cpu = createCpuGenerator()
	#cpuTemperature = createCpuTemperatureProvider()
	#network = new NetworkProvider()

	#history = { cpu: [] as number[], memory: [] as number[] }

	async sample(storagePath: string): Promise<MetricsSnapshot> {
		const [cpu, cpuTemperature, memory, storage, battery, network] = await Promise.all([
			this.#cpu.next().then(({ value }) => value),
			settle(this.#cpuTemperature(), null),
			settle(getMemorySample(), null),
			settle(getStorageSample(storagePath), null),
			settle(getBatterySample(), null),
			this.#network.sample(),
		])

		pushLimited(this.#history.cpu, cpu.usage)

		if (memory) {
			pushLimited(this.#history.memory, memory.usage)
		}

		return {
			cpu,
			cpuTemperature,
			memory,
			storage,
			battery,
			network,
			history: {
				cpu: [...this.#history.cpu],
				memory: [...this.#history.memory],
			},
		}
	}

	destroy() {
		this.#cpu.return(undefined as never).catch(() => {})
		this.#network.destroy()
	}
}
