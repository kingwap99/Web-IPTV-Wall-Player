import {
  initDB,
  initSharedStore,
  getFilteredChannels,
  getPlaylists,
  getChannelOrder,
  saveChannelOrder,
  savePlaylist,
  removePlaylist,
  importM3U,
  deleteChannel,
  countryDisplayName,
  flagForCountry,
  parseM3U,
  getFavoriteGroups,
  getFavoriteGroupIDs,
  getFavoriteCounts,
  getActiveFavoriteGroupID,
  setActiveFavoriteGroupID,
  saveFavoriteGroupOrder,
  toggleFavoriteInGroup,
  createFavoriteGroup,
  renameFavoriteGroup,
  deleteFavoriteGroup,
  favoriteGroupID,
  getWallModes,
  setWallMode
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
  modes: {},
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
  libraryCount: 0,
  favorites: new Set(),
  favoriteGroups: [],
  activeGroupID: null,
  groupFavoriteSets: new Map(),
  reorderActive: false,
  reorderSelectedID: null,
  reorderSnapshot: [],
  reorderCategory: 'all',
  dragChannelID: null,
  dragTargetEl: null,
  dragEndedAt: 0,
  heroPlayer: null,
  heroSoundBlocked: false,
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
  const player = { key, channelID: channel.id, url: channel.url, video, hls: null, started: false }

  // 媒體已經可以播、卻仍是暫停狀態時再試一次：涵蓋「一開始來源還沒準備好」與
  // 「有聲音的自動播放被瀏覽器擋下」兩種情況。
  video.addEventListener('canplay', () => {
    if (state.paused || !video.paused) return
    if (playerPool.get(key)?.video !== video) return
    requestPlay(player)
  })

  if (window.Hls?.isSupported()) {
    const hls = new window.Hls({
      enableWorker: false,
      lowLatencyMode: true,
      backBufferLength: 30,
      maxBufferLength: 30
    })
    hls.loadSource(channel.url)
    hls.attachMedia(video)
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => requestPlay(player))
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      else destroyPlayer(key)
    })
    player.hls = hls
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = channel.url
    video.addEventListener('loadedmetadata', () => requestPlay(player), { once: true })
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

function modeCount() { return { '4x4': 4, '5x5': 5, '6x6': 6, '7x7': 7 }[state.mode] || 4 }

// 目前作用中的最愛清單：正在瀏覽的清單，否則為上次使用的清單。
function currentFavoriteGroupID() {
  return favoriteGroupID(state.category) || state.activeGroupID || state.favoriteGroups[0]?.id || null
}

function currentFavoriteGroup() {
  const id = currentFavoriteGroupID()
  return state.favoriteGroups.find(group => group.id === id) || null
}

function visiblePageSize() { return 4 * modeCount() - 4 }
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
  const span = count - 2
  return {
    left: (width - cellWidth * span) / 2,
    top: (height - cellHeight * span) / 2,
    width: cellWidth * span,
    height: cellHeight * span
  }
}

async function loadState() {
  state.favoriteGroups = await getFavoriteGroups()
  state.activeGroupID = await getActiveFavoriteGroupID()
  const browsing = favoriteGroupID(state.category)
  if (browsing && !state.favoriteGroups.some(group => group.id === browsing)) {
    state.category = 'all'
    localStorage.setItem('oc-category', state.category)
  }
  const result = await getFilteredChannels(state.category)
  state.baseChannels = result.channels
  state.libraryCount = result.total ?? result.channels.length
  state.groupFavoriteSets = new Map()
  for (const group of state.favoriteGroups) {
    state.groupFavoriteSets.set(group.id, new Set(await getFavoriteGroupIDs(group.id)))
  }
  state.favorites = state.groupFavoriteSets.get(currentFavoriteGroupID()) || new Set()
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
      element('h1', { text: '建立你的第一面 IPTV Wall Player' }),
      element('p', { text: '一個畫面，同時看見世界。選擇一種方式加入你的頻道；Web IPTV Wall player 不內建或代管影音內容。' }),
      element('div', { className: 'empty-actions' },
        element('button', { className: 'primary', onclick: () => openCatalog(), text: '探索公開頻道' }),
        element('button', { onclick: openImport, text: '匯入 M3U 網址' })
      )
    )
  )
  shell.append(empty)
  app.append(shell)
}

