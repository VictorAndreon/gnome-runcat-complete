import Gio from 'gi://Gio'


// eslint-disable-next-line no-underscore-dangle
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async')


export type StorageSample = {
	path: string
	// utilization in [0, 1]
	usage: number
	// all sizes are in bytes
	total: number
	used: number
	free: number
}

const ATTRIBUTES = [
	Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE,
	Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE,
	Gio.FILE_ATTRIBUTE_FILESYSTEM_USED,
].join(',')


export default async function getStorageSample(path: string): Promise<StorageSample | null> {
	try {
		const info = await Gio.File.new_for_path(path || '/').query_filesystem_info_async(ATTRIBUTES, 0, null)

		const total = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_SIZE)
		const free = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_FREE)

		// `filesystem::used` isn't provided by every filesystem
		const used = info.has_attribute(Gio.FILE_ATTRIBUTE_FILESYSTEM_USED)
			? info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_FILESYSTEM_USED)
			: total - free

		if (total <= 0) {
			return null
		}

		return {
			path: path || '/',
			usage: Math.min(1, used / total),
			total,
			used,
			free,
		}
	} catch {
		return null
	}
}
