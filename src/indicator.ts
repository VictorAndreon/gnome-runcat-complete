import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GObject from 'gi://GObject'
import GLib from 'gi://GLib'
import St from 'gi://St'

import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import { trySpawnCommandLine } from 'resource:///org/gnome/shell/misc/util.js'
import { type PopupMenu, PopupSeparatorMenuItem } from 'resource:///org/gnome/shell/ui/popupMenu.js'
import { type Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js'

import {
	LOG_PREFIX,
	SYSTEM_MONITOR_COMMAND,
	DASHBOARD_CARD_IDS,
	PANEL_METRIC_IDS,
	displayingItemNickToValue,
	SettingsSchemaKeys,
	ReactiveProperties,
} from './constants.js'

import { getAnimationCycleDurationMs, createAnimationTicker } from './math.js'
import { formatNumber, getSpritesPack, sanitizeCssColor } from './utils.js'

import { MAX_CPU_UTILIZATION } from './dataProviders/cpu.js'
import MetricsSampler, { type MetricsSnapshot } from './metrics.js'
import Dashboard from './dashboard.js'
import PanelMetrics from './panelMetrics.js'
import CustomMetricsWatcher from './dataProviders/customMetrics.js'

import type {
	DisplayingItems,
	CharacterState,
	RunCatIndicatorReactiveProperties,
	DisplayingItemNick,
	GObjectProperties,
	DashboardCardId,
	PanelMetricId,
} from './types'


// eslint-disable-next-line max-len
export default class RunCatIndicator extends PanelMenu.Button implements RunCatIndicatorReactiveProperties {
	declare menu: PopupMenu

	declare idleThreshold: number
	declare displayingItems: DisplayingItems
	declare isSpeedInverted: boolean
	declare isAnimationSmoothingEnabled: boolean

	declare cpuUsage: number
	declare currentSpriteFrame: Gio.Icon

	static {
		GObject.registerClass({
			Properties: {
				cpuUsage: GObject.ParamSpec.float(
					'cpuUsage',
					'CPU usage',
					'Latest CPU utilization in [0, 1], sampled every 3 seconds',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT, 0, 1, 0,
				),

				currentSpriteFrame: GObject.ParamSpec.object<Gio.Icon>(
					'currentSpriteFrame',
					'Current sprite frame',
					'Sprite currently displayed for the character state',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT, Gio.Icon,
				),

				displayingItems: GObject.ParamSpec.jsobject<DisplayingItems>(
					'displayingItems',
					'Displaying items',
					'Which elements to show: the character and/or the CPU percentage',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
				),

				isSpeedInverted: GObject.ParamSpec.boolean(
					'isSpeedInverted',
					'Invert speed',
					'When true, the animation speed is inverted and the character is always active',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
					false,
				),

				idleThreshold: GObject.ParamSpec.int(
					'idleThreshold',
					'Idle threshold',
					'CPU percentage below which the character is considered idle (0-100)',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT, 0, 100, 0,
				),

				isAnimationSmoothingEnabled: GObject.ParamSpec.boolean(
					'isAnimationSmoothingEnabled',
					'Smooth speed changes',
					'When true, running speed adapts to CPU load gradually',
					GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
					true,
				),
			} satisfies GObjectProperties<RunCatIndicatorReactiveProperties>,
		}, this)
	}

	extension: Extension
	settings: Gio.Settings

	sprites: Record<CharacterState, Gio.Icon[]>

	animationTimeoutId: number | null = null
	refreshDataTimeoutId: number | null = null
	displayingItemsHandlerId!: number
	metricsSettingsHandlerIds: number[] = []

	sampler = new MetricsSampler()
	lastSnapshot: MetricsSnapshot | null = null
	isSampling = false
	isDestroyed = false

	panelMetrics!: PanelMetrics
	customMetrics!: CustomMetricsWatcher
	dashboard!: Dashboard

	constructor(extension: Extension) {
		super(0.5, 'RunCat', false)

		this.extension = extension
		this.settings = extension.getSettings()

		this.sprites = getSpritesPack(this.extension.path)

		this.initSettingsListeners()
		this.initUi()
		this.initCustomMetrics()
		this.initAppearance()
		this.initDataRefreshSource()
	}

	get characterState(): CharacterState {
		if (this.isSpeedInverted) {
			return 'active'
		}

		return this.cpuUsage > this.idleThreshold / 100 ? 'active' : 'idle'
	}

	get frames(): Gio.Icon[] {
		return this.sprites[this.characterState]
	}

	get systemMonitorCommand() {
		const useCustomSystemMonitor = this.settings.get_boolean(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.ENABLED)
		const customSystemMonitorCommand = this.settings.get_string(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.COMMAND)

		return useCustomSystemMonitor ? customSystemMonitorCommand : SYSTEM_MONITOR_COMMAND
	}

	get enabledPanelMetrics(): Record<PanelMetricId, boolean> {
		return Object.fromEntries(PANEL_METRIC_IDS.map(
			id => [id, this.settings.get_boolean(SettingsSchemaKeys.PANEL_METRICS[id])],
		)) as Record<PanelMetricId, boolean>
	}

	get enabledDashboardCards(): Record<DashboardCardId, boolean> {
		return Object.fromEntries(DASHBOARD_CARD_IDS.map(
			id => [id, this.settings.get_boolean(SettingsSchemaKeys.DASHBOARD_CARDS[id])],
		)) as Record<DashboardCardId, boolean>
	}

	initDataRefreshSource() {
		const refresh = () => {
			// skip a tick instead of piling up requests when sampling is slow
			if (this.isSampling) {
				return GLib.SOURCE_CONTINUE
			}

			this.isSampling = true

			this.sampler.sample(this.settings.get_string(SettingsSchemaKeys.STORAGE_PATH))
				.then((snapshot) => {
					// the indicator may have been destroyed while sampling
					if (this.isDestroyed) return

					this.lastSnapshot = snapshot
					this.cpuUsage = snapshot.cpu.usage
					this.renderMetrics()
				})
				.catch((e: unknown) => console.error(`${LOG_PREFIX}: ${e}`))
				.finally(() => { this.isSampling = false })

			return GLib.SOURCE_CONTINUE
		}

		const restart = () => {
			if (this.refreshDataTimeoutId !== null) {
				GLib.source_remove(this.refreshDataTimeoutId)
			}

			const intervalS = Math.max(1, this.settings.get_int(SettingsSchemaKeys.REFRESH_INTERVAL))

			this.refreshDataTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalS * 1_000, refresh)
		}

		this.metricsSettingsHandlerIds.push(
			this.settings.connect(`changed::${SettingsSchemaKeys.REFRESH_INTERVAL}`, restart),
		)

		restart()
		refresh()
	}

	initCustomMetrics() {
		this.customMetrics = new CustomMetricsWatcher(() => this.renderMetrics())

		const updateFiles = () => this.customMetrics.setExplicitPaths(
			this.settings.get_strv(SettingsSchemaKeys.CUSTOM_METRICS.FILES),
		)

		this.metricsSettingsHandlerIds.push(
			this.settings.connect(`changed::${SettingsSchemaKeys.CUSTOM_METRICS.FILES}`, updateFiles),
			...[SettingsSchemaKeys.CUSTOM_METRICS.PANEL_FILES, SettingsSchemaKeys.CUSTOM_METRICS.HIDDEN_FILES].map(
				key => this.settings.connect(`changed::${key}`, () => this.renderMetrics()),
			),
		)

		updateFiles()
	}

	initAppearance() {
		const updateAppearance = () => {
			this.dashboard.setColumns(this.settings.get_int(SettingsSchemaKeys.APPEARANCE.DASHBOARD_COLUMNS))
			this.dashboard.setAppearance({
				chartColor: sanitizeCssColor(this.settings.get_string(SettingsSchemaKeys.APPEARANCE.CHART_COLOR)),
				backgroundColor: sanitizeCssColor(
					this.settings.get_string(SettingsSchemaKeys.APPEARANCE.DASHBOARD_BACKGROUND),
				),
			})

			this.renderMetrics()
		}

		for (const key of Object.values(SettingsSchemaKeys.APPEARANCE)) {
			this.metricsSettingsHandlerIds.push(this.settings.connect(`changed::${key}`, updateAppearance))
		}

		updateAppearance()
	}

	renderMetrics() {
		if (!this.lastSnapshot) {
			return
		}

		// the watcher reports its first files before the constructor is done
		const customSources = this.customMetrics?.sources ?? []

		this.panelMetrics.update(
			this.lastSnapshot,
			this.enabledPanelMetrics,
			customSources,
			this.settings.get_strv(SettingsSchemaKeys.CUSTOM_METRICS.PANEL_FILES),
		)

		// the dashboard is only visible (and worth updating) while the menu is open
		if (this.menu.isOpen) {
			const hiddenPaths = this.settings.get_strv(SettingsSchemaKeys.CUSTOM_METRICS.HIDDEN_FILES)

			this.dashboard.update(
				this.lastSnapshot,
				this.enabledDashboardCards,
				customSources.filter(({ path }) => !hiddenPaths.includes(path)),
			)
		}
	}

	initUi() {
		const box = new St.BoxLayout({
			styleClass: 'panel-status-menu-box runcat-menu',
		})

		const icon = new St.Icon({
			styleClass: 'system-status-icon runcat-menu__icon',
		})

		const label = new St.Label({
			text: '...',
			styleClass: 'runcat-menu__label',
			xExpand: true,
			yExpand: true,
			xAlign: Clutter.ActorAlign.FILL,
			yAlign: Clutter.ActorAlign.CENTER,
		})

		this.bind_property_full(
			ReactiveProperties.CPU_USAGE,
			label, 'text',
			GObject.BindingFlags.SYNC_CREATE,
			(_, usage: number) => [true, formatNumber(usage)],
			null,
		)

		this.bind_property_full(
			ReactiveProperties.DISPLAYING_ITEMS,
			label, 'visible',
			GObject.BindingFlags.SYNC_CREATE,
			(_, { percentage }: DisplayingItems) => [true, percentage],
			null,
		)

		this.bind_property(ReactiveProperties.CURRENT_SPRITE_FRAME, icon, 'gicon', GObject.BindingFlags.DEFAULT)

		this.bind_property_full(
			ReactiveProperties.DISPLAYING_ITEMS,
			icon, 'visible',
			GObject.BindingFlags.SYNC_CREATE,
			(_, { character }: DisplayingItems) => [true, character],
			null,
		)

		this.panelMetrics = new PanelMetrics(this.extension.path)

		box.add_child(icon)
		box.add_child(label)
		box.add_child(this.panelMetrics.actor)

		this.add_child(box)

		this.initAnimation()

		this.dashboard = new Dashboard(this.extension.path)

		this.menu.addMenuItem(this.dashboard.item)
		this.menu.addMenuItem(new PopupSeparatorMenuItem())

		this.menu.connect('open-state-changed', (_menu, isOpen: boolean) => {
			if (isOpen) {
				this.renderMetrics()
			}
		})

		this.menu.addAction(_('Open System Monitor'), () => {
			try {
				trySpawnCommandLine(this.systemMonitorCommand)
			} catch (e: unknown) {
				if (e instanceof Error) {
					Main.notifyError(_('Execution of “%s” failed').format(this.systemMonitorCommand), e.message)
				}

				console.error(e)
			}
		})

		this.menu.addMenuItem(new PopupSeparatorMenuItem())
		this.menu.addAction(_('Settings'), () => {
			try {
				this.extension.openPreferences()
			} catch (e: unknown) {
				if (e instanceof Error) {
					Main.notifyError(_('Failed to open extension settings'), e.message)
				}

				console.error(e)
			}
		})
	}

	initAnimation() {
		const ticker = createAnimationTicker()

		const showNextFrame = (): boolean => {
			const nowMs = GLib.get_monotonic_time() / 1_000
			const { index, nextDelayMs } = ticker.advanceTo(nowMs, this.frames.length)

			this.setCurrentSpriteFrame(this.frames[index])
			this.stopAnimation()

			this.animationTimeoutId = GLib.timeout_add(
				GLib.PRIORITY_DEFAULT,
				nextDelayMs,
				showNextFrame,
			)

			return GLib.SOURCE_REMOVE
		}

		const updateAnimationState = (immediate = false) => {
			const utilization = this.isSpeedInverted
				? MAX_CPU_UTILIZATION - this.cpuUsage
				: this.cpuUsage

			ticker.setTargetDuration(getAnimationCycleDurationMs(utilization), immediate)

			const shouldAnimate = this.displayingItems.character && this.frames.length > 1
			const shouldRestart = immediate || this.animationTimeoutId === null

			if (!shouldAnimate) {
				this.stopAnimation()
				this.setCurrentSpriteFrame(this.frames[0] ?? null)
			} else if (shouldRestart) {
				showNextFrame()
			}
		}

		for (const prop of [
			ReactiveProperties.CPU_USAGE,
			ReactiveProperties.IS_SPEED_INVERTED,
			ReactiveProperties.IDLE_THRESHOLD,
			ReactiveProperties.DISPLAYING_ITEMS,
			ReactiveProperties.IS_ANIMATION_SMOOTHING_ENABLED,
		]) {
			this.connect(
				`notify::${prop}`,
				() => updateAnimationState(
					!this.isAnimationSmoothingEnabled || prop === ReactiveProperties.IS_SPEED_INVERTED,
				),
			)
		}

		updateAnimationState()
	}

	setCurrentSpriteFrame(sprite: Gio.Icon) {
		if (sprite !== this.currentSpriteFrame) {
			this.currentSpriteFrame = sprite
		}
	}

	stopAnimation() {
		if (this.animationTimeoutId !== null) {
			GLib.source_remove(this.animationTimeoutId)
			this.animationTimeoutId = null
		}
	}

	initSettingsListeners() {
		this.settings.bind(
			SettingsSchemaKeys.INVERT_SPEED,
			this,
			ReactiveProperties.IS_SPEED_INVERTED,
			Gio.SettingsBindFlags.DEFAULT,
		)

		this.settings.bind(
			SettingsSchemaKeys.IDLE_THRESHOLD,
			this,
			ReactiveProperties.IDLE_THRESHOLD,
			Gio.SettingsBindFlags.DEFAULT,
		)

		this.settings.bind(
			SettingsSchemaKeys.SMOOTH_SPEED_CHANGES,
			this,
			ReactiveProperties.IS_ANIMATION_SMOOTHING_ENABLED,
			Gio.SettingsBindFlags.DEFAULT,
		)

		// TODO(gjs#397): replace the manual sync below with settings.bind_with_mapping
		// https://gitlab.gnome.org/GNOME/gjs/-/work_items/397
		// https://gitlab.gnome.org/fmuellner/gjs/-/commit/ce24aba9aa969b874533b4112bdda34dce2d6ea7
		//
		// this.settings.bind_with_mapping(
		//   gioSettingsKeys.DISPLAYING_ITEMS,
		//   this, gObjectPropertyNames.displayingItems,
		//   Gio.SettingsBindFlags.DEFAULT,
		//   (variant: GLib.Variant) => [true, displayingItemNickToValue[variant.unpack<DisplayingItemNick>()]],
		//   null
		// )

		const updateDisplayingItems = () => {
			const nick = this.settings.get_string(SettingsSchemaKeys.DISPLAYING_ITEMS) as DisplayingItemNick

			this.displayingItems = displayingItemNickToValue[nick]
		}

		this.displayingItemsHandlerId = this.settings.connect(
			`changed::${SettingsSchemaKeys.DISPLAYING_ITEMS}`,
			updateDisplayingItems,
		)

		updateDisplayingItems()

		const metricsKeys = [
			...Object.values(SettingsSchemaKeys.PANEL_METRICS),
			...Object.values(SettingsSchemaKeys.DASHBOARD_CARDS),
		]

		for (const key of metricsKeys) {
			this.metricsSettingsHandlerIds.push(
				this.settings.connect(`changed::${key}`, () => this.renderMetrics()),
			)
		}
	}

	destroy() {
		this.isDestroyed = true

		if (this.refreshDataTimeoutId !== null) {
			GLib.source_remove(this.refreshDataTimeoutId)
			this.refreshDataTimeoutId = null
		}

		this.settings.disconnect(this.displayingItemsHandlerId)
		this.metricsSettingsHandlerIds.forEach(id => this.settings.disconnect(id))
		this.metricsSettingsHandlerIds = []

		this.stopAnimation()
		this.sampler.destroy()
		this.customMetrics?.destroy()

		super.destroy()
	}
}