// 目前清單沒有頻道時，仍保留工具列，讓使用者能切換清單或國家。
function renderWallEmpty() {
  const group = currentFavoriteGroup()
  const filtered = state.country !== 'ALL'
  const title = filtered
    ? `沒有符合「${countryDisplayName(state.country)}」的頻道`
    : group ? `「${group.name}」還沒有頻道` : '這個畫面還沒有頻道'
  const hint = filtered
    ? '用上方國家選單切回「所有國家」，或切換到其他清單。'
    : '在任一頻道上按右鍵（手機為長按），於「我的最愛清單」中即可把頻道加入這份清單。'
  const others = state.favoriteGroups.filter(item => item.id !== currentFavoriteGroupID())
  return element('div', { className: 'wall-empty' },
    element('div', { className: 'wall-empty-mark', text: group ? '★' : '＋' }),
    element('h2', { text: title }),
    element('p', { text: hint }),
    element('div', { className: 'wall-empty-actions' },
      element('button', { onclick: () => selectCategory('all'), text: '全部頻道' }),
      ...others.map(item => element('button', {
        onclick: () => selectCategory(`fav:${item.id}`),
        text: `★ ${item.name}`
      })),
      element('button', { onclick: promptNewFavoriteGroup, text: '＋ 新增最愛清單' })
    )
  )
}

function renderToolbar() {
  const countryCounts = new Map()
  for (const channel of state.baseChannels) countryCounts.set(channel.country, (countryCounts.get(channel.country) || 0) + 1)
  const countries = [...countryCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))

  state.toolbar = element('div', { className: 'app-toolbar' },
    element('div', { className: 'brand' }, element('img', { className: 'brand-logo', src: 'assets/icon-192.png', alt: '' }), 'IPTV Wall Player'),
    element('button', { className: state.category === 'all' ? 'active' : '', onclick: () => selectCategory('all'), text: '全部頻道' }),
    ...state.favoriteGroups.map(group => {
      const value = `fav:${group.id}`
      const button = element('button', {
        className: `toolbar-favorite${state.category === value ? ' active' : ''}`,
        title: `${group.name} · 右鍵可重新命名或刪除`,
        onclick: () => selectCategory(value),
        text: `★ ${group.name}`
      })
      button.addEventListener('contextmenu', event => {
        event.preventDefault()
        showFavoriteGroupMenu(event.clientX, event.clientY, group)
      })
      return button
    }),
    element('button', { className: 'toolbar-add-favorite', title: '新增最愛清單', onclick: promptNewFavoriteGroup, text: '＋' }),
    element('select', { onchange: event => { state.country = event.target.value; state.page = 0; render() } },
      element('option', { value: 'ALL', selected: state.country === 'ALL', text: '所有國家' }),
      ...countries.map(([country, count]) => element('option', {
        value: country, selected: state.country === country, text: `${flagForCountry(country)} ${country} (${count})`
      }))
    ),
    element('div', { className: 'toolbar-group' },
      ...['4x4', '5x5', '6x6', '7x7'].map(mode => element('button', {
        className: state.mode === mode ? 'active' : '',
        onclick: () => selectMode(mode),
        text: mode.replace('x', '×')
      })),
      element('button', { onclick: toggleFullscreen, text: '⛶' })
    ),
    element('button', { onclick: () => openCatalog(), text: '頻道探索' }),
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
    const markPlaying = () => {
      player.started = true
      player.video.classList.add('is-playing')
      placeholder.style.display = 'none'
    }
    if (player.started || player.video.readyState >= 2) markPlaying()
    else player.video.addEventListener('playing', markPlaying, { once: true })
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

  mini.dataset.channelId = channel.id
  mini.addEventListener('click', () => {
    if (justDragged()) return
    if (state.reorderActive) handleReorderClick(channel)
    else setFeatured(channel, true)
  })
  mini.addEventListener('contextmenu', event => {
    event.preventDefault()
    showMiniMenu(event.clientX, event.clientY, channel)
  })
  attachDragHandlers(mini, channel, true)
  return mini
}

// 瀏覽器會擋「有聲音的自動播放」。小頻道是靜音的，所以能自動播；主頻道有聲音，
// 一旦被擋住畫面就停在原地，看起來像卡住（介面卻仍顯示 LIVE），要手動暫停再播才會動。
// 被擋時改成先靜音播起來（畫面不卡），等使用者第一次互動再把聲音打開。
function requestPlay(player) {
  const video = player.video
  return video.play().catch(error => {
    // 來源還沒準備好之類的錯誤先略過，canplay／MANIFEST_PARSED 之後會再試一次。
    if (!error || error.name !== 'NotAllowedError' || video.muted) return
    video.muted = true
    const firstTime = !state.heroSoundBlocked
    state.heroSoundBlocked = true
    if (firstTime) toast('瀏覽器擋下了自動播放，已先用靜音播放；點一下畫面即可開啟聲音。', 4200)
    video.play().catch(() => {})
  })
}

