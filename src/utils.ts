import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js'
import { LOG_PREFIX } from './constants.js'
import type { CharacterState } from './types'
import type { BatterySample } from './dataProviders/battery.js'
import type { ConnectionKind } from './dataProviders/network.js'
import type { CustomMetricsSnapshot } from './dataProviders/customMetrics.js'


/**
 * Load sprite icons per character state, auto-discovering `sprite-<i>-symbolic.svg` files.
 *
 * @param {string} root - extension root path
 *
 * @returns {Record<CharacterState, Gio.Icon[]>} sprites per state
 **/
export const getSpritesPack = (root: string): Record<CharacterState, Gio.Icon[]> => {
	const loadState = (state: CharacterState): Gio.Icon[] => {
		const sprites: Gio.Icon[] = []
		let i = 0

		while (true) {
			const path = `${root}/resources/icons/runcat/${state}/sprite-${i}-symbolic.svg`

			if (!Gio.file_new_for_path(path).query_exists(null)) {
				break
			}

			sprites.push(Gio.icon_new_for_string(path))
			i++
		}

		if (sprites.length === 0) {
			console.error(`${LOG_PREFIX}: no sprites found for "${state}" state`)
		}

		return sprites
	}

	return {
		active: loadState('active'),
		idle: loadState('idle'),
	}
}

const formatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
	style: 'percent',
})

export const formatNumber = (value: number): string => formatter.format(value)

const preciseFormatter = new Intl.NumberFormat(undefined, {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
	style: 'percent',
})

export const formatPercent = (value: number): string => preciseFormatter.format(value)

export const formatBytes = (bytes: number): string => GLib.format_size(Math.round(bytes))

export const formatRate = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`

const temperatureFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

export const formatTemperature = (celsius: number): string => `${temperatureFormatter.format(celsius)} °C`

export const formatDuration = (seconds: number): string => {
	const totalMinutes = Math.round(seconds / 60)
	const hours = Math.floor(totalMinutes / 60)
	const minutes = totalMinutes % 60

	return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

const BUNDLED_ICONS = ['cpu', 'memory', 'temperature', 'chart', 'sparkle', 'gpu'] as const

export type MetricIconName = typeof BUNDLED_ICONS[number] | 'storage'

const themedIcon = (...names: string[]): Gio.Icon => Gio.ThemedIcon.new_from_names(names)

export const getMetricIcon = (root: string, name: MetricIconName): Gio.Icon => name === 'storage'
	? themedIcon('drive-harddisk-symbolic')
	: Gio.icon_new_for_string(`${root}/resources/icons/metrics/${name}-symbolic.svg`)

export const getBatteryIcon = (battery: BatterySample | null): Gio.Icon => {
	if (!battery) {
		return themedIcon('battery-symbolic')
	}

	const level = Math.round(battery.level * 10) * 10
	const isCharging = battery.status === 'charging'
	const isCharged = level === 100 && (battery.status === 'full' || battery.isOnAcPower)

	let suffix = ''

	if (isCharged) {
		suffix = '-charged'
	} else if (isCharging) {
		suffix = '-charging'
	}

	return themedIcon(`battery-level-${level}${suffix}-symbolic`, 'battery-symbolic')
}

const networkIconNames: Record<ConnectionKind, string> = {
	ethernet: 'network-wired-symbolic',
	wifi: 'network-wireless-symbolic',
	vpn: 'network-vpn-symbolic',
	mobile: 'network-cellular-symbolic',
	bluetooth: 'bluetooth-active-symbolic',
	other: 'network-transmit-receive-symbolic',
	disconnected: 'network-offline-symbolic',
	unknown: 'network-transmit-receive-symbolic',
}

export const getNetworkIcon = (kind: ConnectionKind): Gio.Icon =>
	themedIcon(networkIconNames[kind], 'network-transmit-receive-symbolic')

// SF Symbols (used by RunCat Neo producers) → bundled icons
const sfSymbolIcons: Array<[RegExp, MetricIconName]> = [
	[/^(staroflife|sparkle|sparkles|wand)/, 'sparkle'],
	[/^cpu/, 'cpu'],
	[/^memorychip/, 'memory'],
	[/^(thermometer|flame)/, 'temperature'],
	[/^(internaldrive|externaldrive|opticaldiscdrive)/, 'storage'],
]

/**
 * Resolve the icon of a custom metrics source. `icon` may be a bundled icon name
 * (`cpu`, `memory`, `temperature`, `chart`, `sparkle`, `gpu`), an absolute path or
 * a freedesktop icon name; RunCat Neo's `symbol` is mapped to a bundled icon.
 **/
export const getCustomMetricIcon = (root: string, snapshot: CustomMetricsSnapshot | null): Gio.Icon => {
	const icon = snapshot?.icon

	if (icon) {
		if ((BUNDLED_ICONS as readonly string[]).includes(icon)) {
			return getMetricIcon(root, icon as MetricIconName)
		}

		if (icon.startsWith('/') || icon.startsWith('~/')) {
			return Gio.icon_new_for_string(icon.replace(/^~/, GLib.get_home_dir()))
		}

		return themedIcon(icon, 'utilities-system-monitor-symbolic')
	}

	const symbol = snapshot?.symbol ?? ''
	const match = sfSymbolIcons.find(([pattern]) => pattern.test(symbol))

	return getMetricIcon(root, match?.[1] ?? 'chart')
}

// rgb()/rgba() as written by Gdk.RGBA.to_string(), or hex colors
const CSS_COLOR_PATTERN = /^(#[\da-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i

/**
 * Validate a color from the settings before it goes into an inline CSS style.
 *
 * @returns {string} the color, or an empty string (theme default) when it isn't a valid color
 **/
export const sanitizeCssColor = (color: string): string => CSS_COLOR_PATTERN.test(color.trim()) ? color.trim() : ''

/**
 * Format how long ago a date was, e.g. "3 min ago".
 **/
export const formatRelativeTime = (date: Date, now = Date.now()): string => {
	const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000))

	if (seconds < 60) {
		return _('just now')
	}

	const minutes = Math.floor(seconds / 60)

	if (minutes < 60) {
		return ngettext('%d minute ago', '%d minutes ago', minutes).format(minutes)
	}

	const hours = Math.floor(minutes / 60)

	if (hours < 24) {
		return ngettext('%d hour ago', '%d hours ago', hours).format(hours)
	}

	const days = Math.floor(hours / 24)

	return ngettext('%d day ago', '%d days ago', days).format(days)
}
