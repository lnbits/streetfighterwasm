const state = {
  game: null,
  gameId: null,
  player: null,
  playerToken: '',
  invoiceUnsubscribe: null,
  invoicePollTimer: null,
  gamePollTimer: null,
  gameRefreshPending: false,
  qrApp: null,
  realtimeUnsubscribe: null,
  realtimeSend: null,
  inputPublishTimer: null,
  statePublishTimer: null,
  roundStartTimeout: null,
  roundStarting: false,
  roundStarted: false,
  serverClockOffsetMs: 0,
  stateSequence: 0,
  inputSequence: 0,
  lastAppliedStateSequence: 0,
  lastInputJson: '',
  lastInputSentAt: 0,
  gameStarted: false,
  winnerDeclarationPending: false,
  winnerDeclaredSide: ''
}

const GAME_POLL_INTERVAL_MS = 1000
const INPUT_PUBLISH_INTERVAL_MS = 33
const INPUT_KEEPALIVE_MS = 180
const STATE_PUBLISH_INTERVAL_MS = 33

window.STREETFIGHTER_CAN_PLAY = false
window.STREETFIGHTER_LOCAL_SIDE = ''
window.STREETFIGHTER_LOCAL_PLAYER_INDEX = null
window.STREETFIGHTER_MATCH_ENDED = false
window.STREETFIGHTER_ROUND_STARTING = false
window.STREETFIGHTER_IS_AUTHORITY = false

const client = window.createLNbitsExtensionClient({
  extensionId: 'streetfighterwasm'
})

const gameSubtitle = document.querySelector('#game-subtitle')
const gameTitle = document.querySelector('#game-title')
const gameStatus = document.querySelector('#game-status')
const joinForm = document.querySelector('#join-form')
const joinFormColumn = document.querySelector('#join-form-column')
const joinButton = document.querySelector('#join-button')
const copyGameButton = document.querySelector('#copy-game-button')
const playersStat = document.querySelector('#players-stat')
const amountStat = document.querySelector('#amount-stat')
const haircutStat = document.querySelector('#haircut-stat')
const playerList = document.querySelector('#player-list')
const fightOverlay = document.querySelector('#fight-overlay')
const invoiceDialog = document.querySelector('#invoice-dialog')
const invoiceQrCode = document.querySelector('#invoice-qrcode')
const invoiceStatus = document.querySelector('#invoice-status')
const copyInvoiceButton = document.querySelector('#copy-invoice-button')
const chatInput = document.querySelector('#chat-input')
const chatButton = document.querySelector('#chat-button')
const chatList = document.querySelector('#chat-list')
const soundToggle = document.querySelector('#sound-toggle')

window.STREETFIGHTER_MUTED = true

joinButton.addEventListener('click', async event => {
  event.preventDefault()
  setJoinLoading(true)
  try {
    const invoice = normalizeJoinInvoice(await client.joinGame(state.gameId, {
      lnAddress: fieldValue(joinForm, 'lnAddress')
    }))
    savePlayerToken(invoice.playerToken)
    openInvoiceDialog(invoice)
    startInvoicePolling(invoice.playerToken)
    await subscribeToPayment(invoice.paymentHash)
  } catch (error) {
    showError(error)
  } finally {
    setJoinLoading(false)
  }
})

copyGameButton.addEventListener('click', async () => {
  await copyText(publicGameUrl(), 'Match link copied.', 'Failed to copy match link.')
})

copyInvoiceButton.addEventListener('click', async () => {
  const invoice = copyInvoiceButton.dataset.invoice || ''
  if (!invoice) return
  await copyText(invoice, 'Invoice copied.', 'Failed to copy invoice.')
})