// 使用者第一次互動時，把主頻道的聲音打開。
function installHeroSoundUnlock() {
  const unlock = () => {
    if (!state.heroSoundBlocked) return
    state.heroSoundBlocked = false
    const player = state.heroPlayer
    if (!player) return
    player.video.muted = false
    player.video.volume = state.heroVolume
    player.video.play().catch(() => {})
    toast('已開啟主頻道聲音。')
  }
  for (const event of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(event, unlock, { passive: true })
  }
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
  else requestPlay(player)
  player.video.className = 'hero-video'
  hero.append(player.video)
  state.heroPlayer = player

  hero.append(element('div', { className: 'hero-gradient' }))
  hero.append(element('div', { className: 'hero-brand' },
    element('img', { className: 'hero-brand-logo', src: 'assets/icon-192.png', alt: '' }),
    element('div', {},
      element('div', { className: 'hero-brand-title', text: 'IPTV Wall Player' }),
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
    element('button', {
      title: `我的最愛${currentFavoriteGroup() ? ` · ${currentFavoriteGroup().name}` : ''}`,
      onclick: event => { event.stopPropagation(); toggleHeroFavorite() },
      text: state.favorites.has(channel.id) ? '★' : '☆'
    }),
    element('button', { title: state.paused ? '繼續播放' : '全部暫停', onclick: event => { event.stopPropagation(); toggleAllPlayback() }, text: state.paused ? '▶' : '⏸' }),
    element('button', { title: '從播放牆移除', onclick: event => { event.stopPropagation(); requestDelete(channel) }, text: '✕' })
  )
  hero.append(state.heroControls)

  hero.dataset.channelId = channel.id
  // 排序進行中，中央大頻道和小頻道一樣是交換的目標，不是進全螢幕的開關。
  hero.addEventListener('click', () => {
    if (justDragged()) return
    if (state.reorderActive) handleReorderClick(channel)
    else toggleFullscreen()
  })
  hero.addEventListener('contextmenu', event => {
    event.preventDefault()
    showHeroMenu(event.clientX, event.clientY, channel)
  })
  hero.addEventListener('pointermove', showControls)
  hero.addEventListener('pointerdown', showControls)
  attachDragHandlers(hero, channel, false)
  return hero
}

function layoutWall() {
  if (!state.surface) return
  state.surface.innerHTML = ''
  const page = pageChannels()
  if (!page.length) {
    state.surface.append(renderWallEmpty())
    return
  }
  const width = state.surface.clientWidth
  const height = state.surface.clientHeight
  const count = modeCount()
  const cellWidth = width / count
  const cellHeight = height / count

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
  renderPageControls()
  renderReorderToolbar()
  updateControlVisibility()
}

function renderPageControls() {
  state.pageControls?.remove()
  state.pageControls = null
  if (!state.surface || pageCount() <= 1 || state.fullscreen) return
  state.pageControls = element('div', { className: 'page-controls' },
    element('button', { disabled: state.page <= 0, onclick: () => changePage(-1), text: '‹' }),
    element('span', { text: `${state.page + 1} / ${pageCount()}` }),
    element('button', { disabled: state.page >= pageCount() - 1, onclick: () => changePage(1), text: '›' })
  )
  state.surface.append(state.pageControls)
}

function renderReorderToolbar() {
  state.reorderToolbar?.remove()
  state.reorderToolbar = null
  if (!state.reorderActive || !state.surface || state.fullscreen) return
  const count = modeCount()
  const page = pageChannels()
  const cells = perimeterCells(count)
  const index = page.findIndex(channel => channel.id === state.reorderSelectedID)
  const bottom = index >= 0 && cells[index]?.row < count / 2
  const toolbar = element('div', {
    className: 'reorder-toolbar',
    style: bottom ? { bottom: '20px' } : { top: '20px' }
  },
    element('span', { text: '調整順序：拖曳頻道到另一台上，或點擊另一台交換位置' }),
    element('button', { onclick: finishReorder, text: '完成' }),
    element('button', { onclick: cancelReorder, text: '取消' })
  )
  state.reorderToolbar = toolbar
  state.surface.append(toolbar)
}

async function render() {
  closeContextMenu()
  closeModal()
  await loadState()
  if (!state.libraryCount) { renderEmpty(); return }

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
  const savedMode = state.modes[category]
  if (savedMode && savedMode !== state.mode) {
    state.mode = savedMode
    localStorage.setItem('oc-mode', savedMode)
  }
  const groupID = favoriteGroupID(category)
  if (groupID) {
    state.activeGroupID = groupID
    setActiveFavoriteGroupID(groupID)
  }
  render()
}

function selectMode(mode) {
  state.mode = mode
  state.page = Math.min(state.page, pageCount() - 1)
  localStorage.setItem('oc-mode', mode)
  // 版面跟著目前所在的清單存，切換清單時各自還原。
  state.modes[state.category] = mode
  setWallMode(state.category, mode)
  render()
}

function changePage(delta) {
  state.page = Math.max(0, Math.min(pageCount() - 1, state.page + delta))
  localStorage.setItem('oc-page', state.page)
  layoutWall()
}

function toggleFullscreen() {
  // 排序進行中不進全螢幕：全螢幕只留中央大頻道，小頻道與排序工具列都會消失，
  // 使用者會卡在沒有「完成／取消」可按的狀態。
  if (state.reorderActive) {
    toast('請先按「完成」或「取消」結束頻道排序。')
    return
  }
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
  const groupID = currentFavoriteGroupID()
  if (!groupID) return
  await toggleFavoriteInGroup(groupID, state.featuredID)
  state.activeGroupID = groupID
  await setActiveFavoriteGroupID(groupID)
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
}

function requestDelete(channel) {
  if (!window.confirm(`確定要將「${channel.name}」從播放牆隱藏嗎？`)) return
  deleteChannel(channel.id).then(render)
}

function beginReorder(channel) {
  state.reorderActive = true
  state.reorderSelectedID = channel.id
  state.reorderCategory = state.category
  state.reorderSnapshot = [...state.baseChannels.map(item => item.id)]
  showControls()
  layoutWall()
}

// ---- 拖曳頻道 ----
// 用 pointer 事件而不是 HTML5 drag & drop：HTML5 DnD 在觸控裝置上完全不能用。
const DRAG_THRESHOLD = 8

// 剛拖曳完放開時，瀏覽器還會補一個 click；那個 click 要忽略，否則會多觸發一次點擊行為。
function justDragged() { return performance.now() - (state.dragEndedAt || 0) < 300 }

// 指標底下是哪一塊頻道磚（小頻道或中央大頻道）。
function channelTileAt(x, y) {
  return document.elementFromPoint(x, y)?.closest?.('.mini-channel, .hero-channel') || null
}

function attachDragHandlers(el, channel, withLongPress) {
  let pressTimer = null
  let pointerID = null
  let startX = 0
  let startY = 0
  let dragging = false

  const stopLongPress = () => { clearTimeout(pressTimer); pressTimer = null }
  const clearTarget = () => {
    state.dragTargetEl?.classList.remove('is-drop-target')
    state.dragTargetEl = null
  }
  const endDrag = () => {
    el.classList.remove('is-dragging')
    clearTarget()
    state.dragChannelID = null
    state.dragEndedAt = performance.now()
    dragging = false
    pointerID = null
  }

  el.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerID = event.pointerId
    startX = event.clientX
    startY = event.clientY
    dragging = false
    if (withLongPress && event.pointerType !== 'mouse') {
      stopLongPress()
      pressTimer = setTimeout(() => {
        pressTimer = null
        showMiniMenu(event.clientX, event.clientY, channel)
      }, 600)
    }
  })

  el.addEventListener('pointermove', event => {
    if (pointerID === null || event.pointerId !== pointerID) return
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return
      dragging = true
      stopLongPress() // 開始拖曳就不該再彈出長按選單
      state.dragChannelID = channel.id
      el.classList.add('is-dragging')
      try { el.setPointerCapture(pointerID) } catch { /* 部分瀏覽器不支援，不影響拖曳判定 */ }
    }
    const target = channelTileAt(event.clientX, event.clientY)
    if (target === state.dragTargetEl) return
    clearTarget()
    if (target && target !== el) {
      state.dragTargetEl = target
      target.classList.add('is-drop-target')
    }
  })

  el.addEventListener('pointerup', async () => {
    stopLongPress()
    if (!dragging) { pointerID = null; return }
    const targetID = state.dragTargetEl?.dataset?.channelId || null
    endDrag()
    if (!targetID || targetID === channel.id) return
    const targetChannel = state.baseChannels.find(item => item.id === targetID)
    if (targetChannel) await dropChannel(channel, targetChannel)
  })

  el.addEventListener('pointercancel', () => {
    stopLongPress()
    if (dragging) endDrag()
    else pointerID = null
  })
}

