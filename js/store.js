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

function idbGet(store, key) { return request(store, 'readonly', objectStore => objectStore.get(key)) }
function idbGetAll(store) { return request(store, 'readonly', objectStore => objectStore.getAll()) }
function idbPut(store, value) { return request(store, 'readwrite', objectStore => objectStore.put(value)) }
function idbRemove(store, key) { return request(store, 'readwrite', objectStore => objectStore.delete(key)) }

// ---- 共用資料層：站台伺服器（所有 client 共用一份）或退回本機 IndexedDB ----
// 共用範圍：playlists（M3U 來源與探索器匯入的頻道）＋ meta 中與最愛／排序／刪除
// 相關的鍵。catalog（iptv-org 探索快取）與 catalog-meta 保持本機，UI 偏好另存 localStorage。
const SHARED_META_KEYS = new Set([
  'deleted', 'channelOrder', 'favoriteGroups', 'activeFavoriteGroup',
  'favorites', 'favoriteOrder'
])
const isSharedMetaKey = key => SHARED_META_KEYS.has(key) || String(key).startsWith('favoriteGroup:')

const storeState = { mode: 'idb', serverDoc: null, syncChain: Promise.resolve() }

function sharedSnapshot() {
  return {
    playlists: storeState.serverDoc?.playlists || [],
    meta: storeState.serverDoc?.meta || {}
  }
}

function scheduleServerSync() {
  const snapshot = sharedSnapshot()
  storeState.syncChain = storeState.syncChain
    .catch(() => {})
    .then(() => fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    }).then(response => {
      if (!response.ok) throw new Error('伺服器回應 HTTP ' + response.status)
    }))
    .catch(error => {
      console.warn('[store] 同步到伺服器失敗：', error.message)
      window.dispatchEvent(new CustomEvent('oc-store-sync-failed', { detail: error.message }))
    })
  return storeState.syncChain
}

function get(store, key) {
  if (store === 'meta' && storeState.mode === 'server' && isSharedMetaKey(key)) {
    const value = storeState.serverDoc.meta[key]
    return Promise.resolve(value === undefined ? undefined : { key, value: JSON.parse(JSON.stringify(value)) })
  }
  return idbGet(store, key)
}

function getAll(store) {
  if (store === 'playlists' && storeState.mode === 'server') {
    return Promise.resolve([...(storeState.serverDoc.playlists || [])])
  }
  return idbGetAll(store)
}

function put(store, value) {
  if (store === 'playlists' && storeState.mode === 'server') {
    const list = storeState.serverDoc.playlists || (storeState.serverDoc.playlists = [])
    const index = list.findIndex(item => item.id === value.id)
    if (index >= 0) list[index] = value
    else list.push(value)
    void scheduleServerSync()
    void idbPut('playlists', value).catch(() => {})
    return Promise.resolve(value)
  }
  if (store === 'meta' && storeState.mode === 'server' && isSharedMetaKey(value.key)) {
    storeState.serverDoc.meta[value.key] = value.value
    void scheduleServerSync()
    void idbPut('meta', value).catch(() => {})
    return Promise.resolve(value)
  }
  return idbPut(store, value)
}

function remove(store, key) {
  if (store === 'playlists' && storeState.mode === 'server') {
    const list = storeState.serverDoc.playlists || []
    storeState.serverDoc.playlists = list.filter(item => item.id !== key)
    void scheduleServerSync()
    void idbRemove('playlists', key).catch(() => {})
    return Promise.resolve()
  }
  if (store === 'meta' && storeState.mode === 'server' && isSharedMetaKey(key)) {
    delete storeState.serverDoc.meta[key]
    void scheduleServerSync()
    void idbRemove('meta', key).catch(() => {})
    return Promise.resolve()
  }
  return idbRemove(store, key)
}

function normalizeSharedDoc(doc) {
  const out = { playlists: [], meta: {} }
  if (doc && Array.isArray(doc.playlists)) out.playlists = doc.playlists
  if (doc && doc.meta && typeof doc.meta === 'object') {
    for (const [key, value] of Object.entries(doc.meta)) {
      if (isSharedMetaKey(key)) out.meta[key] = value
    }
  }
  return out
}

