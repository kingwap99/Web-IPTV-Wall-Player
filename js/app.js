import {
  initDB,
  getFilteredChannels,
  getPlaylists,
  getChannelOrder,
  getFavoriteOrder,
  saveChannelOrder,
  saveFavoriteOrder,
  savePlaylist,
  removePlaylist,
  importM3U,
  toggleFavorite,
  isFavorite,
  deleteChannel,
  isBlockedChannel,
  countryDisplayName,
  flagForCountry
} from './store.js'
import { loadCatalog } from './catalog.js'

const app = document.querySelector('#app')
function toast(message, duration = 2200) {
  const node = element('div', { className: 'toast', text: message })
  document.body.append(node)
  setTimeout(() => node.remove(), duration)
}
const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') node.className = value
    else if (key === 'style') Object.assign(node.style, value)
    else if (key === 'text') node.textContent = value
    else if (key === 'selected' || key === 'disabled' || key === 'muted') node[key] = Boolean(value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

const state = {
  category: localStorage.getItem('oc-category') || 'all',
  country: 'ALL',
  mode: localStorage.getItem('oc-mode') || '4x4',
  page: Number(localStorage.getItem('oc-page') || 0),
  featuredID: localStorage.getItem('oc-featured') || null,
  fullscreen: false,
  modeBeforeFullscreen: localStorage.getItem('oc-mode-before-fullscreen') || '4x4',
  pageBeforeFullscreen: Number(localStorage.getItem('oc-page-before-fullscreen') || 0),
  paused: localStorage.getItem('oc-paused') === 'true',
  heroVolume: Number(localStorage.getItem('oc-hero-volume') || 0.7),
  controlsVisible: true,
  baseChannels: [],
  channels: [],
  favorites: new Set(),
  reorderActive: false,
  reorderSelectedID: null,
  reorderSnapshot: [],
  reorderCategory: 'all',
  heroPlayer: null,
  resizeObserver: null,
  hideTimer: null,
  contextMenu: null,
  modal: null,
  surface: null,
  hero: null,
  heroInfo: null,
  heroControls: null,
  toolbar: null,
  pageControls: null
}

const playerPool = new Map()
const MAX_PLAYERS = 24

function playerKey(channel) { return `${channel.id}|${channel.url}` }

function createPlayer(channel, muted = true) {
  const key = playerKey(channel)
  const existing = playerPool.get(key)
  if (existing) {
    existing.video.muted = muted
    return existing
  }

  if (playerPool.size >= MAX_PLAYERS) {
    const oldestKey = playerPool.keys().next().value
    if (oldestKey) destroyPlayer(oldestKey)
  }

  const video = element('video', { playsinline: true, autoplay: true, loop: true, muted, preload: 'auto' })
  const player = { key, channelID: channel.id, url: channel.url, video, hls: null }

  if (window.Hls?.isSupported()) {
    const hls = new window.Hls({
      enableWorker: false,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 30
    })
    hls.loadSource(channel.url)
    hls.attachMedia(video)
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}))
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      else destroyPlayer(key)
    })
    player.hls = hls
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = channel.url
    video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true })
  }

  playerPool.set(key, player)
  return player
}

function destroyPlayer(key) {
  const player = playerPool.get(key)
  if (!player) return
  try {
    player.hls?.destroy()
    player.video.pause()
    player.video.removeAttribute('src')
    player.video.load()
  } catch { /* player is already gone */ }
  player.video.remove()
  playerPool.delete(key)
}

function fadeVolume(video, target, duration) {
  const start = video.volume
  const startedAt = performance.now()
  return new Promise(resolve => {
    const step = now => {
      const progress = Math.min((now - startedAt) / duration, 1)
      const eased = progress < 0.5
        ? 2 * progress * progress
        : -1 + (4 - 2 * progress) * progress
      video.volume = start + (target - start) * eased
      if (progress < 1) requestAnimationFrame(step)
      else { video.volume = target; resolve() }
    }
    requestAnimationFrame(step)
  })
}