// 拖曳本身就是一次排序，所以順手記下原始順序並開啟排序模式，
// 讓工具列的「取消」可以把這次拖曳還原回去。
async function dropChannel(sourceChannel, targetChannel) {
  const wasActive = state.reorderActive
  const previousSnapshot = state.reorderSnapshot
  const previousCategory = state.reorderCategory
  state.reorderCategory = wasActive ? previousCategory : state.category
  state.reorderSnapshot = wasActive ? previousSnapshot : [...state.baseChannels.map(item => item.id)]

  const swapped = await swapChannels(sourceChannel.id, targetChannel)
  if (!swapped) {
    state.reorderActive = wasActive
    state.reorderSnapshot = previousSnapshot
    state.reorderCategory = previousCategory
    return
  }

  state.reorderActive = true
  state.reorderSelectedID = targetChannel.id
  await loadState()
  layoutWall()
  toast('已把「' + sourceChannel.name + '」移到「' + targetChannel.name + '」的位置。按「取消」可還原。', 3200)
}

// 依目前清單的順序交換兩台頻道並存回；回傳是否真的換了。
async function swapChannels(firstID, targetChannel) {
  const ids = [...state.baseChannels.map(item => item.id)]
  const first = ids.indexOf(firstID)
  const second = ids.indexOf(targetChannel.id)
  if (first < 0 || second < 0 || first === second) return false
  ;[ids[first], ids[second]] = [ids[second], ids[first]]
  const groupID = favoriteGroupID(state.reorderCategory)
  if (groupID) await saveFavoriteGroupOrder(groupID, ids)
  else await saveChannelOrder(ids)
  return true
}

