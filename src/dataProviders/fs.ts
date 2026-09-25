import Gio from 'gi://Gio'


// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.File.prototype, 'load_contents_async')
// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.File.prototype, 'enumerate_children_async')
// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async')

const decoder = new TextDecoder('utf-8')


/**
 * Read a (small, usually procfs/sysfs) text file.
 *
 * @param {string} path - absolute file path
 *
 * @returns {Promise<string | null>} trimmed file contents or `null` if the file can't be read
 **/
export async function readText(path: string): Promise<string | null> {
	try {
		const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null)

		return decoder.decode(bytes).trim()
	} catch {
		return null
	}
}

/**
 * Read a text file containing a single number.
 *
 * @param {string} path - absolute file path
 *
 * @returns {Promise<number | null>} parsed number or `null` if the file is missing or not numeric
 **/
export async function readNumber(path: string): Promise<number | null> {
	const text = await readText(path)

	if (text === null || text === '') {
		return null
	}

	const value = Number(text)

	return Number.isFinite(value) ? value : null
}

/**
 * List the names of the entries of a directory.
 *
 * @param {string} path - absolute directory path
 *
 * @returns {Promise<string[]>} entry names, empty if the directory can't be read
 **/
export async function listDir(path: string): Promise<string[]> {
	try {
		const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
			Gio.FILE_ATTRIBUTE_STANDARD_NAME,
			Gio.FileQueryInfoFlags.NONE,
			0,
			null,
		)

		const names: string[] = []

		while (true) {
			const infos = await enumerator.next_files_async(64, 0, null)

			if (infos.length === 0) {
				break
			}

			names.push(...infos.map(info => info.get_name()))
		}

		enumerator.close(null)

		return names.sort()
	} catch {
		return []
	}
}

export const pathExists = (path: string): boolean => Gio.File.new_for_path(path).query_exists(null)