function showControls() {
  state.controlsVisible = true
  updateControlVisibility()
  clearTimeout(state.hideTimer)
  state.hideTimer = setTimeout(() => {
    if (!state.reorderActive) {
      state.controlsVisible = false
      updateControlVisibility()
    }
  }, 5000)
}

function updateControlVisibility() {
  const hidden = !state.controlsVisible
  state.toolbar?.classList.toggle('is-hidden', hidden || state.fullscreen)
  state.heroControls?.classList.toggle('is-hidden', hidden)
  state.heroInfo?.classList.toggle('is-hidden', hidden)
  state.hero?.querySelector('.hero-brand')?.classList.toggle('is-hidden', hidden || state.fullscreen)
  state.pageControls?.classList.toggle('is-hidden', hidden)
}

function visiblePageSize() { return state.mode === '5x5' ? 16 : 12 }
function pageCount() { return Math.max(1, Math.ceil(state.channels.length / visiblePageSize())) }
function pageChannels() {
  const start = (state.page % pageCount()) * visiblePageSize()
  return state.channels.slice(start, start + visiblePageSize())
}

function perimeterCells(count) {
  const cells = []
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (row === 0 || row === count - 1 || column === 0 || column === count - 1) cells.push({ row, column })
    }
  }
  return cells
}

function centerGeometry(count, width, height) {
  const cellWidth = width / count
  const cellHeight = height / count
  const span = count === 4 ? 2 : 3
  return {
    left: (width - cellWidth * span) / 2,
    top: (height - cellHeight * span) / 2,
    width: cellWidth * span,
    height: cellHeight * span
  }
}

async function loadState() {
  const result = await getFilteredChannels(state.category)
  state.baseChannels = result.channels
  state.favorites = result.favorites
  state.channels = state.country === 'ALL'
    ? [...state.baseChannels]
    : state.baseChannels.filter(channel => channel.country === state.country)
  state.page = Math.min(state.page, pageCount() - 1)
}

function renderEmpty() {
  app.innerHTML = ''
  const shell = element('div', { className: 'app-shell' })
  const empty = element('div', { className: 'wall-root' },
    element('div', { className: 'empty-state' },
      element('div', { className: 'empty-preview' },
        element('div', { className: 'empty-preview-grid' },
          ...Array.from({ length: 16 }, (_, index) => element('div', {
            className: `empty-preview-cell${[5, 6, 9, 10].includes(index) ? ' center' : ''}`
          }))
        )
      ),
      element('h1', { text: '建立你的第一面 IPTV Wall' }),
      element('p', { text: '一個畫面，同時看見世界。選擇一種方式加入你的頻道；OpenCast Grid 不內建或代管影音內容。' }),
      element('div', { className: 'empty-actions' },
        element('button', { className: 'primary', onclick: openCatalog, text: '探索公開頻道' }),
        element('button', { onclick: openImport, text: '匯入 M3U 網址' })
      )
    )
  )
  shell.append(empty)
  app.append(shell)
}

function renderToolbar() {
  const countryCounts = new Map()
  for (const channel of state.baseChannels) countryCounts.set(channel.country, (countryCounts.get(channel.country) || 0) + 1)
  const countries = [...countryCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))

  state.toolbar = element('div', { className: 'app-toolbar' },
    element('div', { className: 'brand' }, element('span', { className: 'brand-mark', text: 'O' }), 'IPTV WALL'),
    element('button', { className: state.category === 'all' ? 'active' : '', onclick: () => selectCategory('all'), text: '全部頻道' }),
    element('button', { className: state.category === 'favorites' ? 'active' : '', onclick: () => selectCategory('favorites'), text: '我的最愛' }),
    element('select', { onchange: event => { state.country = event.target.value; state.page = 0; render() } },
      element('option', { value: 'ALL', selected: state.country === 'ALL', text: '所有國家' }),
      ...countries.map(([country, count]) => element('option', {
        value: country, selected: state.country === country, text: `${flagForCountry(country)} ${country} (${count})`
      }))
    ),
    element('div', { className: 'toolbar-group' },
      element('button', { className: state.mode === '4x4' ? 'active' : '', onclick: () => selectMode('4x4'), text: '4×4' }),
      element('button', { className: state.mode === '5x5' ? 'active' : '', onclick: () => selectMode('5x5'), text: '5×5' }),
      element('button', { onclick: toggleFullscreen, text: '⛶' })
    ),
    element('button', { onclick: openCatalog, text: '頻道探索' }),
    element('button', { onclick: openImport, text: '匯入 M3U' }),
    element('button', { onclick: openPlaylistManager, text: '頻道庫' })
  )
  return state.toolbar
}

