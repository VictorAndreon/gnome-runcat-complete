import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

import { LOG_PREFIX } from '../constants.js'
import { listDir } from './fs.js'


// Files bigger than this are rejected: the snapshot is re-read on every change
const MAX_FILE_SIZE = 1024 * 1024

// Delay before re-reading a file after a change, collapses bursts of events
const RELOAD_DELAY_MS = 150

// Unreadable sources (deleted, not created yet, invalid JSON) are retried this often
const RETRY_INTERVAL_S = 5

export const CUSTOM_METRICS_DIRECTORY = GLib.build_filenamev([GLib.get_user_config_dir(), 'runcat', 'metrics'])

export type CustomMetric = {
	title: string
	formattedValue: string
	// in [0, 1], a bar is drawn when present
	normalizedValue: number | null
}

/**
 * Custom metrics file contents, compatible with RunCat Neo's schema:
 * https://github.com/runcat-dev/RunCatNeo/blob/main/docs/CustomMetricsSchema.md
 **/
export type CustomMetricsSnapshot = {
	title: string
	// freedesktop icon name, bundled icon name or absolute path (Linux-only extension of the schema)
	icon: string | null
	// SF Symbol name (RunCat Neo), used to guess an icon when `icon` is missing
	symbol: string | null
	// short text for the top bar
	metricsBarValue: string | null
	metrics: CustomMetric[]
	lastUpdatedDate: Date | null
}

export type CustomMetricsSource = {
	path: string
	// true for files added in preferences, false for files found in `CUSTOM_METRICS_DIRECTORY`
	isExplicit: boolean
	// the last valid snapshot, kept when the file becomes unreadable
	snapshot: CustomMetricsSnapshot | null
	error: string | null
}

type WatchedSource = {
	state: CustomMetricsSource
	monitor: Gio.FileMonitor | null
	reloadId: number | null
}


// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.File.prototype, 'load_contents_async')
// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.File.prototype, 'query_info_async')