async function handleReorderClick(channel) {
  if (!state.reorderSelectedID) {
    state.reorderSelectedID = channel.id
    layoutWall(); return
  }
  if (state.reorderSelectedID === channel.id) {
    state.reorderSelectedID = null
    layoutWall(); return
  }

  await swapChannels(state.reorderSelectedID, channel)
  state.reorderSelectedID = channel.id
  await loadState()
  layoutWall()
}

async function finishReorder() {
  state.reorderActive = false
  state.reorderSelectedID = null
  state.reorderSnapshot = []
  await loadState()
  layoutWall()
}

async function cancelReorder() {
  if (state.reorderSnapshot.length) {
    const groupID = favoriteGroupID(state.reorderCategory)
    if (groupID) await saveFavoriteGroupOrder(groupID, state.reorderSnapshot)
    else await saveChannelOrder(state.reorderSnapshot)
  }
  state.reorderActive = false
  state.reorderSelectedID = null
  state.reorderSnapshot = []
  await loadState()
  layoutWall()
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
    addFavoriteMenuItems(menu, channel)
    addMenuItem(menu, 'ℹ 頻道資訊', () => showChannelInfo(channel))
    addMenuItem(menu, '↕ 調整頻道位置', () => beginReorder(channel))
    addSeparator(menu)
    addMenuItem(menu, '✕ 從播放牆移除', () => requestDelete(channel), { danger: true })
  })
}

function showHeroMenu(x, y, channel) {
  showMenu(x, y, menu => {
    if (state.reorderActive) {
      addMenuItem(menu, '完成調整順序', finishReorder)
      addMenuItem(menu, '取消調整', cancelReorder)
      return
    }
    addFavoriteMenuItems(menu, channel)
    addMenuItem(menu, 'ℹ 頻道資訊', () => showChannelInfo(channel))
    addMenuItem(menu, '↕ 調整頻道位置', () => beginReorder(channel))
    addSeparator(menu)
    addMenuItem(menu, state.paused ? '▶ 繼續播放' : '⏸ 全部暫停', toggleAllPlayback)
    addMenuItem(menu, `🔊 正常播放音量 · ${Math.round(state.heroVolume * 100)}%`, openVolumePanel)
    addSeparator(menu)
    if (pageCount() > 1) {
      addMenuItem(menu, '‹ 上一組', () => changePage(-1))
      addMenuItem(menu, '› 下一組', () => changePage(1))
    }
    addMenuItem(menu, `${state.category === 'all' ? '✓' : '□'} 全部頻道`, () => selectCategory('all'))
    for (const group of state.favoriteGroups) {
      const value = `fav:${group.id}`
      addMenuItem(menu, `${state.category === value ? '✓' : '□'} ★ ${group.name}`, () => selectCategory(value))
    }
    for (const mode of ['4x4', '5x5', '6x6', '7x7']) {
      addMenuItem(menu, `${state.mode === mode ? '✓' : '□'} ${mode.replace('x', '×')}`, () => selectMode(mode))
    }
    addSeparator(menu)
    addMenuItem(menu, '▣ 頻道庫與來源', openPlaylistManager)
    addSeparator(menu)
    addMenuItem(menu, '✕ 從播放牆移除', () => requestDelete(channel), { danger: true })
  })
}