function createMiniChannel(channel, cell, width, height) {
  const focused = state.reorderSelectedID === channel.id
  const featured = state.featuredID === channel.id
  const mini = element('div', {
    className: `mini-channel${featured ? ' is-featured' : ''}${focused ? ' is-focused' : ''}${state.reorderActive && focused ? ' is-reordering' : ''}`,
    style: { left: `${cell.column * width}px`, top: `${cell.row * height}px`, width: `${width}px`, height: `${height}px` }
  })

  const placeholder = element('div', { className: 'mini-placeholder' },
    element('div', { className: 'flag', text: flagForCountry(channel.country) }),
    element('div', { text: channel.name })
  )
  mini.append(placeholder)

  if (!featured) {
    const player = createPlayer(channel, true)
    player.video.className = ''
    player.video.style.cssText = ''
    player.video.addEventListener('playing', () => {
      player.video.classList.add('is-playing')
      placeholder.style.display = 'none'
    }, { once: true })
    mini.insertBefore(player.video, placeholder)
    if (state.paused) player.video.pause()
    else player.video.play().catch(() => {})
  } else {
    placeholder.innerHTML = ''
    placeholder.append(
      element('div', { className: 'flag', text: '▶' }),
      element('div', { text: '目前大頻道' })
    )
  }

  mini.append(element('div', { className: 'mini-overlay' },
    element('div', { className: 'mini-topline' },
      element('span', { text: `#${String(state.channels.indexOf(channel) + 1).padStart(2, '0')}` }),
      element('span', { text: `${flagForCountry(channel.country)} ${channel.country}` })
    ),
    element('div', { className: 'mini-bottomline' },
      element('span', { className: 'mini-name', text: channel.name }),
      element('span', { className: `mini-status${state.paused ? ' paused' : ''}`, text: state.paused ? '已暫停' : 'LIVE' })
    )
  ))
  mini.append(element('div', { className: 'mini-hint' }, element('span', {
    text: state.reorderActive && focused ? '調整位置' : '右鍵顯示更多'
  })))

  mini.addEventListener('click', () => {
    if (state.reorderActive) handleReorderClick(channel)
    else setFeatured(channel, true)
  })
  mini.addEventListener('contextmenu', event => {
    event.preventDefault()
    showMiniMenu(event.clientX, event.clientY, channel)
  })
  let pressTimer
  mini.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return
    pressTimer = setTimeout(() => showMiniMenu(event.clientX, event.clientY, channel), 600)
  })
  mini.addEventListener('pointerup', () => clearTimeout(pressTimer))
  mini.addEventListener('pointercancel', () => clearTimeout(pressTimer))
  return mini
}

