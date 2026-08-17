const DB_NAME = 'opencast-grid-v3'
const DB_VERSION = 1
let database

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = event => {
      const db = event.target.result
      if (!db.objectStoreNames.contains('playlists')) {
        const store = db.createObjectStore('playlists', { keyPath: 'id' })
        store.createIndex('sourceURL', 'sourceURL', { unique: false })
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function request(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    let result
    try {
      result = operation(store)
    } catch (error) {
      reject(error)
      return
    }
    result.onsuccess = () => resolve(result.result)
    result.onerror = () => reject(result.error)
  })
}

function get(store, key) { return request(store, 'readonly', objectStore => objectStore.get(key)) }
function getAll(store) { return request(store, 'readonly', objectStore => objectStore.getAll()) }
function put(store, value) { return request(store, 'readwrite', objectStore => objectStore.put(value)) }
function remove(store, key) { return request(store, 'readwrite', objectStore => objectStore.delete(key)) }

function readJSON(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value) }
  catch { return fallback }
}

function makeID() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// 台灣電視公司（台視）主頻道：不加入播放牆，也不出現在探索目錄。
export function isBlockedChannel(channel) {
  if (!channel) return false
  const id = String(channel.id || '')
  const name = String(channel.name || '').trim()
  const country = String(channel.country || '').toUpperCase()
  if (id === 'TTV.tw' || id.endsWith(':TTV.tw')) return true
  if (country === 'TW' && name.toLowerCase() === 'ttv') return true
  return name.includes('台視') || name.includes('台视')
}

export async function initDB() {
  database = await openDatabase()
}

export function flagForCountry(code) {
  if (!code || code === 'INT') return '🌐'
  try {
    return String.fromCodePoint(
      0x1f1e6 - 65 + code.charCodeAt(0),
      0x1f1e6 - 65 + code.charCodeAt(1)
    )
  } catch { return '🌐' }
}

export function countryDisplayName(code) {
  if (code === 'INT') return '國際'
  if (code === 'M3U') return '播放清單'
  try { return new Intl.DisplayNames(['zh-Hant'], { type: 'region' }).of(code) || code }
  catch { return code }
}

function attribute(name, line) {
  const match = line.match(new RegExp(`${name}="([^"]*)"`, 'i'))
  return match?.[1] || null
}

export function parseM3U(text, prefix = '') {
  const lines = text.split(/\r?\n/)
  const result = []

  for (let index = 0; index < lines.length; index += 1) {
    const metadata = lines[index]
    if (!metadata.startsWith('#EXTINF:')) continue

    let streamURL = null
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim()
      if (candidate && !candidate.startsWith('#')) {
        streamURL = candidate
        break
      }
    }
    if (!streamURL || !/^https?:\/\//i.test(streamURL)) continue

    const sourceID = attribute('tvg-id', metadata) || `channel-${index}`
    const name = metadata.split(',', 2)[1]?.trim() || ''
    if (!name || /\[geo-blocked\]/i.test(name)) continue

    const listedCountry = attribute('tvg-country', metadata)
    const countryMatch = sourceID.match(/\.([A-Za-z]{2})(?:@|$)/)
    const country = listedCountry?.length >= 2
      ? listedCountry.slice(0, 2).toUpperCase()
      : countryMatch?.[1]?.toUpperCase() || 'INT'

    result.push({
      id: `m3u:${prefix ? `${prefix}:` : ''}${sourceID}`,
      name,
      url: streamURL,
      logoURL: attribute('tvg-logo', metadata),
      country,
      category: 'm3u'
    })
  }
  return result
}

export async function getPlaylists() { return getAll('playlists') }
export async function savePlaylist(playlist) { return put('playlists', playlist) }
export async function removePlaylist(id) { return remove('playlists', id) }

