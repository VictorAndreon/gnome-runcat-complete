import GLib from 'gi://GLib'

import { listDir, readNumber, readText } from './fs.js'


export type CpuTemperatureSample = {
	// mean over the last AVERAGE_WINDOW_S seconds, °C
	average: number
	// highest reading over the same window, °C
	peak: number
	// maximum junction temperature (TjMax) where the CPU starts throttling, °C
	critical: number | null
}

type Sensor = { input: string, critical: string | null }

// hwmon drivers reporting the CPU package temperature, by priority
const CPU_HWMON_DRIVERS = ['k10temp', 'zenpower', 'coretemp', 'cpu_thermal', 'soc_thermal', 'acpitz']

// thermal zones reporting the CPU temperature, by priority
const CPU_THERMAL_ZONES = ['x86_pkg_temp', 'cpu-thermal', 'soc-thermal', 'acpitz']

// Package temperature jumps by 10–20 °C within milliseconds when the CPU boosts,
// so a single reading per refresh is mostly noise. Readings are taken on their own
// timer and averaged over a rolling window instead.
const AVERAGE_WINDOW_S = 30

// coretemp caches its value for one second, a slightly longer interval makes
// every reading a fresh one instead of every other reading being a cached copy
const READ_INTERVAL_MS = 1_100


/**
 * Find the sysfs files with the CPU temperature (in millidegrees Celsius).
 *
 * @returns {Promise<Sensor | null>} paths to the sensor files, `null` if no sensor was found
 **/
async function findCpuSensor(): Promise<Sensor | null> {
	const hwmons = await listDir('/sys/class/hwmon')

	const found = new Map<string, string>()

	for (const hwmon of hwmons) {
		const path = `/sys/class/hwmon/${hwmon}`
		const name = await readText(`${path}/name`)

		if (name && CPU_HWMON_DRIVERS.includes(name) && !found.has(name)) {
			// temp1 is Tctl for k10temp and "Package id 0" for coretemp
			if (await readNumber(`${path}/temp1_input`) !== null) {
				found.set(name, path)
			}
		}
	}

	for (const driver of CPU_HWMON_DRIVERS) {
		const path = found.get(driver)

		if (path) {
			// coretemp reports TjMax as temp1_crit, most other drivers don't have it
			const hasCritical = await readNumber(`${path}/temp1_crit`) !== null

			return { input: `${path}/temp1_input`, critical: hasCritical ? `${path}/temp1_crit` : null }
		}
	}

	const zones = (await listDir('/sys/class/thermal')).filter(name => name.startsWith('thermal_zone'))

	for (const type of CPU_THERMAL_ZONES) {
		for (const zone of zones) {
			const path = `/sys/class/thermal/${zone}`

			if (await readText(`${path}/type`) === type) {
				return { input: `${path}/temp`, critical: null }
			}
		}
	}

	return null
}


export default class CpuTemperatureProvider {
	#sensor = findCpuSensor()
	#critical: Promise<number | null>
	// [monotonic time in µs, °C]
	#readings: [number, number][] = []
	#timeoutId: number | null = null
	#pendingRead: Promise<void> | null = null

	constructor() {
		this.#critical = this.#sensor.then(async (sensor) => {
			const value = sensor?.critical ? await readNumber(sensor.critical) : null

			return value !== null ? value / 1000 : null
		})

		void this.#read()
		this.#timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READ_INTERVAL_MS, () => {
			void this.#read()

			return GLib.SOURCE_CONTINUE
		})
	}

	#read(): Promise<void> {
		// callers during an in-flight read share it instead of starting another one
		this.#pendingRead ??= this.#readSensor().finally(() => { this.#pendingRead = null })

		return this.#pendingRead
	}

	async #readSensor() {
		const sensor = await this.#sensor
		const value = sensor ? await readNumber(sensor.input) : null

		if (value === null) {
			return
		}

		const now = GLib.get_monotonic_time()

		this.#readings.push([now, value / 1000])
		this.#readings = this.#readings.filter(([time]) => now - time <= AVERAGE_WINDOW_S * 1e6)
	}

	async sample(): Promise<CpuTemperatureSample | null> {
		if (this.#readings.length === 0) {
			// right after start, before the timer had a chance to fire
			await this.#read()
		}

		if (this.#readings.length === 0) {
			return null
		}

		const values = this.#readings.map(([, celsius]) => celsius)

		return {
			average: values.reduce((sum, celsius) => sum + celsius, 0) / values.length,
			peak: Math.max(...values),
			critical: await this.#critical,
		}
	}

	destroy() {
		if (this.#timeoutId !== null) {
			GLib.source_remove(this.#timeoutId)
			this.#timeoutId = null
		}
	}
}