function createHero(channel, geometry) {
  const hero = element('div', {
    className: `hero-channel${state.fullscreen ? ' is-fullscreen' : ''}`,
    style: state.fullscreen ? {} : {
      left: `${geometry.left}px`,
      top: `${geometry.top}px`,
      width: `${geometry.width}px`,
      height: `${geometry.height}px`
    }
  })
  const player = createPlayer(channel, false)
  player.video.volume = state.heroVolume
  player.video.muted = false
  if (state.paused) player.video.pause()
  else player.video.play().catch(() => {})
  player.video.className = 'hero-video'
  hero.append(player.video)
  state.heroPlayer = player

  hero.append(element('div', { className: 'hero-gradient' }))
  hero.append(element('div', { className: 'hero-brand' },
    element('div', { className: 'hero-brand-mark', text: 'O' }),
    element('div', {},
      element('div', { className: 'hero-brand-title', text: 'IPTV WALL' }),
      element('div', { className: 'hero-brand-subtitle', text: 'Multi-Stream Grid Player' })
    )
  ))
  state.heroInfo = element('div', { className: 'hero-info' },
    element('div', { className: `hero-live${state.paused ? ' paused' : ''}`, text: state.paused ? '⏸ 已暫停' : '● LIVE' }),
    element('div', { className: 'hero-country', text: `${flagForCountry(channel.country)} ${countryDisplayName(channel.country)}` }),
    element('div', { className: 'hero-name', text: channel.name })
  )
  hero.append(state.heroInfo)

  state.heroControls = element('div', { className: 'hero-controls' },
    element('button', { title: '我的最愛', onclick: event => { event.stopPropagation(); toggleHeroFavorite() }, text: state.favorites.has(channel.id) ? '★' : '☆' }),
    element('button', { title: state.paused ? '繼續播放' : '全部暫停', onclick: event => { event.stopPropagation(); toggleAllPlayback() }, text: state.paused ? '▶' : '⏸' }),
    element('button', { title: '從播放牆移除', onclick: event => { event.stopPropagation(); requestDelete(channel) }, text: '✕' })
  )
  hero.append(state.heroControls)

  hero.addEventListener('click', () => toggleFullscreen())
  hero.addEventListener('contextmenu', event => {
    event.preventDefault()
    showHeroMenu(event.clientX, event.clientY, channel)
  })
  hero.addEventListener('pointermove', showControls)
  hero.addEventListener('pointerdown', showControls)
  return hero
}

function layoutWall() {
  if (!state.surface) return
  state.surface.innerHTML = ''
  const width = state.surface.clientWidth
  const height = state.surface.clientHeight
  const count = state.mode === '5x5' ? 5 : 4
  const cellWidth = width / count
  const cellHeight = height / count
  const page = pageChannels()

  if (!state.fullscreen) {
    const cells = perimeterCells(count)
    page.forEach((channel, index) => {
      const cell = cells[index]
      if (cell) state.surface.append(createMiniChannel(channel, cell, cellWidth, cellHeight))
    })
  }

  const featured = page.find(channel => channel.id === state.featuredID) || state.channels[0]
  if (!featured) return
  state.featuredID = featured.id
  const geometry = centerGeometry(count, width, height)
  state.hero = createHero(featured, geometry)
  state.surface.append(state.hero)
  updateControlVisibility()
}

function renderPageControls() {
  if (!state.surface || pageCount() <= 1 || state.fullscreen) return
  state.pageControls = element('div', { className: 'page-controls' },
    element('button', { disabled: state.page <= 0, onclick: () => changePage(-1), text: '‹' }),
    element('span', { text: `${state.page + 1} / ${pageCount()}` }),
    element('button', { disabled: state.page >= pageCount() - 1, onclick: () => changePage(1), text: '›' })
  )
  state.surface.append(state.pageControls)
}

function renderReorderToolbar() {
  if (!state.reorderActive || !state.surface || state.fullscreen) return
  const count = state.mode === '5x5' ? 5 : 4
  const page = pageChannels()
  const cells = perimeterCells(count)
  const index = page.findIndex(channel => channel.id === state.reorderSelectedID)
  const bottom = index >= 0 && cells[index]?.row < count / 2
  const toolbar = element('div', {
    className: 'reorder-toolbar',
    style: bottom ? { bottom: '20px' } : { top: '20px' }
  },
    element('span', { text: '調整順序：點擊另一個頻道交換位置' }),
    element('button', { onclick: finishReorder, text: '完成' }),
    element('button', { onclick: cancelReorder, text: '取消' })
  )
  state.surface.append(toolbar)
}

