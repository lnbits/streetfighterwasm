import {storage, system, wallet, websocket} from './lnbits-sdk.js'

const SETTINGS_TABLE = 'streetfighter_settings'
const GAMES_TABLE = 'streetfighter_games'
const PLAYERS_TABLE = 'streetfighter_players'
const CLAIMS_TABLE = 'streetfighter_winner_claims'
const RECEIPTS_TABLE = 'streetfighter_payout_receipts'
const SETTINGS_ID = 'streetfighterwasm-settings'
const GAME_SEARCH_FIELDS = ['name', 'winner_ln_address', 'status']
const SIDES = ['ryu', 'ken']

export function getStreetfighterSettings(_requestJson) {
  return runJson(() => ({settings: publicSettings(getSettings())}))
}

export function saveStreetfighterSettings(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const existing = getSettings()
    const now = system.now()
    const walletId = cleanText(request.walletId ?? request.wallet_id, 128)
    const walletName = cleanText(request.walletName ?? request.wallet_name, 120)
    const settings = {
      id: SETTINGS_ID,
      wallet_id: walletId,
      wallet_name: walletName || walletId,
      enabled: request.enabled === true,
      haircut: normalizePercent(request.haircut, 0),
      created_at: existing.created_at || now,
      updated_at: now
    }

    if (settings.enabled && !settings.wallet_id) {
      throw new Error('walletId is required when StreetFighter games are enabled.')
    }
    storage.set(SETTINGS_TABLE, settings)
    system.log('streetfighterwasm: saved settings')
    return {settings: publicSettings(settings)}
  })
}

export function listStreetfighterWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function createStreetfighterGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const settings = getSettings()
    if (!settings.enabled) throw new Error('StreetFighter games are disabled.')
    if (!settings.wallet_id) throw new Error('StreetFighter wallet is not configured.')

    const joinAmount = normalizeInteger(
      request.joinAmount ?? request.join_amount,
      100,
      1,
      100000000
    )
    const now = system.now()
    const game = {
      id: cleanId(request.id) || system.id('fight').id || system.id('fight'),
      settings_id: settings.id,
      wallet_id: settings.wallet_id,
      name: cleanText(request.name, 80) || 'Paid StreetFighter match',
      join_amount: joinAmount,
      haircut: Number(settings.haircut || 0),
      players_count: 0,
      status: 'waiting',
      ryu_ln_address: '',
      ken_ln_address: '',
      ryu_payment_hash: '',
      ken_payment_hash: '',
      winner_side: '',
      winner_ln_address: '',
      payout_pending: false,
      payout_status: '',
      created_at: now,
      updated_at: now,
      started_at: null,
      round_start_at: null,
      completed_at: null
    }

    storage.set(GAMES_TABLE, game)
    system.log(`streetfighterwasm: created game ${game.id}`)
    return {game: publicGame(game), publicUrl: `/streetfighterwasm/games/${game.id}`}
  })
}

export function listStreetfighterGames(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const rowsPerPage = normalizePageSize(request.rowsPerPage)
    const page = normalizePage(request.page)
    const response = storage.getPaginated(GAMES_TABLE, {
      search: cleanText(request.search, 256),
      searchFields: GAME_SEARCH_FIELDS,
      sortBy: normalizeGameSortBy(request.sortBy),
      descending: request.descending === true || request.descending === 'true',
      limit: rowsPerPage,
      offset: (page - 1) * rowsPerPage
    })
    return {games: response.data.map(game => publicGame(applyWinnerClaim(game, winnerClaimForGame(game.id), payoutReceiptForGame(game.id)))), total: response.total}
  })
}

export function deleteStreetfighterGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = getGame(gameId)
    if (game.status === 'completed' && game.payout_pending === true) {
      throw new Error('Settle the pending payout before deleting this match.')
    }

    if (game.ryu_payment_hash) storage.delete(PLAYERS_TABLE, game.ryu_payment_hash)
    if (game.ken_payment_hash) storage.delete(PLAYERS_TABLE, game.ken_payment_hash)
    storage.delete(GAMES_TABLE, gameId)
    system.log(`streetfighterwasm: deleted game ${gameId}`)
    return {deleted: true, gameId}
  })
}