// 在右鍵選單列出所有最愛清單，勾選可切換該頻道是否屬於清單。
function addFavoriteMenuItems(menu, channel) {
  menu.append(element('div', { className: 'context-menu-label', text: '我的最愛清單' }))
  for (const group of state.favoriteGroups) {
    const member = state.groupFavoriteSets.get(group.id)?.has(channel.id)
    addMenuItem(menu, `${member ? '★ 從' : '☆ 加入'}「${group.name}」`, async () => {
      await toggleFavoriteInGroup(group.id, channel.id)
      state.activeGroupID = group.id
      await setActiveFavoriteGroupID(group.id)
      await render()
    })
  }
  addMenuItem(menu, '＋ 新增最愛清單…', promptNewFavoriteGroup)
  addSeparator(menu)
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

async function openCatalog(force = false) {
  const selectedIDs = new Set()
  const search = element('input', { type: 'search', placeholder: '搜尋頻道名稱，例如 BBC、NHK' })
  const country = element('select')
  const language = element('select')
  const category = element('select')
  const quality = element('select')
  const message = element('div', { className: 'modal-message' })
  const addButton = element('button', { className: 'primary', disabled: true, text: '加入 0 個頻道' })
  const refreshButton = element('button', { text: '重新整理' })
  const list = element('div', { className: 'catalog-list' }, element('div', { className: 'loading' }, element('div', { className: 'spinner' }), '正在載入 iptv-org 頻道…'))
  const filters = element('div', { className: 'catalog-filters' },
    element('label', { className: 'catalog-filter' }, element('span', { text: '國家' }), country),
    element('label', { className: 'catalog-filter' }, element('span', { text: '語言' }), language),
    element('label', { className: 'catalog-filter' }, element('span', { text: '主題' }), category),
    element('label', { className: 'catalog-filter' }, element('span', { text: '解析度' }), quality)
  )
  openModal(element('div', {},
    element('h2', { text: '探索 iptv-org 頻道' }),
    element('p', { className: 'modal-note', text: '依國家、語言、主題或名稱篩選；選取後加入頻道庫。' }),
    element('p', { className: 'modal-note subtle', text: 'iptv-org 是獨立的第三方社群頻道索引。Web IPTV Wall player 不代管、下載或儲存影音內容。' }),
    element('div', { className: 'catalog-search' }, search),
    filters,
    list,
    message,
    element('div', { className: 'modal-actions' }, refreshButton, element('button', { onclick: closeModal, text: '關閉' }), addButton)
  ))
  for (const value of ['1080', '720', '576', '480', '270', '0']) {
    quality.append(element('option', { value, text: value === '0' ? '所有解析度' : `${value}p 以上` }))
  }

  let channels = []
  const addedIDs = new Set()

  const load = async (reload = false) => {
    list.innerHTML = ''
    list.append(element('div', { className: 'loading' }, element('div', { className: 'spinner' }), '正在載入 iptv-org 頻道…'))
    message.textContent = ''
    try { channels = await loadCatalog(reload) }
    catch (error) { list.innerHTML = ''; list.append(element('div', { className: 'loading', text: `載入失敗：${error.message}` })); return }
    addedIDs.clear()
    const playlist = (await getPlaylists()).find(item => item.id === 'catalog-import')
    for (const match of (playlist?.content || '').matchAll(/tvg-id="([^"]+)"/g)) addedIDs.add(match[1])
    const countries = [...new Set(channels.map(channel => channel.country))].sort()
    country.innerHTML = ''
    country.append(element('option', { value: 'ALL', text: '所有國家' }))
    for (const code of countries) country.append(element('option', { value: code, text: `${flagForCountry(code)} ${countryDisplayName(code)}` }))
    const categories = [...new Set(channels.flatMap(channel => channel.categories || []))].sort()
    category.innerHTML = ''
    category.append(element('option', { value: 'ALL', text: '所有主題' }))
    for (const id of categories) category.append(element('option', { value: id, text: `${categoryLabel(id)} · ${channels.filter(channel => (channel.categories || []).includes(id)).length}` }))
    const languages = [...new Set(channels.flatMap(channel => channel.languages || []))].sort()
    language.innerHTML = ''
    language.append(element('option', { value: 'ALL', text: '所有語言' }))
    for (const code of languages) language.append(element('option', { value: code, text: `${languageLabel(code)} · ${channels.filter(channel => (channel.languages || []).includes(code)).length}` }))
    for (const channel of channels) addedIDs.has(channel.id) && selectedIDs.delete(channel.id)
    renderList()
  }

  const updateAddButton = () => {
    addButton.textContent = `加入 ${selectedIDs.size} 個頻道`
    addButton.disabled = selectedIDs.size === 0
  }

  const renderList = () => {
    const query = search.value.trim().toLowerCase()
    const minimum = Number(quality.value) || 0
    const matched = channels.filter(channel => {
      const matchesSearch = !query || channel.name.toLowerCase().includes(query) || channel.id.toLowerCase().includes(query)
      const matchesCountry = country.value === 'ALL' || !country.value || channel.country === country.value
      const matchesLanguage = language.value === 'ALL' || !language.value || (channel.languages || []).includes(language.value)
      const matchesCategory = category.value === 'ALL' || !category.value || (channel.categories || []).includes(category.value)
      const matchesQuality = minimum <= 0 || qualityScore(channel) >= minimum
      return matchesSearch && matchesCountry && matchesLanguage && matchesCategory && matchesQuality
    })
    const visible = matched.slice(0, 250)
    list.innerHTML = ''
    message.textContent = `找到 ${matched.length} 台可直接播放的 HLS 頻道${matched.length > 250 ? '，以下顯示前 250 台' : ''}`
    if (!visible.length) { list.append(element('div', { className: 'loading', text: '沒有符合的頻道' })); updateAddButton(); return }
    for (const channel of visible) {
      const added = addedIDs.has(channel.id)
      const selected = selectedIDs.has(channel.id)
      const state = element('div', {
        className: `catalog-state${added ? ' is-added' : selected ? ' is-selected' : ''}`,
        text: added ? '✓ 已加入' : selected ? '✓ 已選取' : '+'
      })
      const row = element('div', { className: `catalog-row${added ? ' is-added' : ''}` },
        element('div', { className: 'catalog-flag', text: flagForCountry(channel.country) }),
        element('div', { className: 'catalog-details' },
          element('div', { className: 'catalog-name', text: channel.name }),
          element('div', { className: 'catalog-meta', text: `${countryDisplayName(channel.country)} · ${(channel.categories || []).map(categoryLabel).slice(0, 2).join(' · ')} ${channel.quality || ''}` })
        ),
        state
      )
      if (!added) row.addEventListener('click', () => {
        if (selectedIDs.has(channel.id)) selectedIDs.delete(channel.id)
        else selectedIDs.add(channel.id)
        renderList()
      })
      list.append(row)
    }
    updateAddButton()
  }

  search.addEventListener('input', renderList)
  country.addEventListener('change', renderList)
  language.addEventListener('change', renderList)
  category.addEventListener('change', renderList)
  quality.addEventListener('change', renderList)
  refreshButton.addEventListener('click', () => load(true))
  addButton.addEventListener('click', async () => {
    const chosen = channels.filter(channel => selectedIDs.has(channel.id) && !addedIDs.has(channel.id))
    if (!chosen.length) return
    addButton.disabled = true
    const count = await addCatalogChannels(chosen)
    toast(count ? `已加入 ${count} 個頻道` : '這些頻道已在播放牆中')
    closeModal()
    await render()
  })

  await load(force)
}

function qualityScore(channel) { return parseInt(String(channel.quality || '0').replace(/\D/g, '')) || 0 }

let languageNames
function languageLabel(code) {
  if (!code) return ''
  try {
    languageNames = languageNames || new Intl.DisplayNames(['zh-Hant'], { type: 'language' })
    return languageNames.of(code) || code
  } catch { return code }
}

function categoryLabel(id) {
  return ({ news: '新聞', business: '財經', sports: '體育', general: '綜合', entertainment: '娛樂', movies: '電影', music: '音樂',
    kids: '兒童', education: '教育', documentary: '紀錄片', culture: '文化', religious: '宗教', government: '政府',
    weather: '氣象', family: '家庭', lifestyle: '生活', science: '科學', shop: '購物', travel: '旅遊', comedy: '喜劇',
    series: '影集', auto: '汽車', cooking: '烹飪', fitness: '健身', outdoors: '戶外', relax: '放鬆', classic: '經典',
    animation: '動畫', legend: '傳奇', top: '排行' })[id] || id
}

async function addCatalogChannels(channels) {
  const playlists = await getPlaylists()
  const playlist = playlists.find(item => item.id === 'catalog-import') ||
    { id: 'catalog-import', name: 'IPTV.org 頻道', sourceURL: 'catalog://local', content: '', channelCount: 0, importedAt: new Date().toISOString() }
  let added = 0
  for (const channel of channels) {
    if (playlist.content.includes(`tvg-id="${channel.id}"`)) continue
    const entry = `#EXTINF:-1 tvg-id="${channel.id}" tvg-country="${channel.country}" group-title="IPTV.org",${channel.name}\n${channel.streamURL}`
    playlist.content = playlist.content ? `${playlist.content}\n${entry}` : entry
    added += 1
  }
  if (!added) return 0
  playlist.channelCount = parseM3U(playlist.content, playlist.id).length
  playlist.importedAt = new Date().toISOString()
  await savePlaylist(playlist)
  return added
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

function editFavoriteGroupModal({ title, initial = '', confirmLabel, onConfirm }) {
  const input = element('input', { type: 'text', value: initial, placeholder: '例如：財經新聞、體育直播、台灣頻道' })
  const message = element('div', { className: 'modal-message' })
  const submit = async () => {
    const name = input.value.trim()
    if (!name) { message.textContent = '請輸入清單名稱。'; input.focus(); return }
    const error = await onConfirm(name)
    if (error) { message.textContent = error; return }
    closeModal()
  }
  input.addEventListener('keydown', event => { if (event.key === 'Enter') submit() })
  openModal(element('div', {},
    element('h2', { text: title }),
    element('div', { className: 'form-field' }, element('label', { text: '清單名稱' }), input),
    message,
    element('div', { className: 'modal-actions' },
      element('button', { onclick: closeModal, text: '取消' }),
      element('button', { className: 'primary', onclick: submit, text: confirmLabel })
    )
  ))
  input.focus()
  input.select()
}

function promptNewFavoriteGroup(then) {
  editFavoriteGroupModal({
    title: '新增最愛清單',
    confirmLabel: '建立',
    onConfirm: async name => {
      const group = await createFavoriteGroup(name)
      state.activeGroupID = group.id
      await setActiveFavoriteGroupID(group.id)
      state.category = `fav:${group.id}`
      localStorage.setItem('oc-category', state.category)
      toast(`已建立「${group.name}」`)
      await render()
      if (typeof then === 'function') await then()
    }
  })
}

function promptRenameFavoriteGroup(group, then) {
  editFavoriteGroupModal({
    title: '重新命名最愛清單',
    initial: group.name,
    confirmLabel: '儲存',
    onConfirm: async name => {
      await renameFavoriteGroup(group.id, name)
      toast('已更新清單名稱')
      await render()
      if (typeof then === 'function') await then()
    }
  })
}

async function removeFavoriteGroup(group) {
  if (!window.confirm(`確定要刪除「${group.name}」嗎？清單內的頻道會留在播放牆上。`)) return
  try { await deleteFavoriteGroup(group.id) }
  catch (error) { toast(error.message); return }
  toast(`已刪除「${group.name}」`)
  if (favoriteGroupID(state.category) === group.id) {
    state.category = 'all'
    localStorage.setItem('oc-category', state.category)
  }
  await render()
}

function showFavoriteGroupMenu(x, y, group) {
  showMenu(x, y, menu => {
    addMenuItem(menu, `★ 檢視「${group.name}」`, () => selectCategory(`fav:${group.id}`))
    addMenuItem(menu, '✎ 重新命名清單', () => promptRenameFavoriteGroup(group))
    addSeparator(menu)
    addMenuItem(menu, '＋ 新增最愛清單…', promptNewFavoriteGroup)
    addSeparator(menu)
    addMenuItem(menu, '🗑 刪除這份清單', () => removeFavoriteGroup(group), { danger: true })
  })
}

async function openPlaylistManager() {
  const favoritesList = element('div', { className: 'manager-list' })
  const sourceList = element('div', { className: 'manager-list' })
  const groups = await getFavoriteGroups()
  const counts = await getFavoriteCounts()

  for (const group of groups) {
    favoritesList.append(element('div', { className: 'playlist-row' },
      element('div', { className: 'playlist-info' },
        element('div', { className: 'playlist-name', text: `★ ${group.name}` }),
        element('div', { className: 'playlist-meta', text: `${counts[group.id] || 0} 個頻道` })
      ),
      element('button', {
        className: 'catalog-add',
        title: '重新命名',
        text: '✎',
        onclick: async () => { await promptRenameFavoriteGroup(group, openPlaylistManager) }
      }),
      element('button', {
        className: 'catalog-add danger',
        title: groups.length <= 1 ? '至少要保留一份最愛清單' : '刪除清單',
        disabled: groups.length <= 1,
        text: '×',
        onclick: async () => { await removeFavoriteGroup(group); await openPlaylistManager() }
      })
    ))
  }

  const playlists = await getPlaylists()
  if (!playlists.length) sourceList.append(element('div', { className: 'loading', text: '尚無播放清單' }))
  for (const playlist of playlists) {
    sourceList.append(element('div', { className: 'playlist-row' },
      element('div', { className: 'playlist-info' },
        element('div', { className: 'playlist-name', text: playlist.name }),
        element('div', { className: 'playlist-meta', text: `${playlist.channelCount} 個頻道 · ${playlist.sourceURL}` })
      ),
      element('button', {
        className: 'catalog-add danger',
        title: '移除這份來源',
        text: '×',
        onclick: async () => {
          if (!window.confirm(`確定要移除來源「${playlist.name}」嗎？此來源已加入的頻道會留在播放牆上。`)) return
          await removePlaylist(playlist.id); closeModal(); render()
        }
      })
    ))
  }

  openModal(element('div', {},
    element('h2', { text: '頻道庫與來源' }),
    element('p', { className: 'modal-note', text: '「我的最愛清單」可建立多份自訂名稱的清單，每份各自保留自己的頻道與排序。' }),
    element('div', { className: 'manager-section' },
      element('div', { className: 'manager-heading' },
        element('h3', { text: '我的最愛清單' }),
        element('button', {
          className: 'catalog-add',
          title: '新增最愛清單',
          text: '＋',
          onclick: async () => { await promptNewFavoriteGroup(openPlaylistManager) }
        })
      ),
      favoritesList
    ),
    element('div', { className: 'manager-section' },
      element('div', { className: 'manager-heading' }, element('h3', { text: '頻道來源' })),
      sourceList
    ),
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
    if (justDragged()) return // 拖曳頻道時不要順便翻頁
    const distance = event.changedTouches[0].clientX - touchStartX
    if (Math.abs(distance) > 60) changePage(distance > 0 ? -1 : 1)
  }, { passive: true })
}

async function main() {
  await initDB()
  await initSharedStore()
  window.addEventListener('oc-store-sync-failed', event => {
    toast('無法同步到伺服器：' + (event.detail || '網路錯誤') + '，稍後會自動重試。')
  })
  // 舊版的單一「我的最愛」分類改指向目前的預設清單。
  const groups = await getFavoriteGroups()
  if (state.category === 'favorites') state.category = `fav:${await getActiveFavoriteGroupID()}`
  const browsing = favoriteGroupID(state.category)
  if (browsing && !groups.some(group => group.id === browsing)) state.category = 'all'
  localStorage.setItem('oc-category', state.category)
  // 每份播放清單／最愛清單各自記住版面：切換清單時套用各自存好的 mode。
  state.modes = await getWallModes()
  if (!state.modes['all']) state.modes['all'] = localStorage.getItem('oc-mode') || '4x4'
  state.mode = state.modes[state.category] || '4x4'
  installGlobalActivityHandlers()
  installHeroSoundUnlock()
  await render()
}

main().catch(error => {
  app.textContent = `Web IPTV Wall player 啟動失敗：${error.message}`
  console.error(error)
})
