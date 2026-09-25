import { LOG_PREFIX } from '../constants.js'
import { readText } from './fs.js'


export const MAX_CPU_UTILIZATION = 1.0

type CpuStats = { user: number, system: number, active: number, total: number }

export type CpuSample = {
	// utilization in [0, 1]
	usage: number
	user: number
	system: number
	idle: number
}


let GTop: typeof import('gi://GTop').default | undefined

try {
	({ default: GTop } = await import('gi://GTop'))

	GTop.glibtop_init()
} catch {
	console.error(`${LOG_PREFIX}: GTop is not installed. Falling back to /proc/stat parsing`)
}


export default async function* (): AsyncGenerator<CpuSample, CpuSample, void> {
	let prev = await getCpuStats()

	while (true) {
		const current = await getCpuStats()

		const totalDelta = Math.max(current.total - prev.total, MAX_CPU_UTILIZATION)
		const ratio = (value: number, prevValue: number) => clamp((value - prevValue) / totalDelta)

		let sample: CpuSample = {
			usage: ratio(current.active, prev.active),
			user: ratio(current.user, prev.user),
			system: ratio(current.system, prev.system),
			idle: 0,
		}

		sample.idle = clamp(MAX_CPU_UTILIZATION - sample.usage)

		if (Object.values(sample).some(n => Number.isNaN(n) || !Number.isFinite(n))) {
			const data = JSON.stringify({ current, prev })

			console.log(`${LOG_PREFIX}: cpu utilization is ${sample.usage}, data: ${data}`)

			sample = { usage: 0, user: 0, system: 0, idle: MAX_CPU_UTILIZATION }
		}

		prev = current

		yield sample
	}
}

const clamp = (value: number) => Math.min(MAX_CPU_UTILIZATION, Math.max(0, value))


async function getCpuStats(): Promise<CpuStats> {
	try {
		if (!GTop) {
			const cpuStats = await getCpuStatsFallback()

			return cpuStats
		}

		const cpu = new GTop.glibtop_cpu()

		GTop.glibtop_get_cpu(cpu)

		return {
			user: cpu.user + cpu.nice,
			system: cpu.sys,
			active: cpu.user + cpu.sys + cpu.nice,
			total: cpu.total,
		}
	} catch (e) {
		console.error(`${LOG_PREFIX}: ${e}`)

		return { user: 0, system: 0, active: 0, total: 0 }
	}
}


async function getCpuStatsFallback(): Promise<CpuStats> {
	const contents = await readText('/proc/stat') ?? ''

	const data = contents
		.split('\n')
		.filter(line => line.startsWith('cpu'))
		.reduce<Record<string, CpuStats>>(
			(acc, line) => {
				const [name, data] = parseCpuLine(line)

				acc[name] = data

				return acc
			},
			{},
		)

	return data['cpu']

}

function parseCpuLine(line: string): [string, CpuStats] {
	const [name, ...values] = line.trim().split(/[\s]+/)

	// see `man proc_stat` and glibtop's `glibtop_get_cpu_s function` in cpu.c
	const [user, nice, sys, idle] = values.map(n => parseInt(n, 10))

	return [
		name,
		{
			user: user + nice,
			system: sys,
			active: user + sys + nice,
			total: user + nice + sys + idle,
		},
	]
}