export function getPublicStreetfighterGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const game = applyWinnerClaim(getPublicGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = playerForToken(
      game,
      cleanText(request.playerToken ?? request.player_token, 128)
    )
    return {
      game: publicGame(game),
      players: publicPlayersFromGame(game),
      player: player ? publicPlayer(player, true) : null,
      canJoin: game.status === 'waiting' && Number(game.players_count || 0) < 2,
      serverTimeMs: system.now() * 1000,
      realtimeReady: false
    }
  })
}

export function joinStreetfighterGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const lnAddress = normalizeLnAddress(request.lnAddress ?? request.ln_address)
    const game = applyWinnerClaim(getPublicGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    if (game.status !== 'waiting') throw new Error('This match has already started.')
    if (Number(game.players_count || 0) >= 2) throw new Error('This match is already full.')

    const invoice = wallet.createInvoicePublic({
      sourceId: game.settings_id,
      amount: Number(game.join_amount),
      currency: 'sat',
      memo: `StreetFighter ${game.name} for ${lnAddress}`,
      extra: {
        game_id: game.id,
        ln_address: lnAddress
      }
    })

    return {
      paymentHash: invoice.paymentHash,
      paymentRequest: invoice.paymentRequest,
      checkingId: invoice.checkingId
    }
  })
}

export function recordStreetfighterPayment(eventJson) {
  return runJson(() => {
    const event = parseJsonObject(eventJson)
    const paymentHash = eventPaymentHash(event)
    const extensionExtra =
      event.extra?.extra_streetfighterwasm ||
      event.payment?.extra?.extra_streetfighterwasm ||
      {}
    const gameId = cleanText(
      extensionExtra.game_id || event.extra?.game_id || event.payment?.extra?.game_id,
      128
    )
    const lnAddress = normalizeLnAddress(
      extensionExtra.ln_address ||
        event.extra?.ln_address ||
        event.payment?.extra?.ln_address
    )
    if (!paymentHash) throw new Error('paymentHash is required.')
    if (!gameId) throw new Error('game_id is required.')

    const game = getPublicGame(gameId)
    const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
    if (existing) {
      return {game: publicGame(game), player: publicPlayer(existing, true), status: existing.status}
    }

    const paidSat = Math.abs(Number(event.amount || event.payment?.amount || 0)) / 1000
    if (paidSat && Math.trunc(paidSat) !== Number(game.join_amount)) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'amount-mismatch')
      return {game: publicGame(game), player: publicPlayer(player, true), status: 'amount-mismatch'}
    }
    if (game.status !== 'waiting' || Number(game.players_count || 0) >= 2) {
      const player = markPlayer(paymentHash, gameId, lnAddress, '', 'refund-pending')
      return {game: publicGame(game), player: publicPlayer(player, true), status: 'refund-pending'}
    }

    const paidPlayers = paidPlayersForGame(gameId)
    const side = paidPlayers.length === 0 ? 'ryu' : 'ken'
    const player = markPlayer(paymentHash, gameId, lnAddress, side, 'paid')
    const now = system.now()
    const playerCount = paidPlayers.length + 1
    const updatedGame = {
      ...game,
      players_count: playerCount,
      ryu_ln_address: side === 'ryu' ? lnAddress : game.ryu_ln_address,
      ken_ln_address: side === 'ken' ? lnAddress : game.ken_ln_address,
      ryu_payment_hash: side === 'ryu' ? paymentHash : game.ryu_payment_hash,
      ken_payment_hash: side === 'ken' ? paymentHash : game.ken_payment_hash,
      status: playerCount === 2 ? 'active' : 'waiting',
      started_at: playerCount === 2 ? now : game.started_at,
      updated_at: now
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGameMessage(gameId, {
      type: 'player_paid',
      side,
      playersCount: playerCount,
      status: updatedGame.status
    })
    return {game: publicGame(updatedGame), player: publicPlayer(player, true), status: 'paid'}
  })
}