export const expandPath = (path: string): string => {
	const trimmed = path.trim()

	if (trimmed === '~' || trimmed.startsWith('~/')) {
		return GLib.build_filenamev([GLib.get_home_dir(), trimmed.slice(1)])
	}

	return trimmed
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value : null

const toText = (value: unknown): string | null => {
	if (typeof value === 'string') return value
	if (typeof value === 'number' && Number.isFinite(value)) return `${value}`

	return null
}

/**
 * Validate and normalize a custom metrics JSON document.
 *
 * @throws {Error} when the document doesn't follow the schema
 **/
export function parseCustomMetrics(text: string): CustomMetricsSnapshot {
	const data: unknown = JSON.parse(text)

	if (!isRecord(data)) {
		throw new Error('the top level value must be an object')
	}

	const title = optionalString(data.title)

	if (!title) {
		throw new Error('"title" must be a non-empty string')
	}

	if (!Array.isArray(data.metrics)) {
		throw new Error('"metrics" must be an array')
	}

	const metrics = data.metrics.map((metric: unknown, i: number): CustomMetric => {
		const metricTitle = isRecord(metric) ? toText(metric.title) : null
		const formattedValue = isRecord(metric) ? toText(metric.formattedValue) : null

		if (!isRecord(metric) || metricTitle === null || formattedValue === null) {
			throw new Error(`metrics[${i}] must have "title" and "formattedValue" strings`)
		}

		const { normalizedValue } = metric

		return {
			title: metricTitle,
			formattedValue,
			normalizedValue: typeof normalizedValue === 'number' && Number.isFinite(normalizedValue)
				? Math.min(1, Math.max(0, normalizedValue))
				: null,
		}
	})

	const date = typeof data.lastUpdatedDate === 'string' ? new Date(data.lastUpdatedDate) : null

	return {
		title,
		icon: optionalString(data.icon),
		symbol: optionalString(data.symbol),
		metricsBarValue: toText(data.metricsBarValue),
		metrics,
		lastUpdatedDate: date && !Number.isNaN(date.getTime()) ? date : null,
	}
}

async function readSnapshot(path: string): Promise<CustomMetricsSnapshot> {
	const file = Gio.File.new_for_path(path)

	const info = await file.query_info_async(
		[Gio.FILE_ATTRIBUTE_STANDARD_SIZE, Gio.FILE_ATTRIBUTE_TIME_MODIFIED].join(','),
		Gio.FileQueryInfoFlags.NONE,
		GLib.PRIORITY_DEFAULT,
		null,
	)

	if (info.get_size() > MAX_FILE_SIZE) {
		throw new Error('the file is larger than 1 MiB')
	}

	const [bytes] = await file.load_contents_async(null)
	const snapshot = parseCustomMetrics(new TextDecoder('utf-8').decode(bytes))

	// fall back to the modification time when the producer didn't set a date
	if (!snapshot.lastUpdatedDate) {
		const modified = info.get_modification_date_time()

		snapshot.lastUpdatedDate = modified ? new Date(modified.to_unix() * 1000) : null
	}

	return snapshot
}


/**
 * Watches custom metrics JSON files: every `*.json` in `CUSTOM_METRICS_DIRECTORY`
 * plus the files explicitly added in preferences. Files are re-read on change.
 **/
export default class CustomMetricsWatcher {
	#sources = new Map<string, WatchedSource>()
	#explicitPaths: string[] = []
	#directoryPaths: string[] = []

	#directoryMonitor: Gio.FileMonitor | null = null
	#rescanId: number | null = null
	#retryId: number

	#onChange: () => void
	#isDestroyed = false

	constructor(onChange: () => void) {
		this.#onChange = onChange

		try {
			const directory = Gio.File.new_for_path(CUSTOM_METRICS_DIRECTORY)

			GLib.mkdir_with_parents(CUSTOM_METRICS_DIRECTORY, 0o755)

			this.#directoryMonitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)
			this.#directoryMonitor.connect('changed', () => this.#scheduleRescan())
		} catch (e) {
			console.error(`${LOG_PREFIX}: can't watch ${CUSTOM_METRICS_DIRECTORY}: ${e}`)
		}

		this.#retryId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RETRY_INTERVAL_S, () => {
			for (const [path, source] of this.#sources) {
				if (source.state.error !== null && source.reloadId === null) {
					this.#scheduleReload(path)
				}
			}

			return GLib.SOURCE_CONTINUE
		})

		this.#rescan()
	}

	/** Sources in display order: explicit ones first, in the order they were added. */
	get sources(): CustomMetricsSource[] {
		return [...this.#sources.values()].map(({ state }) => state)
	}

	setExplicitPaths(paths: string[]) {
		this.#explicitPaths = paths.map(expandPath).filter(Boolean)
		this.#sync()
	}

	#scheduleRescan() {
		if (this.#rescanId !== null) {
			GLib.source_remove(this.#rescanId)
		}

		this.#rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY_MS, () => {
			this.#rescanId = null
			this.#rescan()

			return GLib.SOURCE_REMOVE
		})
	}

	async #rescan() {
		const names = await listDir(CUSTOM_METRICS_DIRECTORY)

		// skip hidden files: producers write `.tmp` files there and `mv` them into place
		this.#directoryPaths = names
			.filter(name => name.endsWith('.json') && !name.startsWith('.'))
			.map(name => GLib.build_filenamev([CUSTOM_METRICS_DIRECTORY, name]))

		this.#sync()
	}

	#sync() {
		if (this.#isDestroyed) return

		const wanted = new Map<string, boolean>()

		this.#explicitPaths.forEach(path => wanted.set(path, true))
		this.#directoryPaths.forEach(path => !wanted.has(path) && wanted.set(path, false))

		let changed = false

		for (const path of [...this.#sources.keys()]) {
			if (!wanted.has(path)) {
				this.#unwatch(path)
				changed = true
			}
		}

		const ordered = new Map<string, WatchedSource>()

		for (const [path, isExplicit] of wanted) {
			const existing = this.#sources.get(path)

			if (existing) {
				changed ||= existing.state.isExplicit !== isExplicit
				existing.state.isExplicit = isExplicit
				ordered.set(path, existing)
			} else {
				ordered.set(path, this.#watch(path, isExplicit))
				changed = true
			}
		}

		changed ||= [...ordered.keys()].join('\n') !== [...this.#sources.keys()].join('\n')

		this.#sources = ordered

		if (changed) {
			this.#onChange()
		}
	}

	#watch(path: string, isExplicit: boolean): WatchedSource {
		const source: WatchedSource = {
			state: { path, isExplicit, snapshot: null, error: null },
			monitor: null,
			reloadId: null,
		}

		try {
			// GIO keeps watching missing files and reports them when they appear
			source.monitor = Gio.File.new_for_path(path).monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null)
			source.monitor.connect('changed', () => this.#scheduleReload(path))
		} catch (e) {
			console.error(`${LOG_PREFIX}: can't watch ${path}: ${e}`)
		}

		this.#sources.set(path, source)
		this.#reload(path)

		return source
	}

	#unwatch(path: string) {
		const source = this.#sources.get(path)

		if (!source) return

		source.monitor?.cancel()

		if (source.reloadId !== null) {
			GLib.source_remove(source.reloadId)
		}

		this.#sources.delete(path)
	}

	#scheduleReload(path: string) {
		const source = this.#sources.get(path)

		if (!source || source.reloadId !== null) return

		source.reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DELAY_MS, () => {
			source.reloadId = null
			this.#reload(path)

			return GLib.SOURCE_REMOVE
		})
	}

	async #reload(path: string) {
		let snapshot: CustomMetricsSnapshot | null = null
		let error: string | null = null

		try {
			snapshot = await readSnapshot(path)
		} catch (e) {
			error = e instanceof Error ? e.message : `${e}`
		}

		// the source may have been removed while reading
		const source = this.#sources.get(path)

		if (!source) return

		const hadError = source.state.error !== null

		source.state.error = error
		source.state.snapshot = snapshot ?? source.state.snapshot

		// don't re-render every retry of a source that keeps failing
		if (snapshot || !hadError) {
			this.#onChange()
		}
	}

	destroy() {
		this.#isDestroyed = true

		for (const path of [...this.#sources.keys()]) {
			this.#unwatch(path)
		}

		this.#directoryMonitor?.cancel()

		if (this.#rescanId !== null) {
			GLib.source_remove(this.#rescanId)
		}

		GLib.source_remove(this.#retryId)
	}
}
