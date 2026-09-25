import { listDir, readNumber, readText } from './fs.js'


const POWER_SUPPLY_ROOT = '/sys/class/power_supply'

export type BatteryStatus = 'charging' | 'discharging' | 'full' | 'not-charging' | 'unknown'

export type BatterySample = {
	// charge level in [0, 1]
	level: number
	status: BatteryStatus
	isOnAcPower: boolean
	// full charge capacity relative to the design capacity, in [0, 1]
	health: number | null
	cycleCount: number | null
	// power draw in watts
	powerW: number | null
	// seconds until empty (discharging) or full (charging)
	timeRemainingS: number | null
	temperatureC: number | null
}

const statusMap: Record<string, BatteryStatus> = {
	'charging': 'charging',
	'discharging': 'discharging',
	'full': 'full',
	'not charging': 'not-charging',
}


/**
 * Sample the system battery via sysfs, see
 * https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-class-power
 *
 * @returns {Promise<BatterySample | null>} battery info, `null` if there is no system battery
 **/
export default async function getBatterySample(): Promise<BatterySample | null> {
	const supplies = await listDir(POWER_SUPPLY_ROOT)

	let batteryPath: string | null = null
	let isOnAcPower = false

	for (const name of supplies) {
		const path = `${POWER_SUPPLY_ROOT}/${name}`
		const type = await readText(`${path}/type`)

		if (type === 'Mains' || type === 'USB') {
			isOnAcPower ||= await readNumber(`${path}/online`) === 1
		}

		// `scope == Device` means a battery of a peripheral (mouse, headphones, …)
		if (type === 'Battery' && batteryPath === null && await readText(`${path}/scope`) !== 'Device') {
			batteryPath = path
		}
	}

	if (batteryPath === null) {
		return null
	}

	const read = (attribute: string) => readNumber(`${batteryPath}/${attribute}`)

	const [
		capacity, statusText, cycleCount, temperature,
		energyNow, energyFull, energyFullDesign, powerNow,
		chargeNow, chargeFull, chargeFullDesign, currentNow, voltageNow,
	] = await Promise.all([
		read('capacity'), readText(`${batteryPath}/status`), read('cycle_count'), read('temp'),
		read('energy_now'), read('energy_full'), read('energy_full_design'), read('power_now'),
		read('charge_now'), read('charge_full'), read('charge_full_design'), read('current_now'), read('voltage_now'),
	])

	const status = statusMap[statusText?.toLowerCase() ?? ''] ?? 'unknown'

	// energy_* are µWh / power_now is µW; charge_* are µAh / current_now is µA
	const now = energyNow ?? chargeNow
	const full = energyFull ?? chargeFull
	const fullDesign = energyFullDesign ?? chargeFullDesign
	const rate = energyNow !== null ? powerNow : currentNow

	let powerW: number | null = null

	if (powerNow !== null) {
		powerW = Math.abs(powerNow) / 1e6
	} else if (currentNow !== null && voltageNow !== null) {
		powerW = Math.abs(currentNow * voltageNow) / 1e12
	}

	let timeRemainingS: number | null = null

	if (now !== null && full !== null && rate !== null && Math.abs(rate) > 0) {
		if (status === 'discharging') {
			timeRemainingS = now / Math.abs(rate) * 3600
		} else if (status === 'charging') {
			timeRemainingS = Math.max(0, full - now) / Math.abs(rate) * 3600
		}
	}

	let level = capacity !== null ? capacity / 100 : null

	if (level === null && now !== null && full) {
		level = now / full
	}

	return {
		level: Math.min(1, Math.max(0, level ?? 0)),
		status,
		isOnAcPower: isOnAcPower || status === 'charging',
		health: full && fullDesign ? Math.min(1, full / fullDesign) : null,
		cycleCount: cycleCount && cycleCount > 0 ? cycleCount : null,
		powerW: powerW && powerW > 0 ? powerW : null,
		timeRemainingS: timeRemainingS !== null && Number.isFinite(timeRemainingS) ? timeRemainingS : null,
		temperatureC: temperature !== null ? temperature / 10 : null,
	}
}