chatButton.addEventListener('click', () => {
  const message = chatInput.value.trim().slice(0, 160)
  if (!message) return
  if (!state.player) {
    showError(new Error('Only paid fighters can chat.'))
    return
  }
  chatInput.value = ''
  appendChatMessage('you', message)
  sendRealtimeOrHttp(
    {
      type: 'chat',
      side: state.player.side,
      message
    },
    () => client.publishChat(state.gameId, {
      playerToken: playerToken(),
      message
    })
  ).catch(showError)
})

soundToggle?.addEventListener('click', event => {
  event.preventDefault()
  setMutedPreference(!window.STREETFIGHTER_MUTED, { userGesture: true })
})

window.addEventListener('streetfighter:winner', async event => {
  const winnerIndex = Number(event.detail?.winnerIndex)
  const side = winnerIndex === 0 ? 'ryu' : 'ken'
  lockLocalFight()
  if (state.player?.side === side && state.game?.status === 'active') {
    await declareGameWinner(side)
  }
})

window.addEventListener('streetfighter:start-request', () => {
  requestRoundStart().catch(showError)
})

window.addEventListener('streetfighter:game-error', event => {
  const message = String(event.detail?.message || 'The game could not start.')
  fightOverlay.hidden = false
  fightOverlay.querySelector('strong').textContent = 'Game failed to start'
  fightOverlay.querySelector('span').textContent = message
  showError(new Error(message))
})

for (const closeControl of document.querySelectorAll('[data-close-invoice]')) {
  closeControl.addEventListener('click', closeInvoiceDialog)
}

init().catch(showError)

async function init() {
  updateSoundToggle()
  const context = await client.context()
  state.gameId = context.routeParams?.gameId || null
  state.playerToken = tokenFromUrl()
  await renderGame()
  window.addEventListener('beforeunload', cleanup)
}

function setMutedPreference(muted, options = {}) {
  window.STREETFIGHTER_MUTED = muted === true
  try {
    window.localStorage?.setItem('streetfighterwasm-muted', String(window.STREETFIGHTER_MUTED))
  } catch (error) {
    // Some sandboxed browsers can deny localStorage; the in-memory flag is enough.
  }
  window.STREETFIGHTER_AUDIO?.setMuted?.(window.STREETFIGHTER_MUTED)
  if (!window.STREETFIGHTER_MUTED && options.userGesture === true) {
    window.STREETFIGHTER_AUDIO?.unlockAudio?.()
  }
  updateSoundToggle()
}

function updateSoundToggle() {
  if (!soundToggle) return
  const muted = window.STREETFIGHTER_MUTED === true
  soundToggle.textContent = muted ? 'volume_off' : 'volume_up'
  soundToggle.setAttribute('aria-label', muted ? 'Unmute game sound' : 'Mute game sound')
  soundToggle.setAttribute('aria-pressed', String(muted))
  soundToggle.title = muted ? 'Unmute sound' : 'Mute sound'
}

async function renderGame() {
  if (!state.gameId) {
    gameTitle.textContent = 'No match selected'
    gameStatus.textContent = 'Open a valid StreetFighter match link.'
    return
  }

  const response = await client.getPublicGame(state.gameId, playerToken())
  const game = localCompletedGame(response?.game)
  if (!game) throw new Error('StreetFighter match not found.')
  if (Number(response.serverTimeMs || 0) > 0) {
    state.serverClockOffsetMs = Number(response.serverTimeMs) - Date.now()
  }
  state.game = game
  state.player = response.player || null
  gameTitle.textContent = game.name
  gameSubtitle.textContent = `${game.joinAmount} sats to join`
  gameStatus.textContent = statusText(game, state.player)
  playersStat.textContent = `${game.playersCount} / 2`
  amountStat.textContent = `${game.joinAmount} sats`
  haircutStat.textContent = 'winner takes all'
  joinFormColumn.hidden = response.canJoin !== true || !!state.player
  renderPlayers(response.players || [], state.player)
  updateFightOverlay(game, state.player)
  if (game.status === 'active' && state.player && Number(game.roundStartAt || 0) > 0) {
    scheduleRoundStart({
      startAtMs: game.roundStartAt,
      serverTimeMs: response.serverTimeMs
    })
  }
  await configureRealtime()
}

