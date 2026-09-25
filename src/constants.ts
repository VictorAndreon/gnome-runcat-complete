import type {
	DashboardCardId,
	PanelMetricId,
	DisplayingItemNick,
	DisplayingItems,
	RunCatIndicatorReactiveProperties,
} from './types'


export const LOG_PREFIX = 'RuncatExtension'

export const SYSTEM_MONITOR_COMMAND = 'gnome-system-monitor -r'

export const displayingItemNickToValue: Record<DisplayingItemNick, DisplayingItems> = {
	'character-and-percentage': { character: true, percentage: true },
	'percentage-only': { character: false, percentage: true },
	'character-only': { character: true, percentage: false },
} as const

export const SettingsSchemaKeys = {
	IDLE_THRESHOLD: 'idle-threshold',
	DISPLAYING_ITEMS: 'displaying-items',
	INVERT_SPEED: 'invert-speed',
	SMOOTH_SPEED_CHANGES: 'smooth-speed-changes',
	REFRESH_INTERVAL: 'refresh-interval',
	STORAGE_PATH: 'storage-path',
	PANEL_METRICS: {
		memory: 'panel-show-memory',
		storage: 'panel-show-storage',
		battery: 'panel-show-battery',
		network: 'panel-show-network',
		temperature: 'panel-show-temperature',
	},
	DASHBOARD_CARDS: {
		cpu: 'dashboard-show-cpu',
		memory: 'dashboard-show-memory',
		storage: 'dashboard-show-storage',
		battery: 'dashboard-show-battery',
		network: 'dashboard-show-network',
	},
	CUSTOM_METRICS: {
		FILES: 'custom-metrics-files',
		PANEL_FILES: 'custom-metrics-panel-files',
		HIDDEN_FILES: 'custom-metrics-hidden-files',
	},
	APPEARANCE: {
		CHART_COLOR: 'chart-color',
		DASHBOARD_BACKGROUND: 'dashboard-background-color',
		DASHBOARD_COLUMNS: 'dashboard-columns',
	},
	CUSTOM_SYSTEM_MONITOR: {
		ENABLED: 'custom-system-monitor-enabled',
		COMMAND: 'custom-system-monitor-command',
	},
} as const

export const PANEL_METRIC_IDS: PanelMetricId[] = ['temperature', 'memory', 'storage', 'battery', 'network']

export const DASHBOARD_CARD_IDS: DashboardCardId[] = ['cpu', 'memory', 'storage', 'battery', 'network']

export const ReactiveProperties = {
	CPU_USAGE: 'cpuUsage',
	CURRENT_SPRITE_FRAME: 'currentSpriteFrame',
	DISPLAYING_ITEMS: 'displayingItems',
	IS_SPEED_INVERTED: 'isSpeedInverted',
	IDLE_THRESHOLD: 'idleThreshold',
	IS_ANIMATION_SMOOTHING_ENABLED: 'isAnimationSmoothingEnabled',
} as const satisfies Record<string, keyof RunCatIndicatorReactiveProperties>