async function render() {
  closeContextMenu()
  closeModal()
  await loadState()
  if (!state.channels.length) { renderEmpty(); return }

  app.innerHTML = ''
  const shell = element('div', { className: `app-shell${state.fullscreen ? ' is-fullscreen' : ''}` })
  state.toolbar = renderToolbar()
  shell.append(state.toolbar)
  state.surface = element('div', { className: 'wall-root' })
  shell.append(state.surface)
  app.append(shell)

  state.resizeObserver?.disconnect()
  state.resizeObserver = new ResizeObserver(() => layoutWall())
  state.resizeObserver.observe(state.surface)
  requestAnimationFrame(() => {
    layoutWall()
    renderPageControls()
    renderReorderToolbar()
    showControls()
  })
}

async function setFeatured(channel, animate) {
  if (!channel || state.featuredID === channel.id) return
  const oldPlayer = state.heroPlayer
  if (animate && oldPlayer) {
    await fadeVolume(oldPlayer.video, 0, 450)
    oldPlayer.video.muted = true
  }
  state.featuredID = channel.id
  localStorage.setItem('oc-featured', channel.id)
  layoutWall()
  const player = state.heroPlayer
  if (player) {
    player.video.muted = false
    if (animate) {
      player.video.volume = 0
      await fadeVolume(player.video, state.heroVolume, 650)
    } else player.video.volume = state.heroVolume
  }
  showControls()
}

function selectCategory(category) {
  state.category = category
  state.country = 'ALL'
  state.page = 0
  localStorage.setItem('oc-category', category)
  render()
}

function selectMode(mode) {
  state.mode = mode
  state.page = Math.min(state.page, pageCount() - 1)
  localStorage.setItem('oc-mode', mode)
  render()
}

function changePage(delta) {
  state.page = Math.max(0, Math.min(pageCount() - 1, state.page + delta))
  localStorage.setItem('oc-page', state.page)
  layoutWall()
  renderPageControls()
  renderReorderToolbar()
}

function toggleFullscreen() {
  if (state.fullscreen) {
    state.mode = state.modeBeforeFullscreen
    state.page = state.pageBeforeFullscreen
    state.fullscreen = false
  } else {
    state.modeBeforeFullscreen = state.mode
    state.pageBeforeFullscreen = state.page
    state.fullscreen = true
    localStorage.setItem('oc-mode-before-fullscreen', state.mode)
    localStorage.setItem('oc-page-before-fullscreen', state.page)
  }
  render()
}

async function toggleHeroFavorite() {
  if (!state.featuredID) return
  await toggleFavorite(state.featuredID)
  await render()
}

function toggleAllPlayback() {
  state.paused = !state.paused
  localStorage.setItem('oc-paused', String(state.paused))
  for (const player of playerPool.values()) {
    if (state.paused) player.video.pause()
    else player.video.play().catch(() => {})
  }
  layoutWall()
  renderPageControls()
  renderReorderToolbar()
}

function requestDelete(channel) {
  if (!window.confirm(`確定要將「${channel.name}」從播放牆隱藏嗎？`)) return
  deleteChannel(channel.id).then(render)
}

function beginReorder(channel) {
  state.reorderActive = true
  state.reorderSelectedID = channel.id
  state.reorderCategory = state.category
  state.reorderSnapshot = state.category === 'favorites'
    ? [...state.baseChannels.map(item => item.id)]
    : [...state.baseChannels.map(item => item.id)]
  showControls()
  layoutWall()
  renderPageControls()
  renderReorderToolbar()
}

async function handleReorderClick(channel) {
  if (!state.reorderSelectedID) {
    state.reorderSelectedID = channel.id
    layoutWall(); renderReorderToolbar(); return
  }
  if (state.reorderSelectedID === channel.id) {
    state.reorderSelectedID = null
    layoutWall(); renderReorderToolbar(); return
  }

  const ids = [...state.baseChannels.map(item => item.id)]
  const first = ids.indexOf(state.reorderSelectedID)
  const second = ids.indexOf(channel.id)
  if (first >= 0 && second >= 0) {
    ;[ids[first], ids[second]] = [ids[second], ids[first]]
    if (state.reorderCategory === 'favorites') await saveFavoriteOrder(ids)
    else await saveChannelOrder(ids)
  }
  state.reorderSelectedID = channel.id
  await loadState()
  layoutWall(); renderPageControls(); renderReorderToolbar()
}

