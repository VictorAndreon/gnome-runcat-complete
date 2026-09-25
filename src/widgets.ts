import Clutter from 'gi://Clutter'
import St from 'gi://St'
import type Cairo from 'cairo'


/**
 * Create a vertical `St.BoxLayout`, compatible with both `vertical` (GNOME ≤ 47)
 * and `orientation` (GNOME 48+) APIs.
 **/
export const createVerticalBox = (params: Partial<St.BoxLayout.ConstructorProps> = {}): St.BoxLayout => {
	const box = new St.BoxLayout(params)

	;(box.layoutManager as Clutter.BoxLayout).orientation = Clutter.Orientation.VERTICAL

	return box
}

const getColor = (area: St.DrawingArea): [number, number, number, number] => {
	const { red, green, blue, alpha } = area.get_theme_node().get_foreground_color()

	return [red / 255, green / 255, blue / 255, alpha / 255]
}

const withContext = (area: St.DrawingArea, draw: (cr: Cairo.Context, width: number, height: number) => void) => {
	const cr = area.get_context() as unknown as Cairo.Context
	const [width, height] = area.get_surface_size()

	try {
		draw(cr, width, height)
	} finally {
		cr.$dispose()
	}
}


/**
 * Filled area chart of values in `[0, 1]`, newest value on the right.
 * The color is taken from the CSS `color` property.
 **/
export class Sparkline {
	readonly actor: St.DrawingArea

	#values: number[] = []
	#capacity: number

	constructor(capacity: number, styleClass = 'runcat-chart runcat-sparkline') {
		this.#capacity = capacity
		this.actor = new St.DrawingArea({ styleClass, xExpand: true })
		this.actor.connect('repaint', () => this.#draw())
	}

	setValues(values: number[]) {
		this.#values = values.slice(-this.#capacity)
		this.actor.queue_repaint()
	}

	#draw() {
		withContext(this.actor, (cr, width, height) => {
			const [r, g, b, a] = getColor(this.actor)
			const step = width / Math.max(1, this.#capacity - 1)
			const startX = width - (this.#values.length - 1) * step
			const y = (value: number) => height - Math.min(1, Math.max(0, value)) * height

			// baseline
			cr.setSourceRGBA(r, g, b, a * 0.35)
			cr.rectangle(0, height - 1, width, 1)
			cr.fill()

			if (this.#values.length < 2) {
				return
			}

			cr.setSourceRGBA(r, g, b, a)
			cr.moveTo(startX, height)
			this.#values.forEach((value, i) => cr.lineTo(startX + i * step, y(value)))
			cr.lineTo(width, height)
			cr.closePath()
			cr.fill()
		})
	}
}


/**
 * Horizontal bar showing a value in `[0, 1]`.
 * The color is taken from the CSS `color` property.
 **/
export class UsageBar {
	readonly actor: St.DrawingArea

	#value = 0

	constructor(styleClass = 'runcat-chart runcat-usage-bar') {
		this.actor = new St.DrawingArea({ styleClass, xExpand: true })
		this.actor.connect('repaint', () => this.#draw())
	}

	setValue(value: number) {
		this.#value = Math.min(1, Math.max(0, value))
		this.actor.queue_repaint()
	}

	#draw() {
		withContext(this.actor, (cr, width, height) => {
			const [r, g, b, a] = getColor(this.actor)

			cr.setSourceRGBA(r, g, b, a * 0.25)
			cr.rectangle(0, 0, width, height)
			cr.fill()

			cr.setSourceRGBA(r, g, b, a)
			cr.rectangle(0, 0, width * this.#value, height)
			cr.fill()
		})
	}
}
