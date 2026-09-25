import { listDir, readNumber, readText } from './fs.js'


// hwmon drivers reporting the CPU package temperature, by priority
const CPU_HWMON_DRIVERS = ['k10temp', 'zenpower', 'coretemp', 'cpu_thermal', 'soc_thermal', 'acpitz']

// thermal zones reporting the CPU temperature, by priority
const CPU_THERMAL_ZONES = ['x86_pkg_temp', 'cpu-thermal', 'soc-thermal', 'acpitz']


/**
 * Find the sysfs file with the CPU temperature (in millidegrees Celsius).
 *
 * @returns {Promise<string | null>} path to the temperature file, `null` if no sensor was found
 **/
async function findCpuSensor(): Promise<string | null> {
	const hwmons = await listDir('/sys/class/hwmon')

	const found = new Map<string, string>()

	for (const hwmon of hwmons) {
		const path = `/sys/class/hwmon/${hwmon}`
		const name = await readText(`${path}/name`)

		if (name && CPU_HWMON_DRIVERS.includes(name) && !found.has(name)) {
			// temp1 is Tctl for k10temp and "Package id 0" for coretemp
			if (await readNumber(`${path}/temp1_input`) !== null) {
				found.set(name, `${path}/temp1_input`)
			}
		}
	}

	for (const driver of CPU_HWMON_DRIVERS) {
		const path = found.get(driver)

		if (path) {
			return path
		}
	}

	const zones = (await listDir('/sys/class/thermal')).filter(name => name.startsWith('thermal_zone'))

	for (const type of CPU_THERMAL_ZONES) {
		for (const zone of zones) {
			const path = `/sys/class/thermal/${zone}`

			if (await readText(`${path}/type`) === type) {
				return `${path}/temp`
			}
		}
	}

	return null
}


export default function createCpuTemperatureProvider() {
	let sensorPath: Promise<string | null> | null = null

	return async (): Promise<number | null> => {
		sensorPath ??= findCpuSensor()

		const path = await sensorPath

		if (!path) {
			return null
		}

		const value = await readNumber(path)

		return value !== null ? value / 1000 : null
	}
}
