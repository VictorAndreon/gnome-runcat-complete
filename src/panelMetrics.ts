import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import St from 'gi://St'

import { PANEL_METRIC_IDS } from './constants.js'
import {
	formatNumber,
	formatRate,
	formatTemperature,
	getBatteryIcon,
	getCustomMetricIcon,
	getMetricIcon,
} from './utils.js'

import type { MetricsSnapshot } from './metrics.js'
import type { CustomMetricsSource } from './dataProviders/customMetrics.js'
import type { PanelMetricId } from './types'


class PanelMetric {
	readonly actor: St.BoxLayout

	#icon: St.Icon | null
	#label: St.Label

	constructor(icon: Gio.Icon | null, labelStyleClass = '') {
		this.actor = new St.BoxLayout({ styleClass: 'runcat-panel-metric', visible: false })

		this.#icon = icon
			? new St.Icon({ gicon: icon, styleClass: 'system-status-icon runcat-panel-metric__icon' })
			: null

		this.#label = new St.Label({
			styleClass: `runcat-panel-metric__label ${labelStyleClass}`,
			yAlign: Clutter.ActorAlign.CENTER,
		})

		if (this.#icon) {
			this.actor.add_child(this.#icon)
		}

		this.actor.add_child(this.#label)
	}

	set icon(icon: Gio.Icon) {
		if (this.#icon && !this.#icon.gicon?.equal(icon)) {
			this.#icon.gicon = icon
		}
	}

	set text(text: string) {
		this.#label.text = text
	}
}


/**
 * Extra metrics shown next to the character in the top bar, like RunCat Neo's menu bar items.
 **/
export default class PanelMetrics {
	readonly actor: St.BoxLayout

	#metrics: Record<PanelMetricId, PanelMetric>
	#customMetrics = new Map<string, PanelMetric>()
	#extensionPath: string

	constructor(extensionPath: string) {
		this.#extensionPath = extensionPath

		this.actor = new St.BoxLayout({ styleClass: 'runcat-panel-metrics', visible: false })

		this.#metrics = {
			temperature: new PanelMetric(getMetricIcon(extensionPath, 'temperature')),
			memory: new PanelMetric(getMetricIcon(extensionPath, 'memory')),
			storage: new PanelMetric(getMetricIcon(extensionPath, 'storage')),
			battery: new PanelMetric(getBatteryIcon(null)),
			network: new PanelMetric(null, 'runcat-panel-metric__label--compact'),
		}

		for (const id of PANEL_METRIC_IDS) {
			this.actor.add_child(this.#metrics[id].actor)
		}
	}

	update(
		snapshot: MetricsSnapshot,
		enabled: Record<PanelMetricId, boolean>,
		customSources: CustomMetricsSource[],
		enabledCustomPaths: string[],
	) {
		const { cpuTemperature, memory, storage, battery, network } = snapshot

		const values: Record<PanelMetricId, string | null> = {
			temperature: cpuTemperature !== null ? formatTemperature(cpuTemperature) : null,
			memory: memory ? formatNumber(memory.usage) : null,
			storage: storage ? formatNumber(storage.usage) : null,
			battery: battery ? formatNumber(battery.level) : null,
			network: `↑ ${formatRate(network.uploadRate)}\n↓ ${formatRate(network.downloadRate)}`,
		}

		if (battery) {
			this.#metrics.battery.icon = getBatteryIcon(battery)
		}

		for (const id of PANEL_METRIC_IDS) {
			const value = values[id]
			const metric = this.#metrics[id]

			metric.actor.visible = enabled[id] && value !== null

			if (value !== null) {
				metric.text = value
			}
		}

		this.#updateCustomMetrics(customSources.filter(({ path }) => enabledCustomPaths.includes(path)))

		this.actor.visible = PANEL_METRIC_IDS.some(id => this.#metrics[id].actor.visible)
			|| this.#customMetrics.size > 0
	}

	#updateCustomMetrics(sources: CustomMetricsSource[]) {
		const paths = new Set(sources.map(({ path }) => path))

		for (const [path, metric] of this.#customMetrics) {
			if (!paths.has(path)) {
				metric.actor.destroy()
				this.#customMetrics.delete(path)
			}
		}

		for (const { path, snapshot, error } of sources) {
			let metric = this.#customMetrics.get(path)

			if (!metric) {
				metric = new PanelMetric(getCustomMetricIcon(this.#extensionPath, snapshot))
				metric.actor.show()

				this.#customMetrics.set(path, metric)
				this.actor.add_child(metric.actor)
			}

			metric.icon = getCustomMetricIcon(this.#extensionPath, snapshot)
			metric.text = error === null && snapshot?.metricsBarValue ? snapshot.metricsBarValue : '---'
		}
	}
}