export function declareStreetfighterWinner(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    const side = normalizeSide(request.winnerSide ?? request.winner_side)
    const rawGame = getGame(gameId)
    const game = applyWinnerClaim(rawGame, winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = requireActivePlayer(game, token)
    if (game.status === 'completed') {
      return {
        game: publicGame(game),
        player: publicPlayer(player, true),
        payout: {
          ok: game.payout_pending !== true,
          pending: game.payout_pending === true,
          status: game.payout_status || ''
        }
      }
    }
    if (game.status !== 'active') throw new Error('Only active matches can be completed.')
    if (player.side !== side) {
      throw new Error('For now, only the paid player can declare their own win.')
    }
    if (!game.wallet_id) {
      throw new Error('This match was created before payout support was updated. Create a new match.')
    }

    const now = system.now()
    const amount = payoutAmount(game)
    storage.appendPublic(CLAIMS_TABLE, gameId, {
      winner_side: side,
      winner_ln_address: player.ln_address,
      player_token: token,
      payout_amount: amount,
      created_at: now
    })

    const processingGame = {
      ...rawGame,
      status: 'completed',
      winner_side: side,
      winner_ln_address: player.ln_address,
      payout_pending: true,
      payout_status: 'processing',
      updated_at: now,
      completed_at: now
    }
    storage.set(GAMES_TABLE, processingGame)

    const payout = payWinner({
      walletId: rawGame.wallet_id || getSettingsById(game.settings_id).wallet_id,
      lnAddress: player.ln_address,
      maxSat: amount,
      description: `StreetFighter winnings for ${game.name}`,
      gameId,
      side
    })
    if (payout.ok) {
      storage.appendPublic(RECEIPTS_TABLE, gameId, {
        winner_side: side,
        paid_at: system.now()
      })
    }
    const updatedGame = {
      ...processingGame,
      payout_pending: !payout.ok,
      payout_status: payout.ok ? 'paid' : 'failed',
      updated_at: system.now()
    }
    storage.set(GAMES_TABLE, updatedGame)
    publishGameMessage(gameId, {
      type: 'winner',
      side,
      payout
    })
    return {
      game: publicGame(updatedGame),
      player: publicPlayer(player, true),
      payout
    }
  })
}

export function publishStreetfighterInput(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    const game = applyWinnerClaim(getPublicGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = requireActivePlayer(game, token)
    if (game.status !== 'active') throw new Error('Only active matches can receive input.')

    const input = normalizeInput(request.input)
    publishGameMessage(gameId, {
      type: 'input',
      side: player.side,
      input,
      sentAt: system.now()
    })
    return {sent: true}
  })
}

export function publishStreetfighterStart(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    const game = applyWinnerClaim(getGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = requireActivePlayer(game, token)
    if (game.status !== 'active') throw new Error('Only active matches can be started.')

    const serverTimeMs = system.now() * 1000
    const existingStartAtMs = Number(game.round_start_at || 0)
    const startAtMs = existingStartAtMs > 0 ? existingStartAtMs : serverTimeMs + 2500
    if (existingStartAtMs <= 0) {
      storage.set(GAMES_TABLE, {
        ...game,
        round_start_at: startAtMs,
        updated_at: system.now()
      })
    }
    const message = {
      type: 'start',
      side: player.side,
      serverTimeMs,
      startAtMs
    }
    publishGameMessage(gameId, message)
    return message
  })
}

export function publishStreetfighterChat(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    const game = applyWinnerClaim(getPublicGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = requireActivePlayer(game, token)
    const message = requiredText(request.message, 'message', 160)

    publishGameMessage(gameId, {
      type: 'chat',
      side: player.side,
      message,
      sentAt: system.now()
    })
    return {sent: true}
  })
}

export function publishStreetfighterState(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const token = requiredText(request.playerToken ?? request.player_token, 'playerToken', 128)
    const game = applyWinnerClaim(getPublicGame(gameId), winnerClaimForGame(gameId), payoutReceiptForGame(gameId))
    const player = requireActivePlayer(game, token)
    if (game.status !== 'active') throw new Error('Only active matches can receive state.')
    if (player.side !== 'ryu') throw new Error('Only Ryu can publish match state.')

    const state = normalizeGameState(request.state)
    publishGameMessage(gameId, {
      type: 'state',
      side: player.side,
      state,
      sentAt: system.now()
    })
    return {sent: true}
  })
}

