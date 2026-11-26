
export async function accountBalance(account, env = process.env) {
  if (!account || typeof account.getBalance !== 'function') {
    return { ok: false, code: 'ACCOUNT_UNAVAILABLE', error: '当前 DSH 没有账号余额服务' }
  }
  let result = null
  try {
    result = await account.getBalance({
      version: String(env.DSH_CLIENT_VERSION || env.DSH_VERSION || '') || 'unknown',
      locale: String(env.DSH_LOCALE || '') || 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
    })
  } catch (err) {
    return { ok: false, code: 'ACCOUNT_ERROR', error: String((err && err.message) || err).slice(0, 200) }
  }
  if (!result) return { ok: false, code: 'NOT_LOGGED_IN', error: '未登录 DeepSeek 账号' }
  if (result.status !== 'ready') {
    return { ok: false, code: 'ACCOUNT_NOT_READY', status: String(result.status || 'unknown'), error: '账号余额服务未就绪' }
  }
  const numberOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
  const usable = (list) => (Array.isArray(list) ? list : []).filter((w) => w && numberOf(w.balance) !== null)
  const rechargeWallets = usable(result.value)
  const bonusWallets = usable(result.bonusWallets)
  const all = rechargeWallets.concat(bonusWallets)
  if (!all.length) return { ok: false, code: 'NO_WALLET', error: '账号没有可用余额钱包' }
  const currencyOf = (w) => String(w.currency || 'CNY').toUpperCase()
  const nonzero = all.filter((w) => Number(w.balance) > 0)
  const chosen = nonzero.find((w) => currencyOf(w) === 'CNY') || nonzero[0]
    || all.find((w) => currencyOf(w) === 'CNY') || all[0]
  const currency = currencyOf(chosen)
  const sum = (list) => list.filter((w) => currencyOf(w) === currency)
    .reduce((n, w) => n + Number(w.balance), 0)
  const rechargeBalance = sum(rechargeWallets)
  const bonusBalance = sum(bonusWallets)
  return {
    ok: true,
    rechargeBalance: Number(rechargeBalance.toFixed(6)),
    bonusBalance: Number(bonusBalance.toFixed(6)),
    totalBalance: Number((rechargeBalance + bonusBalance).toFixed(6)),
    currency,
    balanceSource: 'account',
    updatedAt: new Date().toISOString()
  }
}