async function declareGameWinner(side) {
  if (
    state.winnerDeclarationPending ||
    state.winnerDeclaredSide === side ||
    !state.gameId ||
    !playerToken() ||
    state.player?.side !== side ||
    state.game?.status !== 'active'
  ) {
    return
  }
  state.winnerDeclarationPending = true
  try {
    await client.declareWinner(state.gameId, {
      playerToken: playerToken(),
      winnerSide: side
    })
    state.winnerDeclaredSide = side
    await renderGame()
    const message = gamePayoutMessage(state.game)
    await client.notify(message, state.game?.payoutPending ? 'warning' : 'positive')
  } catch (error) {
    showError(error)
  } finally {
    state.winnerDeclarationPending = false
  }
}

function renderPlayers(players, currentPlayer) {
  playerList.innerHTML = ''
  if (!players.length) {
    const empty = document.createElement('p')
    empty.className = 'muted q-my-none'
    empty.textContent = 'Waiting for paid players.'
    playerList.append(empty)
    return
  }
  for (const player of players) {
    const row = document.createElement('div')
    row.className = 'player-row'
    const label = document.createElement('span')
    label.textContent = `${sideName(player.side)}: ${player.lnAddress}`
    const status = document.createElement('span')
    status.textContent = currentPlayer?.side === player.side ? 'you' : player.status
    row.append(label, status)
    playerList.append(row)
  }
}

function updateFightOverlay(game, player) {
  if (game.status === 'active' && player) {
    fightOverlay.hidden = true
    window.STREETFIGHTER_LOCAL_SIDE = player.side
    window.STREETFIGHTER_LOCAL_PLAYER_INDEX = player.side === 'ken' ? 1 : 0
    window.STREETFIGHTER_IS_AUTHORITY = player.side === 'ryu'
    window.STREETFIGHTER_CAN_PLAY = true
    window.STREETFIGHTER_MATCH_ENDED = false
    return
  }
  lockLocalFight(player?.side || '', game.status === 'completed')
  fightOverlay.hidden = false
  const title = fightOverlay.querySelector('strong')
  const body = fightOverlay.querySelector('span')
  if (game.status === 'completed') {
    title.textContent = `${sideName(game.winnerSide)} wins`
    body.textContent = game.payoutPending
      ? 'Payout is pending owner settlement.'
      : 'Payout has been settled.'
    return
  }
  if (!player) {
    title.textContent = 'Join to fight'
    body.textContent = 'Pay the join invoice to lock in your player slot. The stage unlocks after both players have paid.'
    return
  }
  title.textContent = 'Waiting for opponent'
  body.textContent = 'Your fighter unlocks when both paid players are in.'
}

function statusText(game, player) {
  if (game.status === 'completed') {
    return game.payoutPending
      ? `${sideName(game.winnerSide)} won. Payout needs owner retry.`
      : `${sideName(game.winnerSide)} won. Payout sent.`
  }
  if (game.status === 'active') {
    if (!player) return 'Fight in progress'
    return `You are ${sideName(player.side)}. WASD move, Q/E/R punch, F/V/G kick.`
  }
  if (player) return `You are ${sideName(player.side)}. Waiting for opponent.`
  return 'Waiting for two paid players'
}

