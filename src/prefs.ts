import Adw from 'gi://Adw'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gdk from 'gi://Gdk'
import Gtk from 'gi://Gtk'

import {
	ExtensionPreferences,
	gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import { SettingsSchemaKeys } from './constants.js'
import {
	CUSTOM_METRICS_DIRECTORY,
	expandPath,
	parseCustomMetrics,
} from './dataProviders/customMetrics.js'


const CUSTOM_METRICS_DOCS_URL =
	'https://github.com/VictorAndreon/gnome-runcat-complete/blob/master/docs/custom-metrics.md'


// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gtk.UriLauncher.prototype, 'launch', 'launch_finish')

export default class RunCatPreferences extends ExtensionPreferences {
	#settings: Gio.Settings | null = null
	#builder: Gtk.Builder | null = null
	#window: Adw.PreferencesWindow | null = null
	#cleanups: Array<() => void> = []

	get #headerBar(): Adw.HeaderBar | null {
		const stack: Array<Gtk.Widget | null> = [this.#window]

		let widget

		while (stack.length > 0) {
			if (!(widget = stack.pop())) continue

			if (widget instanceof Adw.HeaderBar) {
				return widget
			}

			stack.push(
				widget.get_next_sibling(),
				widget.get_first_child(),
			)
		}

		return null
	}

	async fillPreferencesWindow(window: Adw.PreferencesWindow) {
		this.#window = window
		this.#settings = this.getSettings()

		this.#builder = new Gtk.Builder({ translationDomain: this.uuid })
		this.#builder.add_from_file(`${this.path}/resources/ui/preferences.ui`)

		this.#setupPage()
		this.#setupCustomMetrics()
		this.#setupAppearance()
		this.#setupMenu()

		this.#window.add(this.#builder.get_object<Adw.PreferencesPage>('preferences-general'))
		this.#window.add(this.#builder.get_object<Adw.PreferencesPage>('preferences-metrics'))
		this.#window.add(this.#builder.get_object<Adw.PreferencesPage>('preferences-custom-metrics'))

		this.#window.title = _('RunCat Settings')

		// force fields to be garbage collected on window close
		this.#window.connect('close-request', () => {
			this.#cleanups.forEach(cleanup => cleanup())
			this.#cleanups = []
			this.#settings = null
			this.#builder = null
			this.#window = null
		})
	}

	#setupPage() {
		// Idle Threshold
		this.#settings!.bind(
			SettingsSchemaKeys.IDLE_THRESHOLD,
			this.#builder!.get_object<Adw.SpinRow>(SettingsSchemaKeys.IDLE_THRESHOLD),
			'value',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Invert Speed
		this.#settings!.bind(
			SettingsSchemaKeys.INVERT_SPEED,
			this.#builder!.get_object<Adw.SwitchRow>(SettingsSchemaKeys.INVERT_SPEED),
			'active',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Smooth Speed Changes
		this.#settings!.bind(
			SettingsSchemaKeys.SMOOTH_SPEED_CHANGES,
			this.#builder!.get_object<Adw.SwitchRow>(SettingsSchemaKeys.SMOOTH_SPEED_CHANGES),
			'active',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Displaying Items
		const combo = this.#builder!.get_object<Adw.ComboRow>(SettingsSchemaKeys.DISPLAYING_ITEMS)

		// `Gio.Settings.bind_with_mapping` is missing in GJS: https://gitlab.gnome.org/GNOME/gjs/-/issues/397
		combo.set_selected(this.#settings!.get_enum(SettingsSchemaKeys.DISPLAYING_ITEMS))
		combo.connect('notify::selected', (/** @type {Adw.ComboRow} */ { selected }: Adw.ComboRow) => {
			this.#settings!.set_enum(SettingsSchemaKeys.DISPLAYING_ITEMS, selected)
		})

		// Enable custom system monitor
		this.#settings!.bind(
			SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.ENABLED,
			this.#builder!.get_object<Adw.ExpanderRow>(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.ENABLED),
			'enable-expansion',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Custom system monitor command
		this.#settings!.bind(
			SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.COMMAND,
			this.#builder!.get_object<Adw.EntryRow>(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.COMMAND),
			'text',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Refresh interval
		this.#settings!.bind(
			SettingsSchemaKeys.REFRESH_INTERVAL,
			this.#builder!.get_object<Adw.SpinRow>(SettingsSchemaKeys.REFRESH_INTERVAL),
			'value',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Storage path
		this.#settings!.bind(
			SettingsSchemaKeys.STORAGE_PATH,
			this.#builder!.get_object<Adw.EntryRow>(SettingsSchemaKeys.STORAGE_PATH),
			'text',
			Gio.SettingsBindFlags.DEFAULT,
		)

		// Top bar metrics and dashboard cards
		for (const key of [
			...Object.values(SettingsSchemaKeys.PANEL_METRICS),
			...Object.values(SettingsSchemaKeys.DASHBOARD_CARDS),
		]) {
			this.#settings!.bind(
				key,
				this.#builder!.get_object<Adw.SwitchRow>(key),
				'active',
				Gio.SettingsBindFlags.DEFAULT,
			)
		}

		// Reset
		this.#builder!.get_object<Gtk.Button>('reset').connect('clicked', () => {
			// Idle Threshold
			this.#settings!.reset(SettingsSchemaKeys.IDLE_THRESHOLD)

			// Invert Speed
			this.#settings!.reset(SettingsSchemaKeys.INVERT_SPEED)

			// Smooth Speed Changes
			this.#settings!.reset(SettingsSchemaKeys.SMOOTH_SPEED_CHANGES)

			// Enable custom system monitor
			this.#settings!.reset(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.ENABLED)

			// Custom system monitor command
			this.#settings!.reset(SettingsSchemaKeys.CUSTOM_SYSTEM_MONITOR.COMMAND)

			// Refresh interval & storage path
			this.#settings!.reset(SettingsSchemaKeys.REFRESH_INTERVAL)
			this.#settings!.reset(SettingsSchemaKeys.STORAGE_PATH)

			// Top bar metrics and dashboard cards
			for (const key of [
				...Object.values(SettingsSchemaKeys.PANEL_METRICS),
				...Object.values(SettingsSchemaKeys.DASHBOARD_CARDS),
			]) {
				this.#settings!.reset(key)
			}

			// Appearance
			for (const key of Object.values(SettingsSchemaKeys.APPEARANCE)) {
				this.#settings!.reset(key)
			}

			// Displaying Items
			this.#settings!.reset(SettingsSchemaKeys.DISPLAYING_ITEMS)
			combo.set_selected(this.#settings!.get_enum(SettingsSchemaKeys.DISPLAYING_ITEMS))
		})
	}

	#setupAppearance() {
		const settings = this.#settings!

		// Menu layout: the combo row index is the number of columns
		const columnsKey = SettingsSchemaKeys.APPEARANCE.DASHBOARD_COLUMNS
		const columnsRow = this.#builder!.get_object<Adw.ComboRow>(columnsKey)
		const syncColumns = () => columnsRow.set_selected(settings.get_int(columnsKey))

		columnsRow.connect('notify::selected', () => {
			if (settings.get_int(columnsKey) !== columnsRow.selected) {
				settings.set_int(columnsKey, columnsRow.selected)
			}
		})

		const columnsHandlerId = settings.connect(`changed::${columnsKey}`, syncColumns)

		this.#cleanups.push(() => settings.disconnect(columnsHandlerId))
		syncColumns()

		const { CHART_COLOR, DASHBOARD_BACKGROUND } = SettingsSchemaKeys.APPEARANCE

		for (const key of [CHART_COLOR, DASHBOARD_BACKGROUND]) {
			const row = this.#builder!.get_object<Adw.ActionRow>(key)

			const button = new Gtk.ColorDialogButton({
				dialog: new Gtk.ColorDialog({ withAlpha: true }),
				valign: Gtk.Align.CENTER,
			})

			const reset = new Gtk.Button({
				iconName: 'edit-undo-symbolic',
				valign: Gtk.Align.CENTER,
				tooltipText: _('Reset'),
				cssClasses: ['flat'],
			})

			const sync = () => {
				const rgba = new Gdk.RGBA()

				if (rgba.parse(settings.get_string(key)) && !rgba.equal(button.rgba)) {
					button.rgba = rgba
				}

				reset.sensitive = settings.get_user_value(key) !== null
			}

			button.connect('notify::rgba', () => {
				const current = new Gdk.RGBA()

				// don't turn the default into a user value when syncing from the settings
				if (!current.parse(settings.get_string(key)) || !current.equal(button.rgba)) {
					settings.set_string(key, button.rgba.to_string())
				}
			})

			reset.connect('clicked', () => settings.reset(key))

			const handlerId = settings.connect(`changed::${key}`, sync)

			this.#cleanups.push(() => settings.disconnect(handlerId))

			row.add_suffix(reset)
			row.add_suffix(button)

			sync()
		}
	}

	#setupCustomMetrics() {
		const settings = this.#settings!
		const builder = this.#builder!
		const group = builder.get_object<Adw.PreferencesGroup>('custom-metrics-sources')

		let rows: Gtk.Widget[] = []

		const getList = (key: string) => settings.get_strv(key).map(expandPath)

		const setListed = (key: string, path: string, isListed: boolean) => {
			const paths = getList(key).filter(p => p !== path)

			settings.set_strv(key, isListed ? [...paths, path] : paths)
		}

		const listDirectory = (): string[] => {
			try {
				const enumerator = Gio.File.new_for_path(CUSTOM_METRICS_DIRECTORY)
					.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null)

				const names: string[] = []
				let info

				while ((info = enumerator.next_file(null))) {
					names.push(info.get_name())
				}

				return names
					.filter(name => name.endsWith('.json') && !name.startsWith('.'))
					.sort()
					.map(name => GLib.build_filenamev([CUSTOM_METRICS_DIRECTORY, name]))
			} catch {
				return []
			}
		}

		const describe = (path: string): { title: string, error: string | null } => {
			try {
				const [, bytes] = Gio.File.new_for_path(path).load_contents(null)

				return { title: parseCustomMetrics(new TextDecoder().decode(bytes)).title, error: null }
			} catch (e) {
				const error = e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
					? _('The file does not exist yet')
					: `${e instanceof Error ? e.message : e}`

				return { title: GLib.path_get_basename(path), error }
			}
		}

		const render = () => {
			rows.forEach(row => group.remove(row))
			rows = []

			const explicit = getList(SettingsSchemaKeys.CUSTOM_METRICS.FILES)
			const panelFiles = getList(SettingsSchemaKeys.CUSTOM_METRICS.PANEL_FILES)
			const hiddenFiles = getList(SettingsSchemaKeys.CUSTOM_METRICS.HIDDEN_FILES)
			const paths = [...new Set([...explicit, ...listDirectory()])]

			if (paths.length === 0) {
				const row = new Adw.ActionRow({
					title: _('No custom metrics yet'),
					subtitle: _('Write a JSON file to %s or add a file').format(CUSTOM_METRICS_DIRECTORY),
					useMarkup: false,
				})

				group.add(row)
				rows.push(row)
			}

			for (const path of paths) {
				const { title, error } = describe(path)

				const row = new Adw.ActionRow({
					title,
					subtitle: error ? `${path}\n⚠ ${error}` : path,
					useMarkup: false,
				})

				const inMenu = new Gtk.CheckButton({
					label: _('Menu'),
					active: !hiddenFiles.includes(path),
					valign: Gtk.Align.CENTER,
					tooltipText: _('Show the card in the menu'),
				})

				const inPanel = new Gtk.CheckButton({
					label: _('Top bar'),
					active: panelFiles.includes(path),
					valign: Gtk.Align.CENTER,
					tooltipText: _('Show in the top bar'),
				})

				const { HIDDEN_FILES, PANEL_FILES } = SettingsSchemaKeys.CUSTOM_METRICS

				inMenu.connect('toggled', () => setListed(HIDDEN_FILES, path, !inMenu.active))
				inPanel.connect('toggled', () => setListed(PANEL_FILES, path, inPanel.active))

				row.add_suffix(inMenu)
				row.add_suffix(inPanel)

				if (explicit.includes(path)) {
					const remove = new Gtk.Button({
						iconName: 'user-trash-symbolic',
						valign: Gtk.Align.CENTER,
						tooltipText: _('Remove'),
						cssClasses: ['flat'],
					})

					remove.connect('clicked', () => {
						setListed(SettingsSchemaKeys.CUSTOM_METRICS.PANEL_FILES, path, false)
						setListed(SettingsSchemaKeys.CUSTOM_METRICS.HIDDEN_FILES, path, false)
						settings.set_strv(
							SettingsSchemaKeys.CUSTOM_METRICS.FILES,
							explicit.filter(p => p !== path),
						)
					})

					row.add_suffix(remove)
				}

				group.add(row)
				rows.push(row)
			}
		}

		// Add a file outside of the metrics folder
		builder.get_object<Gtk.Button>('custom-metrics-add').connect('clicked', () => {
			const filter = new Gtk.FileFilter({ name: _('JSON files') })

			filter.add_pattern('*.json')

			const filters = new Gio.ListStore({ itemType: Gtk.FileFilter.$gtype })

			filters.append(filter)

			new Gtk.FileDialog({ title: _('Add custom metrics file'), filters })
				.open(this.#window, null)
				.then((file) => {
					const path = file.get_path()
					const paths = getList(SettingsSchemaKeys.CUSTOM_METRICS.FILES)

					if (path && !paths.includes(path)) {
						settings.set_strv(SettingsSchemaKeys.CUSTOM_METRICS.FILES, [...paths, path])
					}
				})
				.catch(() => { /* dismissed */ })
		})

		builder.get_object<Adw.ActionRow>('custom-metrics-open-folder').connect('activated', () => {
			GLib.mkdir_with_parents(CUSTOM_METRICS_DIRECTORY, 0o755)

			new Gtk.UriLauncher({ uri: GLib.filename_to_uri(CUSTOM_METRICS_DIRECTORY, null) })
				.launch(this.#window, null)
				.catch(console.error)
		})

		builder.get_object<Adw.ActionRow>('custom-metrics-open-folder').subtitle = CUSTOM_METRICS_DIRECTORY

		builder.get_object<Adw.ActionRow>('custom-metrics-docs').connect('activated', () => {
			new Gtk.UriLauncher({ uri: CUSTOM_METRICS_DOCS_URL })
				.launch(this.#window, null)
				.catch(console.error)
		})

		// Keep the list in sync with the settings and the metrics folder
		const settingsHandlerId = settings.connect(`changed::${SettingsSchemaKeys.CUSTOM_METRICS.FILES}`, render)

		let monitor: Gio.FileMonitor | null = null

		try {
			GLib.mkdir_with_parents(CUSTOM_METRICS_DIRECTORY, 0o755)

			monitor = Gio.File.new_for_path(CUSTOM_METRICS_DIRECTORY)
				.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null)

			monitor.connect('changed', render)
		} catch (e) {
			console.error(e)
		}

		this.#cleanups.push(() => {
			settings.disconnect(settingsHandlerId)
			monitor?.cancel()
		})

		render()
	}

	#setupMenu() {
		if (!this.#builder) return

		const homepageAction = Gio.SimpleAction.new('homepage', null)

		homepageAction.connect(
			'activate',
			() => new Gtk.UriLauncher({ uri: this.metadata.url! })
				.launch(this.#window, null)
				.catch(console.error),
		)

		const aboutAction = Gio.SimpleAction.new('about', null)

		aboutAction.connect('activate', () => {
			const logo = Gtk.Image.new_from_file(`${this.path}/resources/se.kolesnikov.runcat.svg`)

			const aboutDialog = this.#builder!.get_object<Gtk.AboutDialog>('about-dialog')

			aboutDialog.set_property('logo', logo.get_paintable())
			aboutDialog.set_property('version', `${_('Version')} ${this.metadata.version}`)
			aboutDialog.set_property('transient_for', this.#window)

			aboutDialog.show()
		})

		const group = Gio.SimpleActionGroup.new()

		group.add_action(homepageAction)
		group.add_action(aboutAction)

		const menu = this.#builder.get_object<Gtk.MenuButton>('menu-button')

		menu.insert_action_group('prefs', group)

		this.#headerBar?.pack_end(menu)
	}
}