export async function importM3U(sourceURL) {
  let parsedURL
  try { parsedURL = new URL(sourceURL) }
  catch { throw new Error('請輸入有效的 M3U 網址。') }
  if (!['http:', 'https:'].includes(parsedURL.protocol)) throw new Error('網址必須使用 http 或 https。')

  const response = await fetch(sourceURL)
  if (!response.ok) throw new Error(`播放清單下載失敗（HTTP ${response.status}）。`)
  const text = await response.text()
  const existing = (await getPlaylists()).find(item => item.sourceURL === sourceURL)
  const id = existing?.id || makeID()
  const channels = parseM3U(text, id)
  if (!channels.length) throw new Error('播放清單中沒有可播放的頻道。')

  const header = text.match(/^#PLAYLIST:(.+)$/m)?.[1]?.trim()
  const fallbackName = decodeURIComponent(parsedURL.pathname.split('/').pop() || 'M3U Playlist')
    .replace(/\.m3u8?$/i, '') || 'M3U Playlist'

  const playlist = {
    id,
    name: header || fallbackName,
    sourceURL,
    content: text,
    channelCount: channels.length,
    importedAt: new Date().toISOString()
  }
  await savePlaylist(playlist)
  return playlist
}

export async function getAllChannels() {
  const playlists = (await getPlaylists())
    .sort((left, right) => String(left.importedAt || '').localeCompare(String(right.importedAt || '')))
  const seen = new Set()
  return playlists.flatMap(playlist => parseM3U(playlist.content, playlist.id))
    .filter(channel => !isBlockedChannel(channel))
    .filter(channel => seen.has(channel.id) ? false : (seen.add(channel.id), true))
}

async function getMeta(key, fallback) {
  const record = await get('meta', key)
  return record?.value ?? fallback
}

async function setMeta(key, value) { return put('meta', { key, value }) }

export async function getFavorites() { return getMeta('favorites', []) }
export async function getFavoriteOrder() { return getMeta('favoriteOrder', []) }
export async function getDeleted() { return new Set(await getMeta('deleted', [])) }
export async function getChannelOrder() { return getMeta('channelOrder', []) }
export async function saveFavoriteOrder(order) { return setMeta('favoriteOrder', order) }
export async function isFavorite(channelID) { return (await getFavorites()).includes(channelID) }

export async function toggleFavorite(channelID) {
  let favorites = await getFavorites()
  let order = await getFavoriteOrder()
  if (favorites.includes(channelID)) {
    favorites = favorites.filter(id => id !== channelID)
    order = order.filter(id => id !== channelID)
  } else {
    favorites = [...favorites.filter(id => id !== channelID), channelID]
    order = [...order.filter(id => id !== channelID), channelID]
  }
  await setMeta('favorites', favorites)
  await setMeta('favoriteOrder', order)
  return favorites
}

export async function deleteChannel(channelID) {
  const deleted = [...await getDeleted()]
  if (!deleted.includes(channelID)) deleted.push(channelID)
  await setMeta('deleted', deleted)
  await setMeta('favorites', (await getFavorites()).filter(id => id !== channelID))
  await setMeta('favoriteOrder', (await getFavoriteOrder()).filter(id => id !== channelID))
}

export async function saveChannelOrder(order) { return setMeta('channelOrder', order) }

export async function getFilteredChannels(category = 'all') {
  const [all, deleted, favorites, favoriteOrder, channelOrder] = await Promise.all([
    getAllChannels(), getDeleted(), getFavorites(), getFavoriteOrder(), getChannelOrder()
  ])
  const available = all.filter(channel => !deleted.has(channel.id))
  const pool = category === 'favorites'
    ? available.filter(channel => favorites.has(channel.id))
    : available
  const explicit = category === 'favorites' ? favoriteOrder : channelOrder

  // 位置固定：先照已保存的順序，其餘頻道依加入順序排在後面。
  const byID = new Map(pool.map(channel => [channel.id, channel]))
  const seen = new Set()
  const channels = []
  for (const id of explicit) {
    const channel = byID.get(id)
    if (channel && !seen.has(id)) {
      channels.push(channel)
      seen.add(id)
    }
  }
  for (const channel of pool) {
    if (!seen.has(channel.id)) {
      channels.push(channel)
      seen.add(channel.id)
    }
  }
  return { channels, favorites: new Set(favorites) }
}

export async function reorderChannels(firstID, secondID) {
  const channels = await getAllChannels()
  const order = (await getChannelOrder()).filter(id => channels.some(channel => channel.id === id))
  for (const channel of channels) if (!order.includes(channel.id)) order.push(channel.id)
  const first = order.indexOf(firstID)
  const second = order.indexOf(secondID)
  if (first < 0 || second < 0 || first === second) return order
  ;[order[first], order[second]] = [order[second], order[first]]
  await saveChannelOrder(order)
  return order
}

export async function getCatalog() { return getAll('catalog') }

export async function saveCatalog(channels) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('catalog', 'readwrite')
    const store = transaction.objectStore('catalog')
    const clearRequest = store.clear()
    clearRequest.onsuccess = () => channels.forEach(channel => store.put(channel))
    clearRequest.onerror = () => reject(clearRequest.error)
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function getCatalogMeta() { return getMeta('catalog-meta', null) }
export async function saveCatalogMeta(value) { return setMeta('catalog-meta', value) }
