import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Pango from 'gi://Pango'
import St from 'gi://St'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import { PopupBaseMenuItem } from 'resource:///org/gnome/shell/ui/popupMenu.js'
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js'

import { DASHBOARD_CARD_IDS } from './constants.js'
import { HISTORY_LENGTH, type MetricsSnapshot } from './metrics.js'
import { Sparkline, UsageBar, createVerticalBox } from './widgets.js'
import {
	formatBytes,
	formatDuration,
	formatPercent,
	formatRate,
	formatTemperature,
	formatRelativeTime,
	getBatteryIcon,
	getCustomMetricIcon,
	getMetricIcon,
	getNetworkIcon,
} from './utils.js'

import type { BatteryStatus } from './dataProviders/battery.js'
import type { ConnectionKind } from './dataProviders/network.js'
import type { CustomMetricsSource } from './dataProviders/customMetrics.js'
import type { DashboardCardId } from './types'


type Row = [label: string, value: string]


class MetricCard {
	readonly actor: St.BoxLayout

	#icon: St.Icon
	#title: St.Label
	#rows: St.BoxLayout

	constructor(icon: Gio.Icon, chart: Clutter.Actor | null = null) {
		this.actor = new St.BoxLayout({ styleClass: 'runcat-card', xExpand: true })

		this.#icon = new St.Icon({
			gicon: icon,
			styleClass: 'runcat-card__icon',
			yAlign: Clutter.ActorAlign.CENTER,
		})

		const content = createVerticalBox({ styleClass: 'runcat-card__content', xExpand: true })

		this.#title = new St.Label({ styleClass: 'runcat-card__title' })
		this.#rows = createVerticalBox({ styleClass: 'runcat-card__rows' })

		content.add_child(this.#title)
		content.add_child(this.#rows)

		if (chart) {
			content.add_child(chart)
		}

		this.actor.add_child(this.#icon)
		this.actor.add_child(content)
	}

	set icon(icon: Gio.Icon) {
		if (!this.#icon.gicon?.equal(icon)) {
			this.#icon.gicon = icon
		}
	}

	update(title: string, rows: Row[]) {
		this.#title.text = title

		const labels = this.#rows.get_children() as St.Label[]

		rows.forEach(([label, value], i) => {
			let row = labels[i]

			if (!row) {
				row = new St.Label({ styleClass: 'runcat-card__row' })
				this.#rows.add_child(row)
			}

			row.text = `${label}: ${value}`
			row.show()
		})

		labels.slice(rows.length).forEach(row => row.hide())
	}
}


// Custom metrics text comes from scripts and may be long: wrap instead of widening the menu
const createWrappingLabel = (text: string, styleClass: string): St.Label => {
	const label = new St.Label({ text, styleClass })

	label.clutterText.lineWrap = true
	label.clutterText.lineWrapMode = Pango.WrapMode.WORD_CHAR
	label.clutterText.ellipsize = Pango.EllipsizeMode.NONE

	return label
}

/**
 * Card of a custom metrics source (a JSON file written by a script or hook).
 **/
class CustomMetricCard {
	readonly actor: St.BoxLayout

	#extensionPath: string
	#icon: St.Icon
	#title: St.Label
	#rows: St.BoxLayout
	#footer: St.Label

	constructor(extensionPath: string) {
		this.#extensionPath = extensionPath
		this.actor = new St.BoxLayout({ styleClass: 'runcat-card', xExpand: true })

		this.#icon = new St.Icon({
			gicon: getCustomMetricIcon(extensionPath, null),
			styleClass: 'runcat-card__icon',
			yAlign: Clutter.ActorAlign.CENTER,
		})

		const content = createVerticalBox({ styleClass: 'runcat-card__content', xExpand: true })

		this.#title = new St.Label({ styleClass: 'runcat-card__title' })
		this.#rows = createVerticalBox({ styleClass: 'runcat-card__rows' })
		this.#footer = createWrappingLabel('', 'runcat-card__footer')

		content.add_child(this.#title)
		content.add_child(this.#rows)
		content.add_child(this.#footer)

		this.actor.add_child(this.#icon)
		this.actor.add_child(content)
	}

	update({ path, snapshot, error }: CustomMetricsSource, chartStyle: string) {
		const icon = getCustomMetricIcon(this.#extensionPath, snapshot)

		if (!this.#icon.gicon?.equal(icon)) {
			this.#icon.gicon = icon
		}

		this.#title.text = snapshot?.title ?? GLib.path_get_basename(path)

		this.#rows.destroy_all_children()

		for (const metric of snapshot?.metrics ?? []) {
			const row = createVerticalBox({ styleClass: 'runcat-card__metric' })

			row.add_child(createWrappingLabel(`${metric.title}: ${metric.formattedValue}`, 'runcat-card__row'))

			if (metric.normalizedValue !== null) {
				const bar = new UsageBar('runcat-chart runcat-usage-bar runcat-usage-bar--thin')

				bar.actor.style = chartStyle

				bar.setValue(metric.normalizedValue)
				row.add_child(bar.actor)
			}

			this.#rows.add_child(row)
		}

		if (error !== null) {
			this.#footer.text = _('Failed to read: %s').format(error)
			this.#footer.add_style_class_name('runcat-card__footer--error')
		} else {
			this.#footer.text = snapshot?.lastUpdatedDate
				? _('Updated %s').format(formatRelativeTime(snapshot.lastUpdatedDate))
				: ''

			this.#footer.remove_style_class_name('runcat-card__footer--error')
		}

		this.#footer.visible = this.#footer.text !== ''
	}
}


const batteryStatusNames = (): Record<BatteryStatus, string> => ({
	'charging': _('Charging'),
	'discharging': _('Discharging'),
	'full': _('Fully charged'),
	'not-charging': _('Not charging'),
	'unknown': _('Unknown'),
})

const connectionKindNames = (): Record<ConnectionKind, string> => ({
	'ethernet': _('Ethernet'),
	'wifi': _('Wi-Fi'),
	'vpn': _('VPN'),
	'mobile': _('Mobile broadband'),
	'bluetooth': _('Bluetooth'),
	'other': _('Connected'),
	'disconnected': _('Disconnected'),
	'unknown': _('Unknown'),
})


// Vertical space kept for the top bar, the menu arrow and the menu items below the dashboard
const RESERVED_HEIGHT_PX = 220

// Maximum number of columns, whatever the screen size
const MAX_COLUMNS = 4


/**
 * Split items into consecutive columns.
 *
 * With `columns = 0` (automatic) a new column starts when the next item would exceed `maxHeight`;
 * with a fixed number of columns the items are balanced by height.
 *
 * @returns {number[][]} indices of the items in every column
 **/
export function distributeInColumns(heights: number[], maxHeight: number, columns: number): number[][] {
	if (heights.length === 0) {
		return []
	}

	if (columns <= 0) {
		const result: number[][] = [[]]
		let columnHeight = 0

		heights.forEach((height, i) => {
			if (columnHeight > 0 && columnHeight + height > maxHeight) {
				result.push([])
				columnHeight = 0
			}

			result[result.length - 1].push(i)
			columnHeight += height
		})

		return result
	}

	const count = Math.min(columns, heights.length)
	const target = heights.reduce((sum, h) => sum + h, 0) / count
	const result: number[][] = [[]]
	let columnHeight = 0

	heights.forEach((height, i) => {
		const columnsLeft = count - result.length
		const itemsLeft = heights.length - i

		// move on when this column is full enough, or when every remaining column needs an item
		const isFull = columnHeight > 0 && columnHeight + height / 2 > target
		const mustMove = columnHeight > 0 && itemsLeft <= columnsLeft

		if (columnsLeft > 0 && (isFull || mustMove)) {
			result.push([])
			columnHeight = 0
		}

		result[result.length - 1].push(i)
		columnHeight += height
	})

	return result
}


/**
 * RunCat Neo-like dashboard shown in the indicator menu: a card per metric,
 * laid out in columns when they don't fit the screen height.
 **/
export default class Dashboard {
	readonly item: PopupBaseMenuItem

	#cards: Record<DashboardCardId, MetricCard>

	#cpuChart = new Sparkline(HISTORY_LENGTH)
	#memoryChart = new Sparkline(HISTORY_LENGTH)
	#storageBar = new UsageBar()

	#container: St.BoxLayout
	#chartStyle = ''
	#columns = 0
	#needsLayout = true

	#extensionPath: string
	#customCards = new Map<string, CustomMetricCard>()

	constructor(extensionPath: string) {
		this.#extensionPath = extensionPath

		this.item = new PopupBaseMenuItem({ activate: false, hover: false, can_focus: false })
		this.item.add_style_class_name('runcat-dashboard-item')

		this.#container = new St.BoxLayout({ styleClass: 'runcat-dashboard', xExpand: true })

		this.#cards = {
			cpu: new MetricCard(getMetricIcon(extensionPath, 'cpu'), this.#cpuChart.actor),
			memory: new MetricCard(getMetricIcon(extensionPath, 'memory'), this.#memoryChart.actor),
			storage: new MetricCard(getMetricIcon(extensionPath, 'storage'), this.#storageBar.actor),
			battery: new MetricCard(getBatteryIcon(null)),
			network: new MetricCard(getNetworkIcon('unknown')),
		}

		const firstColumn = this.#addColumn()

		for (const id of DASHBOARD_CARD_IDS) {
			firstColumn.add_child(this.#cards[id].actor)
		}

		this.item.add_child(this.#container)
	}

	/**
	 * Override the chart color and the background of the dashboard (CSS colors, empty for the theme default).
	 * Custom cards pick the chart color up on their next update.
	 **/
	setAppearance({ chartColor, backgroundColor }: { chartColor: string, backgroundColor: string }) {
		this.#chartStyle = chartColor ? `color: ${chartColor};` : ''

		for (const chart of [this.#cpuChart, this.#memoryChart, this.#storageBar]) {
			chart.actor.style = this.#chartStyle
		}

		this.#container.style = backgroundColor ? `background-color: ${backgroundColor};` : ''
	}

	/** Number of columns, 0 for automatic (as many as needed to fit the screen height). */
	setColumns(columns: number) {
		this.#columns = Math.max(0, Math.min(MAX_COLUMNS, columns))
		this.#needsLayout = true
	}

	#addColumn(): St.BoxLayout {
		const column = createVerticalBox({ styleClass: 'runcat-dashboard__column', xExpand: true })

		this.#container.add_child(column)

		return column
	}

	#updateCustomCards(sources: CustomMetricsSource[]) {
		const paths = new Set(sources.map(({ path }) => path))

		for (const [path, card] of this.#customCards) {
			if (!paths.has(path)) {
				card.actor.destroy()
				this.#customCards.delete(path)
			}
		}

		for (const source of sources) {
			let card = this.#customCards.get(source.path)

			if (!card) {
				card = new CustomMetricCard(this.#extensionPath)
				this.#customCards.set(source.path, card)
				this.#container.get_last_child()!.add_child(card.actor)
			}

			card.update(source, this.#chartStyle)
		}
	}

	#getMaxColumnHeight(): number {
		const monitor = Main.layoutManager.primaryMonitor
		const workArea = monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null

		return Math.max(200, (workArea?.height ?? 800) - RESERVED_HEIGHT_PX)
	}

	#getMaxColumns(): number {
		const monitor = Main.layoutManager.primaryMonitor
		const workArea = monitor ? Main.layoutManager.getWorkAreaForMonitor(monitor.index) : null

		// columns have a fixed CSS width (wrapped text would report its unwrapped width)
		const column = this.#container.get_first_child() as St.Widget
		const columnWidth = column.get_theme_node().get_width()
		const spacing = this.#container.get_theme_node().get_length('spacing')

		if (columnWidth <= 0) {
			return MAX_COLUMNS
		}

		const available = (workArea?.width ?? 1280) - 64

		return Math.max(1, Math.min(MAX_COLUMNS, Math.floor((available + spacing) / (columnWidth + spacing))))
	}

	/** Place the visible cards (in order) into columns. */
	#layout(cards: St.Widget[]) {
		const heights = cards.map(card => card.get_preferred_height(card.width || -1)[1])
		const maxColumns = this.#getMaxColumns()

		let columns = distributeInColumns(heights, this.#getMaxColumnHeight(), Math.min(this.#columns, maxColumns))

		// too many columns for the screen width: balance the cards on as many as fit
		if (columns.length > maxColumns) {
			columns = distributeInColumns(heights, 0, maxColumns)
		}

		// re-parenting relayouts the menu, only do it when the arrangement changes
		if (!this.#needsLayout && this.#isArrangedAs(cards, columns)) {
			return
		}

		this.#needsLayout = false

		while (this.#container.get_n_children() < Math.max(1, columns.length)) {
			this.#addColumn()
		}

		const columnActors = this.#container.get_children() as St.BoxLayout[]

		for (const card of cards) {
			card.get_parent()?.remove_child(card)
		}

		columns.forEach((indices, c) => {
			indices.forEach((i, position) => {
				const card = cards[i]

				columnActors[c].add_child(card)

				// cards below another one in the same column get a separator line
				if (position > 0) {
					card.add_style_class_name('runcat-card--separated')
				} else {
					card.remove_style_class_name('runcat-card--separated')
				}
			})
		})

		// hide columns left empty (hidden cards may still live there)
		columnActors.forEach((column, c) => {
			column.visible = c < Math.max(1, columns.length)
		})
	}

	#isArrangedAs(cards: St.Widget[], columns: number[][]): boolean {
		const columnActors = this.#container.get_children()

		if (columnActors.slice(columns.length).some(column => column.visible)) {
			return false
		}

		return columns.every((indices, c) => {
			const visibleChildren = columnActors[c]?.get_children().filter(child => child.visible) ?? []

			return visibleChildren.length === indices.length
				&& indices.every((i, position) => visibleChildren[position] === cards[i])
		})
	}

	update(
		snapshot: MetricsSnapshot,
		enabledCards: Record<DashboardCardId, boolean>,
		customSources: CustomMetricsSource[],
	) {
		const visibility: Record<DashboardCardId, boolean> = {
			cpu: enabledCards.cpu,
			memory: enabledCards.memory && snapshot.memory !== null,
			storage: enabledCards.storage && snapshot.storage !== null,
			battery: enabledCards.battery && snapshot.battery !== null,
			network: enabledCards.network,
		}

		for (const id of DASHBOARD_CARD_IDS) {
			this.#cards[id].actor.visible = visibility[id]
		}

		this.#updateCustomCards(customSources)

		if (visibility.cpu) this.#updateCpu(snapshot)
		if (visibility.memory) this.#updateMemory(snapshot)
		if (visibility.storage) this.#updateStorage(snapshot)
		if (visibility.battery) this.#updateBattery(snapshot)
		if (visibility.network) this.#updateNetwork(snapshot)

		const visibleCards = [
			...DASHBOARD_CARD_IDS.filter(id => visibility[id]).map(id => this.#cards[id].actor),
			...customSources.map(({ path }) => this.#customCards.get(path)!.actor),
		]

		this.item.visible = visibleCards.length > 0
		this.#layout(visibleCards)
	}

	#updateCpu({ cpu, cpuTemperature, history }: MetricsSnapshot) {
		const rows: Row[] = [
			[_('System'), formatPercent(cpu.system)],
			[_('User'), formatPercent(cpu.user)],
			[_('Idle'), formatPercent(cpu.idle)],
		]

		if (cpuTemperature !== null) {
			rows.push([_('Temperature'), formatTemperature(cpuTemperature)])
		}

		this.#cards.cpu.update(_('CPU: %s').format(formatPercent(cpu.usage)), rows)
		this.#cpuChart.setValues(history.cpu)
	}

	#updateMemory({ memory, history }: MetricsSnapshot) {
		if (!memory) return

		const rows: Row[] = [
			[_('Used'), `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`],
			[_('Available'), formatBytes(memory.available)],
			[_('Cache'), formatBytes(memory.cached)],
		]

		if (memory.swapTotal > 0) {
			rows.push([_('Swap'), `${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}`])
		}

		this.#cards.memory.update(_('Memory: %s').format(formatPercent(memory.usage)), rows)
		this.#memoryChart.setValues(history.memory)
	}

	#updateStorage({ storage }: MetricsSnapshot) {
		if (!storage) return

		this.#cards.storage.update(_('Storage: %s used').format(formatPercent(storage.usage)), [
			[storage.path, `${formatBytes(storage.used)} / ${formatBytes(storage.total)}`],
			[_('Free'), formatBytes(storage.free)],
		])

		this.#storageBar.setValue(storage.usage)
	}

	#updateBattery({ battery }: MetricsSnapshot) {
		if (!battery) return

		const rows: Row[] = [
			[_('Power source'), battery.isOnAcPower ? _('Power adapter') : _('Battery')],
			[_('Status'), batteryStatusNames()[battery.status]],
		]

		if (battery.timeRemainingS !== null && battery.status === 'discharging') {
			rows.push([_('Time remaining'), formatDuration(battery.timeRemainingS)])
		} else if (battery.timeRemainingS !== null && battery.status === 'charging') {
			rows.push([_('Time until full'), formatDuration(battery.timeRemainingS)])
		}

		if (battery.powerW !== null) {
			rows.push([_('Power'), `${battery.powerW.toFixed(1)} W`])
		}

		if (battery.health !== null) {
			rows.push([_('Max capacity'), formatPercent(battery.health)])
		}

		if (battery.cycleCount !== null) {
			rows.push([_('Cycle count'), `${battery.cycleCount}`])
		}

		if (battery.temperatureC !== null) {
			rows.push([_('Temperature'), formatTemperature(battery.temperatureC)])
		}

		this.#cards.battery.icon = getBatteryIcon(battery)
		this.#cards.battery.update(_('Battery: %s').format(formatPercent(battery.level)), rows)
	}

	#updateNetwork({ network }: MetricsSnapshot) {
		const kindName = connectionKindNames()[network.kind]
		const rows: Row[] = []

		if (network.name && network.kind !== 'ethernet') {
			rows.push([_('Connection'), network.name])
		}

		if (network.localIp) {
			rows.push([_('Local IP'), network.localIp])
		}

		rows.push(
			[_('Upload'), formatRate(network.uploadRate)],
			[_('Download'), formatRate(network.downloadRate)],
		)

		this.#cards.network.icon = getNetworkIcon(network.kind)
		this.#cards.network.update(_('Network: %s').format(kindName), rows)
	}
}