async function configureRealtime() {
  if (!state.gameId) {
    stopRealtime()
    return
  }

  // Subscribe before payment too: a player with an open invoice needs the
  // lifecycle message that marks their slot paid and starts the match.
  if (!state.realtimeUnsubscribe) {
    try {
      state.realtimeUnsubscribe = await client.subscribeWebsocket(
        gameChannel(state.gameId),
        handleRealtimeMessage
      )
      state.realtimeSend = state.realtimeUnsubscribe.send
    } catch (error) {
      console.warn('[streetfighterwasm public] websocket subscribe failed', error)
    }
  }

  const paidPlayer = state.player && playerToken()
  if (!paidPlayer) {
    stopGamePolling()
    stopFightTimers()
    return
  }

  startGamePolling()

  const activePlayer = state.game?.status === 'active'
  if (!activePlayer) {
    stopFightTimers()
    return
  }

  if (!state.inputPublishTimer) {
    state.inputPublishTimer = window.setInterval(
      publishLocalInput,
      INPUT_PUBLISH_INTERVAL_MS
    )
  }
  if (!state.statePublishTimer) {
    state.statePublishTimer = window.setInterval(
      publishLocalFighterState,
      STATE_PUBLISH_INTERVAL_MS
    )
  }
}

async function requestRoundStart() {
  if (
    state.roundStarting ||
    state.roundStarted ||
    state.game?.status !== 'active' ||
    state.player?.side !== 'ryu' ||
    !state.player ||
    !playerToken()
  ) {
    return
  }
  state.roundStarting = true
  window.STREETFIGHTER_ROUND_STARTING = true
  try {
    // Starting is durable state, not merely a realtime hint. Persist it so a
    // delayed or disconnected opponent still receives the same countdown.
    const startMessage = await client.publishStart(state.gameId, {
      playerToken: playerToken()
    })
    scheduleRoundStart(startMessage)
  } catch (error) {
    state.roundStarting = false
    window.STREETFIGHTER_ROUND_STARTING = false
    throw error
  }
}

function scheduleRoundStart(data = {}) {
  if (state.roundStarted || state.game?.status !== 'active') return
  const startAtMs = Number(data.startAtMs || 0)
  const serverNowMs = Date.now() + Number(state.serverClockOffsetMs || 0)
  const delayMs = startAtMs > 0 ? Math.max(0, startAtMs - serverNowMs) : 1500

  if (state.roundStartTimeout) window.clearTimeout(state.roundStartTimeout)
  state.roundStarting = true
  window.STREETFIGHTER_ROUND_STARTING = true
  state.roundStartTimeout = window.setTimeout(() => {
    state.roundStarted = true
    state.roundStarting = false
    window.STREETFIGHTER_ROUND_STARTING = false
    window.dispatchEvent(new CustomEvent('streetfighter:start-match', {
      detail: {startAtMs: Date.now()}
    }))
  }, delayMs)
}

function stopRealtime() {
  if (state.realtimeUnsubscribe) {
    state.realtimeUnsubscribe()
    state.realtimeUnsubscribe = null
  }
  state.realtimeSend = null
  stopGamePolling()
  stopFightTimers()
  state.roundStarting = false
  state.roundStarted = false
  state.stateSequence = 0
  state.inputSequence = 0
  state.lastAppliedStateSequence = 0
  window.STREETFIGHTER_ROUND_STARTING = false
  window.STREETFIGHTER_IS_AUTHORITY = false
  state.lastInputJson = ''
  state.lastInputSentAt = 0
  window.STREETFIGHTER_INPUT?.clearRemoteInputs?.()
}

function startGamePolling() {
  if (state.gamePollTimer) return
  state.gamePollTimer = window.setInterval(async () => {
    if (state.gameRefreshPending || document.hidden) return
    state.gameRefreshPending = true
    try {
      await renderGame()
    } catch (error) {
      console.warn('[streetfighterwasm public] game refresh fallback failed', error)
    } finally {
      state.gameRefreshPending = false
    }
  }, GAME_POLL_INTERVAL_MS)
}

function stopGamePolling() {
  if (!state.gamePollTimer) return
  window.clearInterval(state.gamePollTimer)
  state.gamePollTimer = null
  state.gameRefreshPending = false
}