async function readLocalShared() {
  const playlists = await idbGetAll('playlists').catch(() => [])
  const meta = {}
  const records = await idbGetAll('meta').catch(() => [])
  for (const record of records) {
    if (isSharedMetaKey(record.key)) meta[record.key] = record.value
  }
  return { playlists, meta }
}

async function mirrorSharedToIdb() {
  const doc = storeState.serverDoc
  try {
    const transaction = database.transaction('playlists', 'readwrite')
    const store = transaction.objectStore('playlists')
    await new Promise((resolve, reject) => {
      const clearRequest = store.clear()
      clearRequest.onsuccess = () => { for (const playlist of doc.playlists) store.put(playlist) }
      clearRequest.onerror = () => reject(clearRequest.error)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
    })
    const existing = await idbGetAll('meta').catch(() => [])
    for (const record of existing) {
      if (isSharedMetaKey(record.key) && !(record.key in doc.meta)) await idbRemove('meta', record.key).catch(() => {})
    }
    for (const [key, value] of Object.entries(doc.meta)) {
      await idbPut('meta', { key, value }).catch(() => {})
    }
  } catch (error) {
    console.warn('[store] 本機鏡像更新失敗：', error.message)
  }
}

// 啟動時決定資料層模式：連上 server 就用共用文件，否則退回本機 IndexedDB。
// 第一次接上 server 且 server 還是空的、本機卻已有資料時，把本機資料搬上去共用。
export async function initSharedStore() {
  let response
  try {
    response = await fetch('/api/state', { cache: 'no-store' })
  } catch {
    storeState.mode = 'idb'
    return
  }
  if (!response.ok) {
    storeState.mode = 'idb'
    return
  }

  let serverDoc = {}
  try { serverDoc = await response.json() } catch { serverDoc = {} }
  const serverBlank = !(serverDoc.playlists?.length || Object.keys(serverDoc.meta || {}).length)
  storeState.mode = 'server'
  storeState.serverDoc = { playlists: [], meta: {} }

  if (!serverBlank) {
    storeState.serverDoc = normalizeSharedDoc(serverDoc)
    await mirrorSharedToIdb()
    return
  }

  const local = await readLocalShared()
  if (local.playlists.length || Object.keys(local.meta).length) {
    storeState.serverDoc = normalizeSharedDoc(local)
    storeState.serverDoc.meta = local.meta
    await scheduleServerSync()
  }
}

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

export const DEFAULT_FAVORITE_GROUP_ID = 'default'
export const FAVORITE_CATEGORY_PREFIX = 'fav:'

// 分類值以 "fav:<groupID>" 表示一份最愛清單；"all" 代表全部頻道。
export function favoriteCategory(groupID) { return `${FAVORITE_CATEGORY_PREFIX}${groupID}` }
export function isFavoriteCategory(category) { return String(category || '').startsWith(FAVORITE_CATEGORY_PREFIX) }
export function favoriteGroupID(category) {
  return isFavoriteCategory(category) ? String(category).slice(FAVORITE_CATEGORY_PREFIX.length) : null
}

export async function getDeleted() { return new Set(await getMeta('deleted', [])) }
export async function getChannelOrder() { return getMeta('channelOrder', []) }

// 多份可自訂名稱的最愛清單：清單本身存於 meta.favoriteGroups，
// 每份清單的頻道與順序存於 meta["favoriteGroup:<id>"]。
export async function getFavoriteGroups() {
  const stored = await getMeta('favoriteGroups', null)
  if (Array.isArray(stored) && stored.length) {
    return stored
      .filter(group => group && group.id)
      .map(group => ({ id: String(group.id), name: String(group.name || '').trim() || '未命名最愛' }))
  }
  const groups = [{ id: DEFAULT_FAVORITE_GROUP_ID, name: '我的最愛' }]
  await setMeta('favoriteGroups', groups)
  return groups
}

export async function getActiveFavoriteGroupID() {
  const groups = await getFavoriteGroups()
  const active = await getMeta('activeFavoriteGroup', null)
  return groups.some(group => group.id === active) ? active : groups[0].id
}

export async function setActiveFavoriteGroupID(groupID) { return setMeta('activeFavoriteGroup', groupID) }