async function finishReorder() {
  state.reorderActive = false
  state.reorderSelectedID = null
  state.reorderSnapshot = []
  await loadState()
  layoutWall(); renderPageControls()
}

async function cancelReorder() {
  if (state.reorderSnapshot.length) {
    if (state.reorderCategory === 'favorites') await saveFavoriteOrder(state.reorderSnapshot)
    else await saveChannelOrder(state.reorderSnapshot)
  }
  state.reorderActive = false
  state.reorderSelectedID = null
  state.reorderSnapshot = []
  await loadState()
  layoutWall(); renderPageControls()
}

function closeContextMenu() {
  state.contextMenu?.remove()
  state.contextMenu = null
}

function addMenuItem(menu, title, action, options = {}) {
  const item = element('button', { className: options.danger ? 'danger' : '', text: title })
  item.addEventListener('click', () => { closeContextMenu(); action() })
  menu.append(item)
}

function addSeparator(menu) { menu.append(element('div', { className: 'separator' })) }

function showMenu(x, y, builder) {
  closeContextMenu()
  const menu = element('div', { className: 'context-menu', style: {
    left: `${Math.min(x, window.innerWidth - 245)}px`,
    top: `${Math.min(y, window.innerHeight - 330)}px`
  } })
  builder(menu)
  document.body.append(menu)
  state.contextMenu = menu
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0)
}

function showMiniMenu(x, y, channel) {
  showMenu(x, y, menu => {
    if (state.reorderActive) {
      addMenuItem(menu, '完成調整順序', finishReorder)
      addMenuItem(menu, '取消調整', cancelReorder)
      return
    }
    addMenuItem(menu, `${state.favorites.has(channel.id) ? '★ 移除' : '☆ 加入'}我的最愛`, async () => { await toggleFavorite(channel.id); render() })
    addMenuItem(menu, 'ℹ 頻道資訊', () => showChannelInfo(channel))
    addMenuItem(menu, '↕ 調整頻道位置', () => beginReorder(channel))
    addSeparator(menu)
    addMenuItem(menu, '✕ 從播放牆移除', () => requestDelete(channel), { danger: true })
  })
}

function showHeroMenu(x, y, channel) {
  showMenu(x, y, menu => {
    addMenuItem(menu, `${state.favorites.has(channel.id) ? '★ 移除' : '☆ 加入'}我的最愛`, async () => { await toggleFavorite(channel.id); render() })
    addMenuItem(menu, 'ℹ 頻道資訊', () => showChannelInfo(channel))
    addSeparator(menu)
    addMenuItem(menu, state.paused ? '▶ 繼續播放' : '⏸ 全部暫停', toggleAllPlayback)
    addMenuItem(menu, `🔊 正常播放音量 · ${Math.round(state.heroVolume * 100)}%`, openVolumePanel)
    addSeparator(menu)
    if (pageCount() > 1) {
      addMenuItem(menu, '‹ 上一組', () => changePage(-1))
      addMenuItem(menu, '› 下一組', () => changePage(1))
    }
    addMenuItem(menu, `${state.category === 'all' ? '✓' : '□'} 全部頻道`, () => selectCategory('all'))
    addMenuItem(menu, `${state.category === 'favorites' ? '✓' : '□'} 我的最愛`, () => selectCategory('favorites'))
    addMenuItem(menu, `${state.mode === '4x4' ? '✓' : '□'} 4×4`, () => selectMode('4x4'))
    addMenuItem(menu, `${state.mode === '5x5' ? '✓' : '□'} 5×5`, () => selectMode('5x5'))
    addSeparator(menu)
    addMenuItem(menu, '▣ 頻道庫與來源', openPlaylistManager)
    addSeparator(menu)
    addMenuItem(menu, '✕ 從播放牆移除', () => requestDelete(channel), { danger: true })
  })
}