function stopFightTimers() {
  if (state.inputPublishTimer) {
    window.clearInterval(state.inputPublishTimer)
    state.inputPublishTimer = null
  }
  if (state.statePublishTimer) {
    window.clearInterval(state.statePublishTimer)
    state.statePublishTimer = null
  }
  if (state.roundStartTimeout) {
    window.clearTimeout(state.roundStartTimeout)
    state.roundStartTimeout = null
  }
}

function lockLocalFight(side = window.STREETFIGHTER_LOCAL_SIDE || '', ended = true) {
  window.STREETFIGHTER_CAN_PLAY = false
  window.STREETFIGHTER_LOCAL_SIDE = side
  window.STREETFIGHTER_LOCAL_PLAYER_INDEX = null
  window.STREETFIGHTER_IS_AUTHORITY = false
  window.STREETFIGHTER_MATCH_ENDED = ended === true
  window.STREETFIGHTER_INPUT?.clearRemoteInputs?.()
}

async function publishLocalInput() {
  if (
    state.game?.status !== 'active' ||
    !state.roundStarted ||
    !state.player ||
    !window.STREETFIGHTER_INPUT?.getLocalInputSnapshot
  ) {
    return
  }
  const input = window.STREETFIGHTER_INPUT.getLocalInputSnapshot()
  if (!input) return
  const inputJson = JSON.stringify(input)
  const now = Date.now()
  if (
    inputJson === state.lastInputJson &&
    now - Number(state.lastInputSentAt || 0) < INPUT_KEEPALIVE_MS
  ) {
    return
  }
  state.lastInputJson = inputJson
  state.lastInputSentAt = now
  state.inputSequence += 1
  try {
    await sendRealtimeOrHttp(
      {
        type: 'input',
        side: state.player.side,
        sequence: state.inputSequence,
        input
      },
      () => client.publishInput(state.gameId, {
        playerToken: playerToken(),
        input
      })
    )
  } catch (error) {
    console.warn('[streetfighterwasm public] input websocket send failed', error)
  }
}

async function publishLocalFighterState() {
  if (
    state.game?.status !== 'active' ||
    !state.roundStarted ||
    !state.player ||
    !window.STREETFIGHTER_BATTLE?.getLocalFighterSnapshot
  ) {
    return
  }
  const playerIndex = state.player.side === 'ken' ? 1 : 0
  const snapshot = window.STREETFIGHTER_BATTLE.getLocalFighterSnapshot(playerIndex)
  if (!snapshot) return
  state.stateSequence += 1
  try {
    const networkState = {
      ...snapshot,
      sequence: state.stateSequence
    }
    await sendRealtimeOrHttp(
      {
        type: 'fighter_state',
        side: state.player.side,
        state: networkState
      },
      () => client.publishState(state.gameId, {
        playerToken: playerToken(),
        state: networkState
      })
    )
  } catch (error) {
    console.warn('[streetfighterwasm public] state websocket send failed', error)
  }
}

function handleRealtimeMessage(event) {
  const data = event?.data || {}
  if (!data || typeof data !== 'object') return
  if (data.type === 'input') {
    if (!state.roundStarted) return
    if (data.side === state.player?.side) return
    const playerIndex = data.side === 'ken' ? 1 : 0
    window.STREETFIGHTER_INPUT?.setRemoteInput?.(
      playerIndex,
      data.input || {},
      {sequence: Number(data.sequence || 0)}
    )
    return
  }
  if (data.type === 'chat') {
    if (data.side === state.player?.side) return
    appendChatMessage(sideName(data.side), String(data.message || '').slice(0, 160))
    return
  }
  if (data.type === 'player_paid') {
    refreshAfterPlayerPayment().catch(error => {
      console.warn('[streetfighterwasm public] player refresh failed', error)
    })
    return
  }
  if (data.type === 'winner') {
    if (data.side) state.winnerDeclaredSide = data.side
    lockLocalFight(state.player?.side || '', true)
    renderGame().catch(error => console.warn('[streetfighterwasm public] winner refresh failed', error))
    return
  }
  if (data.type === 'start') {
    scheduleRoundStart(data)
    return
  }
  if (data.type === 'fighter_state') {
    applyPeerFighterState(data.side, data.state)
    return
  }
  if (data.type === 'state') {
    applyAuthoritativeState(data.state)
  }
}

