import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict
let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
source = source.replace(/^import .*\n\n/, '').replace(/export function /g, 'function ')

function createGame(joinAmount) {
  let storedGame = null
  const storage = {
    get(table) {
      if (table === 'streetfighter_settings') {
        return {id: 'streetfighterwasm-settings', enabled: true, wallet_id: 'wallet_1', haircut: 0}
      }
      return null
    },
    set(table, row) {
      if (table === 'streetfighter_games') storedGame = row
    }
  }
  const system = {
    id() { return {id: 'fight_1'} },
    now() { return 1_700_000_000 },
    log() {}
  }
  const createStreetfighterGame = Function(
    'storage', 'system', 'wallet', 'websocket',
    `${source}; return createStreetfighterGame`
  )(storage, system, {}, {})
  const response = JSON.parse(
    createStreetfighterGame(JSON.stringify({joinAmount}))
  )
  assert.equal(response.ok, true, response.error)
  return {game: response.data.game, storedGame}
}

for (const [requested, expected] of [[19, 20], [20, 20], [100_000_001, 100_000_001]]) {
  const result = createGame(requested)
  assert.equal(result.game.joinAmount, expected)
  assert.equal(result.storedGame.join_amount, expected)
}

console.log('Street Fighter minimum join amount tests passed')