function openModal(content) {
  closeModal()
  const backdrop = element('div', { className: 'modal-backdrop' })
  backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal() })
  const panel = element('div', { className: 'modal-panel' })
  panel.append(element('button', { className: 'close', onclick: closeModal, text: '×' }), content)
  backdrop.append(panel)
  document.body.append(backdrop)
  state.modal = backdrop
}

function closeModal() {
  state.modal?.remove()
  state.modal = null
}

function showChannelInfo(channel) {
  openModal(element('div', {},
    element('h2', { text: '頻道資訊' }),
    element('div', { className: 'form-field' }, element('label', { text: '名稱' }), element('div', { text: `${flagForCountry(channel.country)} ${channel.name}` })),
    element('div', { className: 'form-field' }, element('label', { text: '國家' }), element('div', { text: countryDisplayName(channel.country) })),
    element('div', { className: 'form-field' }, element('label', { text: '串流網址' }), element('div', { style: { wordBreak: 'break-all', color: '#aaa', fontSize: '12px' }, text: channel.url })),
    element('div', { className: 'modal-actions' }, element('button', { onclick: closeModal, text: '關閉' }))
  ))
}

function openVolumePanel() {
  const value = element('input', { type: 'range', min: '0', max: '100', value: String(Math.round(state.heroVolume * 100)), style: { width: '100%' } })
  const label = element('div', { className: 'modal-message', text: `${Math.round(state.heroVolume * 100)}%` })
  value.addEventListener('input', () => {
    state.heroVolume = Number(value.value) / 100
    label.textContent = `${value.value}%`
    localStorage.setItem('oc-hero-volume', state.heroVolume)
    if (state.heroPlayer) state.heroPlayer.video.volume = state.heroVolume
  })
  openModal(element('div', {}, element('h2', { text: '正常播放音量' }), value, label, element('div', { className: 'modal-actions' }, element('button', { onclick: closeModal, text: '完成' }))))
}

async function openCatalog() {
  const search = element('input', { type: 'search', placeholder: '搜尋頻道名稱' })
  const country = element('select')
  country.append(element('option', { value: '', text: '所有國家' }))
  const list = element('div', { className: 'catalog-list' }, element('div', { className: 'loading' }, element('div', { className: 'spinner' }), '正在載入 iptv-org 頻道…'))
  openModal(element('div', {}, element('h2', { text: '探索公開頻道' }), element('div', { className: 'catalog-filters' }, search, country), list))

  let channels
  try { channels = await loadCatalog() }
  catch (error) { list.innerHTML = ''; list.append(element('div', { className: 'loading', text: `載入失敗：${error.message}` })); return }
  for (const code of [...new Set(channels.map(channel => channel.country))].sort()) country.append(element('option', { value: code, text: `${flagForCountry(code)} ${code}` }))

  const renderList = () => {
    const query = search.value.toLowerCase()
    const visible = channels.filter(channel => (!query || channel.name.toLowerCase().includes(query)) && (!country.value || channel.country === country.value)).slice(0, 200)
    list.innerHTML = ''
    if (!visible.length) { list.append(element('div', { className: 'loading', text: '沒有符合的頻道' })); return }
    for (const channel of visible) {
      const row = element('div', { className: 'catalog-row' },
        element('div', { className: 'catalog-flag', text: flagForCountry(channel.country) }),
        element('div', { className: 'catalog-details' },
          element('div', { className: 'catalog-name', text: channel.name }),
          element('div', { className: 'catalog-meta', text: `${channel.country} · ${(channel.categories || []).slice(0, 2).join(' · ')} ${channel.quality || ''}` })
        ),
        element('button', { className: 'catalog-add', text: '+' })
      )
      row.addEventListener('click', () => addCatalogChannel(channel))
      row.querySelector('.catalog-add').addEventListener('click', event => { event.stopPropagation(); addCatalogChannel(channel) })
      list.append(row)
    }
  }
  search.addEventListener('input', renderList)
  country.addEventListener('change', renderList)
  renderList()
}