function applyPeerFighterState(side, snapshot) {
  if (
    side === state.player?.side ||
    !state.roundStarted ||
    !window.STREETFIGHTER_BATTLE?.receivePeerFighterSnapshot
  ) {
    return
  }
  const sequence = Number(snapshot?.sequence || 0)
  if (sequence && sequence <= state.lastAppliedStateSequence) return
  if (sequence) state.lastAppliedStateSequence = sequence
  window.STREETFIGHTER_BATTLE.receivePeerFighterSnapshot(snapshot, {
    remotePlayerIndex: side === 'ken' ? 1 : 0
  })
}

function applyAuthoritativeState(snapshot) {
  if (
    state.player?.side === 'ryu' ||
    !state.roundStarted ||
    !window.STREETFIGHTER_BATTLE?.applyNetworkSnapshot
  ) {
    return
  }
  const sequence = Number(snapshot?.sequence || 0)
  if (sequence && sequence <= state.lastAppliedStateSequence) return
  if (sequence) state.lastAppliedStateSequence = sequence
  window.STREETFIGHTER_BATTLE.applyNetworkSnapshot(snapshot, {
    preserveAnimations: true,
    localPlayerIndex: state.player?.side === 'ken' ? 1 : 0
  })
}

async function refreshAfterPlayerPayment() {
  await renderGame()
  if (!invoiceDialog.hidden && state.player?.id === playerToken()) {
    invoiceStatus.textContent = 'Payment received'
    closeInvoiceDialog()
  }
}

async function sendRealtime(message) {
  if (!state.realtimeSend) throw new Error('Realtime websocket is not connected.')
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await state.realtimeSend(message)
      return
    } catch (error) {
      lastError = error
      await delay(120)
    }
  }
  throw lastError || new Error('Realtime websocket send failed.')
}

async function sendRealtimeOrHttp(message, httpFallback) {
  try {
    await sendRealtime(message)
  } catch (error) {
    console.warn('[streetfighterwasm public] websocket send failed; using HTTP fallback', error)
    await httpFallback()
  }
}