export function settleStreetfighterGame(requestJson) {
  return runJson(() => {
    const request = parseJsonObject(requestJson)
    const gameId = requiredText(request.gameId, 'gameId', 128)
    const rawGame = getGame(gameId)
    const claim = winnerClaimForGame(gameId)
    const receipt = payoutReceiptForGame(gameId)
    const game = applyWinnerClaim(rawGame, claim, receipt)
    if (receipt) return {game: publicGame(game), payout: {ok: true, status: 'paid'}}
    if (game.status !== 'completed') throw new Error('Only completed matches can be settled.')
    const winnerLnAddress = game.winner_ln_address || claim?.winner_ln_address || ''
    const winnerSide = game.winner_side || claim?.winner_side || ''
    if (!winnerLnAddress || !winnerSide) throw new Error('Winner is missing.')
    if (game.payout_pending !== true) throw new Error('This match is already settled.')
    if (game.payout_status === 'processing') throw new Error('Payout is already processing.')
    const processingGame = {
      ...rawGame,
      status: 'completed',
      winner_side: winnerSide,
      winner_ln_address: winnerLnAddress,
      payout_pending: true,
      payout_status: 'processing',
      updated_at: system.now(),
      completed_at: game.completed_at || system.now()
    }
    storage.set(GAMES_TABLE, processingGame)

    const payout = payWinner({
      walletId: rawGame.wallet_id || getSettingsById(game.settings_id).wallet_id,
      lnAddress: winnerLnAddress,
      maxSat: payoutAmount(game),
      description: `StreetFighter winnings for ${game.name}`,
      gameId,
      side: winnerSide
    })
    if (payout.ok) {
      storage.appendPublic(RECEIPTS_TABLE, gameId, {
        winner_side: winnerSide,
        paid_at: system.now()
      })
    }
    const updatedGame = {
      ...processingGame,
      payout_pending: !payout.ok,
      payout_status: payout.ok ? 'paid' : 'failed',
      updated_at: system.now()
    }
    storage.set(GAMES_TABLE, updatedGame)
    return {game: publicGame(updatedGame), payout}
  })
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ok: false, error: message})
  }
}

function parseJsonObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function getSettings() {
  return storage.get(SETTINGS_TABLE, SETTINGS_ID, defaultSettings())
}

function getSettingsById(settingsId) {
  const settings = storage.get(SETTINGS_TABLE, settingsId || SETTINGS_ID, null)
  if (!settings) throw new Error('StreetFighter settings not found.')
  return settings
}

function defaultSettings() {
  const now = system.now()
  return {
    id: SETTINGS_ID,
    wallet_id: '',
    wallet_name: '',
    enabled: false,
    haircut: 0,
    created_at: now,
    updated_at: now
  }
}

function getGame(gameId) {
  const game = storage.get(GAMES_TABLE, gameId, null)
  if (!game) throw new Error('StreetFighter match not found.')
  return game
}

function getPublicGame(gameId) {
  const game = storage.getPublic(GAMES_TABLE, gameId, null)
  if (!game) throw new Error('StreetFighter match not found.')
  return game
}

function winnerClaimForGame(gameId) {
  const page = storage.getPublicPaginated(CLAIMS_TABLE, {
    sourceId: gameId,
    filters: {},
    sortBy: 'created_at',
    descending: true,
    limit: 1,
    offset: 0
  })
  return page.data[0] || null
}

function payoutReceiptForGame(gameId) {
  const page = storage.getPublicPaginated(RECEIPTS_TABLE, {
    sourceId: gameId,
    filters: {},
    sortBy: 'paid_at',
    descending: true,
    limit: 1,
    offset: 0
  })
  return page.data[0] || null
}

function applyWinnerClaim(game, claim, receipt = null) {
  if (!claim) return game
  const paid = !!receipt
  return {
    ...game,
    status: 'completed',
    winner_side: claim.winner_side || game.winner_side,
    winner_ln_address: claim.winner_ln_address || game.winner_ln_address,
    payout_pending: !paid,
    payout_status: paid ? 'paid' : (game.payout_status || 'pending'),
    completed_at: Number(claim.created_at || game.completed_at || 0),
    updated_at: Number(receipt?.paid_at || claim.created_at || game.updated_at || 0)
  }
}

function markPlayer(paymentHash, gameId, lnAddress, side, status) {
  const existing = storage.get(PLAYERS_TABLE, paymentHash, null)
  const now = system.now()
  const player = {
    id: paymentHash,
    game_id: gameId,
    ln_address: existing?.ln_address || lnAddress,
    payment_hash: paymentHash,
    side: existing?.side || side,
    status,
    created_at: existing?.created_at || now,
    paid_at: ['paid', 'refund-pending'].includes(status) ? existing?.paid_at || now : existing?.paid_at || null
  }
  storage.set(PLAYERS_TABLE, player)
  return player
}