async function addCatalogChannel(channel) {
  if (isBlockedChannel(channel)) {
    toast('此頻道已從播放牆排除')
    return
  }
  const entry = `#EXTINF:-1 tvg-id="${channel.id}" tvg-country="${channel.country}" group-title="IPTV.org",${channel.name}\n${channel.streamURL}`
  const playlists = await getPlaylists()
  const existing = playlists.find(playlist => playlist.id === 'catalog-import')
  if (existing) {
    existing.content += `\n${entry}`
    existing.channelCount += 1
    existing.importedAt = new Date().toISOString()
    await savePlaylist(existing)
  } else {
    await savePlaylist({ id: 'catalog-import', name: 'IPTV.org 頻道', sourceURL: 'catalog://local', content: entry, channelCount: 1, importedAt: new Date().toISOString() })
  }
  toast(`已加入「${channel.name}」`)
  await render()
}

function openImport() {
  const input = element('input', { type: 'url', placeholder: 'https://example.com/playlist.m3u' })
  const message = element('div', { className: 'modal-message' })
  openModal(element('div', {},
    element('h2', { text: '匯入 M3U 網址' }),
    element('div', { className: 'form-field' }, element('label', { text: 'M3U 播放清單網址' }), input),
    message,
    element('div', { className: 'modal-actions' },
      element('button', { onclick: closeModal, text: '取消' }),
      element('button', { className: 'primary', onclick: async () => {
        if (!input.value.trim()) { message.textContent = '請輸入網址。'; return }
        message.textContent = '正在下載與解析…'
        try {
          const playlist = await importM3U(input.value.trim())
          message.textContent = `已匯入 ${playlist.channelCount} 個頻道。`
          setTimeout(() => { closeModal(); render() }, 500)
        } catch (error) { message.textContent = error.message }
      }, text: '匯入' })
    )
  ))
  input.focus()
}

async function openPlaylistManager() {
  const list = element('div', { className: 'catalog-list' })
  const playlists = await getPlaylists()
  if (!playlists.length) list.append(element('div', { className: 'loading', text: '尚無播放清單' }))
  for (const playlist of playlists) {
    const row = element('div', { className: 'playlist-row' },
      element('div', { className: 'playlist-info' },
        element('div', { className: 'playlist-name', text: playlist.name }),
        element('div', { className: 'playlist-meta', text: `${playlist.channelCount} 個頻道 · ${playlist.sourceURL}` })
      ),
      element('button', { className: 'catalog-add', text: '×' })
    )
    row.querySelector('button').addEventListener('click', async () => { await removePlaylist(playlist.id); closeModal(); render() })
    list.append(row)
  }
  openModal(element('div', {},
    element('h2', { text: '頻道庫與來源' }),
    list,
    element('div', { className: 'modal-actions' },
      element('button', { className: 'primary', onclick: () => { closeModal(); openImport() }, text: '+ 匯入新清單' }),
      element('button', { onclick: closeModal, text: '關閉' })
    )
  ))
}

function installGlobalActivityHandlers() {
  for (const event of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) document.addEventListener(event, showControls, { passive: true })
  document.addEventListener('keydown', event => {
    if (event.target.matches('input, select')) return
    if (event.key === 'ArrowLeft') changePage(-1)
    if (event.key === 'ArrowRight') changePage(1)
    if (event.key === 'f' || event.key === 'F') toggleFullscreen()
    if (event.key === ' ') { event.preventDefault(); toggleAllPlayback() }
    if (event.key === 'Escape') {
      if (state.fullscreen) toggleFullscreen()
      closeContextMenu(); closeModal()
    }
  })
  let touchStartX = 0
  document.addEventListener('touchstart', event => { touchStartX = event.touches[0].clientX }, { passive: true })
  document.addEventListener('touchend', event => {
    const distance = event.changedTouches[0].clientX - touchStartX
    if (Math.abs(distance) > 60) changePage(distance > 0 ? -1 : 1)
  }, { passive: true })
}

async function main() {
  await initDB()
  installGlobalActivityHandlers()
  await render()
}

main().catch(error => {
  app.textContent = `OpenCast Grid 啟動失敗：${error.message}`
  console.error(error)
})
