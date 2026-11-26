import assert from 'node:assert/strict'
import { accountBalance } from '../lib/account-balance.mjs'

const accountOf = (result) => ({ getBalance: async (client) => {
  assert.equal(client.locale, 'zh_CN')
  assert.equal(typeof client.timezoneOffsetSeconds, 'number')
  return result
} })
const bonusOnly = await accountBalance(accountOf({ status: 'ready', value: [], bonusWallets: [{ balance: '0.985', currency: 'CNY' }] }))
assert.deepEqual([bonusOnly.ok, bonusOnly.rechargeBalance, bonusOnly.bonusBalance, bonusOnly.totalBalance], [true, 0, 0.985, 0.985])
const zero = await accountBalance(accountOf({ status: 'ready', value: [{ balance: 0, currency: 'CNY' }], bonusWallets: [] }))
assert.equal(zero.ok, true)
assert.equal(zero.rechargeBalance, 0)
assert.equal((await accountBalance(accountOf(null))).code, 'NOT_LOGGED_IN')
assert.equal((await accountBalance(accountOf({ status: 'loading' }))).code, 'ACCOUNT_NOT_READY')
assert.equal((await accountBalance(null)).code, 'ACCOUNT_UNAVAILABLE')
console.log('account-balance: 5 cases passed')