function delay(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function localCompletedGame(game) {
  if (!game || !state.winnerDeclaredSide || game.status !== 'active') return game
  return {
    ...game,
    status: 'completed',
    winnerSide: state.winnerDeclaredSide,
    payoutPending: game.payoutStatus !== 'paid',
    payoutStatus: game.payoutStatus || 'unknown'
  }
}

function gameChannel(gameId) {
  return `game_${String(gameId || '').replace(/[^A-Za-z0-9_.:-]/g, '_')}`.slice(0, 128)
}

function gamePayoutMessage(game) {
  if (!game) return 'Winner recorded.'
  if (game.payoutPending) return 'Winner recorded. Payout needs owner retry.'
  return 'Winner recorded and payout sent.'
}

function sideName(side) {
  if (side === 'ryu') return 'Ryu'
  if (side === 'ken') return 'Ken'
  return 'Player'
}

function openInvoiceDialog(invoice) {
  copyInvoiceButton.dataset.invoice = invoice.paymentRequest
  invoiceStatus.textContent = 'Waiting for payment'
  renderQr(invoice.paymentRequest)
  invoiceDialog.hidden = false
}

function closeInvoiceDialog() {
  invoiceDialog.hidden = true
  if (state.qrApp) {
    state.qrApp.unmount()
    state.qrApp = null
  }
  invoiceQrCode.innerHTML = ''
  if (state.invoiceUnsubscribe) {
    state.invoiceUnsubscribe()
    state.invoiceUnsubscribe = null
  }
  if (state.invoicePollTimer) {
    window.clearInterval(state.invoicePollTimer)
    state.invoicePollTimer = null
  }
}

function renderQr(value) {
  if (!window.Vue || !window.QrcodeVue?.default) {
    throw new Error('QR code renderer is not available.')
  }
  if (state.qrApp) {
    state.qrApp.unmount()
    state.qrApp = null
  }
  invoiceQrCode.innerHTML = ''
  state.qrApp = window.Vue.createApp({
    render() {
      return window.Vue.h(window.QrcodeVue.default, {
        value,
        size: 260,
        margin: 3,
        level: 'Q',
        renderAs: 'svg',
        class: 'invoice-qrcode-svg'
      })
    }
  })
  state.qrApp.mount(invoiceQrCode)
}

function normalizeJoinInvoice(invoice = {}) {
  const paymentHash = invoice.paymentHash || invoice.payment_hash || ''
  const playerToken = invoice.playerToken || invoice.player_token || paymentHash
  return {
    ...invoice,
    playerToken,
    paymentHash,
    paymentRequest: invoice.paymentRequest || invoice.payment_request || ''
  }
}

async function subscribeToPayment(paymentHash) {
  if (!paymentHash) return
  try {
    state.invoiceUnsubscribe = await client.subscribePayment(paymentHash, async event => {
      if (event.event === 'payment.error') {
        invoiceStatus.textContent = 'Checking payment status'
        return
      }
      const payment = event.data || {}
      if (
        event.event === 'payment.settled' ||
        payment.pending === false ||
        ['success', 'settled', 'paid'].includes(String(payment.status || ''))
      ) {
        invoiceStatus.textContent = 'Payment received'
        closeInvoiceDialog()
        await renderGame()
      }
    })
  } catch (error) {
    console.warn('[streetfighterwasm public] payment subscribe failed', error)
  }
}

function startInvoicePolling(playerToken) {
  if (state.invoicePollTimer) window.clearInterval(state.invoicePollTimer)
  state.invoicePollTimer = window.setInterval(async () => {
    try {
      await renderGame()
      if (state.player?.id === playerToken) closeInvoiceDialog()
    } catch (error) {
      console.warn('[streetfighterwasm public] invoice poll failed', error)
    }
  }, 2500)
}

function setJoinLoading(loading) {
  joinButton.disabled = loading
  joinButton.classList.toggle('is-loading', loading)
}

function savePlayerToken(playerToken) {
  const url = new URL(window.location.href)
  url.searchParams.set('playerToken', playerToken)
  window.history.replaceState({}, '', url)
  state.playerToken = playerToken
}

function tokenFromUrl() {
  return new URL(window.location.href).searchParams.get('playerToken') || ''
}

function playerToken() {
  return state.playerToken || tokenFromUrl()
}

function publicGameUrl() {
  const url = new URL(window.location.href)
  url.searchParams.delete('playerToken')
  return url.href
}

function fieldValue(container, name) {
  return container.querySelector(`[name="${name}"]`)?.value?.trim() || ''
}

async function copyText(value, successMessage, errorMessage) {
  try {
    await navigator.clipboard.writeText(value)
    await client.notify(successMessage, 'positive')
  } catch (error) {
    console.warn('[streetfighterwasm public] copy failed', error)
    await client.notify(errorMessage, 'negative').catch(() => {})
  }
}

function appendChatMessage(name, message) {
  const row = document.createElement('p')
  row.className = 'chat-message'
  const label = document.createElement('strong')
  label.textContent = `${name}: `
  const text = document.createElement('span')
  text.textContent = message
  row.append(label, text)
  chatList.append(row)
  chatList.scrollTop = chatList.scrollHeight
}

function cleanup() {
  stopRealtime()
  closeInvoiceDialog()
}

function showError(error) {
  const message = error?.message || String(error)
  client.notify(message, 'negative').catch(() => {
    console.error('[streetfighterwasm public]', message)
  })
}