export async function getFavoriteGroupIDs(groupID) {
  const id = groupID || DEFAULT_FAVORITE_GROUP_ID
  const stored = await getMeta(`favoriteGroup:${id}`, null)
  if (Array.isArray(stored)) return stored
  if (id === DEFAULT_FAVORITE_GROUP_ID) {
    // 舊版單一「我的最愛」遷移進預設清單。
    const legacy = await getMeta('favorites', [])
    const order = await getMeta('favoriteOrder', [])
    const merged = [
      ...order.filter(value => legacy.includes(value)),
      ...legacy.filter(value => !order.includes(value))
    ]
    await setMeta(`favoriteGroup:${id}`, merged)
    return merged
  }
  return []
}

export async function saveFavoriteGroupOrder(groupID, order) {
  return setMeta(`favoriteGroup:${groupID || DEFAULT_FAVORITE_GROUP_ID}`, order)
}

export async function isFavoriteInGroup(groupID, channelID) {
  return (await getFavoriteGroupIDs(groupID)).includes(channelID)
}

export async function toggleFavoriteInGroup(groupID, channelID) {
  const id = groupID || DEFAULT_FAVORITE_GROUP_ID
  const current = await getFavoriteGroupIDs(id)
  const next = current.includes(channelID)
    ? current.filter(value => value !== channelID)
    : [...current.filter(value => value !== channelID), channelID]
  await setMeta(`favoriteGroup:${id}`, next)
  return next
}

export async function createFavoriteGroup(name) {
  const groups = await getFavoriteGroups()
  const group = {
    id: `fav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: String(name || '').trim() || `我的最愛 ${groups.length + 1}`
  }
  await setMeta('favoriteGroups', [...groups, group])
  await setMeta(`favoriteGroup:${group.id}`, [])
  return group
}

export async function renameFavoriteGroup(groupID, name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null
  const groups = await getFavoriteGroups()
  const next = groups.map(group => group.id === groupID ? { ...group, name: trimmed } : group)
  await setMeta('favoriteGroups', next)
  return next
}

export async function deleteFavoriteGroup(groupID) {
  const groups = await getFavoriteGroups()
  if (groups.length <= 1) throw new Error('至少要保留一份最愛清單。')
  const remaining = groups.filter(group => group.id !== groupID)
  await setMeta('favoriteGroups', remaining)
  await remove('meta', `favoriteGroup:${groupID}`)
  if (await getMeta('activeFavoriteGroup', null) === groupID) await setMeta('activeFavoriteGroup', remaining[0].id)
  return remaining
}

export async function getFavoriteCounts() {
  const groups = await getFavoriteGroups()
  const counts = {}
  for (const group of groups) counts[group.id] = (await getFavoriteGroupIDs(group.id)).length
  return counts
}

// 目前作用清單的便利函式，沿用舊的呼叫方式。
export async function getFavorites() { return getFavoriteGroupIDs(await getActiveFavoriteGroupID()) }
export async function isFavorite(channelID) { return isFavoriteInGroup(await getActiveFavoriteGroupID(), channelID) }
export async function toggleFavorite(channelID) { return toggleFavoriteInGroup(await getActiveFavoriteGroupID(), channelID) }

export async function deleteChannel(channelID) {
  const deleted = [...await getDeleted()]
  if (!deleted.includes(channelID)) deleted.push(channelID)
  await setMeta('deleted', deleted)
  const groups = await getFavoriteGroups()
  for (const group of groups) {
    const ids = await getFavoriteGroupIDs(group.id)
    if (ids.includes(channelID)) await setMeta(`favoriteGroup:${group.id}`, ids.filter(id => id !== channelID))
  }
  await setMeta('favoriteOrder', (await getMeta('favoriteOrder', [])).filter(id => id !== channelID))
}

export async function saveChannelOrder(order) { return setMeta('channelOrder', order) }

export async function getFilteredChannels(category = 'all') {
  const [all, deleted, channelOrder] = await Promise.all([
    getAllChannels(), getDeleted(), getChannelOrder()
  ])
  const available = all.filter(channel => !deleted.has(channel.id))
  const groupID = favoriteGroupID(category)
  let pool = available
  let explicit = channelOrder
  let favoriteSet = new Set()
  if (groupID) {
    const ids = await getFavoriteGroupIDs(groupID)
    favoriteSet = new Set(ids)
    pool = available.filter(channel => favoriteSet.has(channel.id))
    explicit = ids
  }

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
  return { channels, favorites: favoriteSet, groupID: groupID || null, total: available.length }
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