function paidPlayersForGame(gameId) {
  return storage.getPaginated(PLAYERS_TABLE, {
    filters: {game_id: gameId, status: 'paid'},
    sortBy: 'paid_at',
    descending: false,
    limit: 10,
    offset: 0
  }).data
}

function publicPlayersFromGame(game) {
  const players = []
  if (game.ryu_ln_address) {
    players.push(publicPlayer({
      id: '',
      game_id: game.id,
      ln_address: game.ryu_ln_address,
      payment_hash: '',
      side: 'ryu',
      status: 'paid',
      paid_at: 0
    }, false))
  }
  if (game.ken_ln_address) {
    players.push(publicPlayer({
      id: '',
      game_id: game.id,
      ln_address: game.ken_ln_address,
      payment_hash: '',
      side: 'ken',
      status: 'paid',
      paid_at: 0
    }, false))
  }
  return players
}

function playerForToken(game, token) {
  if (!token) return null
  if (token === game.ryu_payment_hash) {
    return {
      id: token,
      game_id: game.id,
      ln_address: game.ryu_ln_address,
      payment_hash: token,
      side: 'ryu',
      status: 'paid',
      paid_at: 0
    }
  }
  if (token === game.ken_payment_hash) {
    return {
      id: token,
      game_id: game.id,
      ln_address: game.ken_ln_address,
      payment_hash: token,
      side: 'ken',
      status: 'paid',
      paid_at: 0
    }
  }
  return null
}

function requireActivePlayer(game, token) {
  const player = playerForToken(game, token)
  if (!player || player.status !== 'paid' || !SIDES.includes(player.side)) {
    throw new Error('A paid player token is required.')
  }
  return player
}

function payoutAmount(game) {
  const total = Number(game.join_amount || 0) * 2
  const haircut = total * (Number(game.haircut || 0) / 100)
  return Math.max(0, Math.trunc(total - haircut))
}

function payWinner({walletId, lnAddress, maxSat, description, gameId, side}) {
  if (!walletId) return {ok: false, error: 'StreetFighter wallet is not configured.'}
  if (!lnAddress) return {ok: false, error: 'Lightning address is missing.'}
  if (!Number.isInteger(maxSat) || maxSat <= 0) {
    return {ok: false, error: 'Payout amount must be greater than zero.'}
  }
  const response = wallet.payLnurl({
    walletId,
    lnurl: lnAddress,
    amount: maxSat,
    currency: 'sat',
    comment: 'StreetFighter winnings',
    maxSat,
    description,
    extra: {
      streetfighter_game_id: gameId,
      streetfighter_winner_side: side
    }
  })
  return {
    ok: response.ok === true,
    error: response.error || '',
    checkingId: response.checkingId || '',
    paymentHash: response.paymentHash || '',
    status: response.status || '',
    amountMsat: Number(response.amountMsat || 0),
    feeMsat: Number(response.feeMsat || 0)
  }
}

function publishGameMessage(gameId, data) {
  websocket.publish(gameChannel(gameId), data)
}

function gameChannel(gameId) {
  const clean = cleanText(gameId, 96).replace(/[^A-Za-z0-9_.:-]/g, '_')
  if (!clean) throw new Error('gameId is required.')
  return `game_${clean}`.slice(0, 128)
}

function normalizeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('input must be an object.')
  }
  return {
    left: value.left === true,
    right: value.right === true,
    up: value.up === true,
    down: value.down === true,
    lightPunch: value.lightPunch === true,
    mediumPunch: value.mediumPunch === true,
    heavyPunch: value.heavyPunch === true,
    lightKick: value.lightKick === true,
    mediumKick: value.mediumKick === true,
    heavyKick: value.heavyKick === true
  }
}

function normalizeGameState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('state must be an object.')
  }
  return {
    sequence: normalizeInteger(value.sequence, 0, 0, 1000000000),
    time: normalizeInteger(value.time, 99, -2, 99),
    battleEnded: value.battleEnded === true,
    winnerId: normalizeOptionalInteger(value.winnerId, 0, 1),
    camera: normalizePoint(value.camera, -10000, 10000),
    fighters: normalizeFighterStates(value.fighters)
  }
}

function normalizeFighterStates(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('state.fighters must contain two fighters.')
  }
  return value.map(fighter => ({
    position: normalizePoint(fighter?.position, -10000, 10000),
    velocity: normalizePoint(fighter?.velocity, -10000, 10000),
    direction: Number(fighter?.direction) < 0 ? -1 : 1,
    currentState: cleanText(fighter?.currentState, 64),
    animationFrame: normalizeInteger(fighter?.animationFrame, 0, 0, 1000),
    hitPoints: normalizeInteger(fighter?.hitPoints, 200, 0, 200),
    score: normalizeInteger(fighter?.score, 0, 0, 1000000000),
    victory: fighter?.victory === true
  }))
}

function normalizePoint(value, min, max) {
  return {
    x: normalizeNumber(value?.x, 0, min, max),
    y: normalizeNumber(value?.y, 0, min, max)
  }
}

function normalizeOptionalInteger(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  return normalizeInteger(value, min, min, max)
}

function normalizeNumber(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function publicSettings(settings) {
  return {
    id: settings.id,
    enabled: settings.enabled === true,
    haircut: Number(settings.haircut || 0),
    walletId: settings.wallet_id || '',
    walletName: settings.wallet_name || '',
    createdAt: Number(settings.created_at || 0),
    updatedAt: Number(settings.updated_at || 0)
  }
}

function publicGame(game) {
  return {
    id: game.id,
    settingsId: game.settings_id,
    name: game.name,
    joinAmount: Number(game.join_amount || 0),
    haircut: Number(game.haircut || 0),
    playersCount: Number(game.players_count || 0),
    status: game.status || 'waiting',
    winnerSide: game.winner_side || '',
    winnerLnAddress: maskLnAddress(game.winner_ln_address || ''),
    payoutPending: game.payout_pending === true,
    payoutStatus: game.payout_status || '',
    createdAt: Number(game.created_at || 0),
    updatedAt: Number(game.updated_at || 0),
    startedAt: Number(game.started_at || 0),
    roundStartAt: Number(game.round_start_at || 0),
    completedAt: Number(game.completed_at || 0)
  }
}

function publicPlayer(player, includeToken) {
  return {
    id: includeToken ? player.id : '',
    gameId: player.game_id,
    lnAddress: maskLnAddress(player.ln_address),
    side: player.side || '',
    status: player.status || 'pending',
    paidAt: Number(player.paid_at || 0)
  }
}

function eventPaymentHash(event) {
  return cleanText(
    event.payment_hash ||
      event.paymentHash ||
      event.payment?.payment_hash ||
      event.payment?.paymentHash,
    256
  )
}

function normalizeLnAddress(value) {
  const text = requiredText(value, 'lnAddress', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error('Enter a valid Lightning address.')
  }
  return text
}

function normalizeSide(value) {
  const side = cleanText(value, 16).toLowerCase()
  if (!SIDES.includes(side)) throw new Error('winnerSide must be ryu or ken.')
  return side
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  const integer = Number.isFinite(number) ? Math.trunc(number) : fallback
  return Math.min(max, Math.max(min, integer))
}

function normalizePercent(value, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isFinite(number)) return fallback
  return Math.min(100, Math.max(0, number))
}

function normalizePage(value) {
  return normalizeInteger(value, 1, 1, 1000000)
}

function normalizePageSize(value) {
  return normalizeInteger(value, 10, 1, 100)
}

function normalizeGameSortBy(value) {
  const field = cleanText(value, 80)
  if (['name', 'join_amount', 'players_count', 'status', 'created_at', 'updated_at'].includes(field)) {
    return field
  }
  const camelToSnake = {
    joinAmount: 'join_amount',
    playersCount: 'players_count',
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  }
  return camelToSnake[field] || 'created_at'
}

function requiredText(value, field, maxLength) {
  const text = cleanText(value, maxLength)
  if (!text) throw new Error(`${field} is required.`)
  return text
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanId(value) {
  const text = cleanText(value, 128)
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : ''
}

function maskLnAddress(value) {
  const text = cleanText(value, 320)
  if (!text || !text.includes('@')) return text
  const [name, domain] = text.split('@')
  if (name.length <= 4) return `${name}@${domain}`
  return `${name.slice(0, 3)}...@${domain}`
}
