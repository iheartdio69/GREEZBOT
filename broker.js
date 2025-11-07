// broker.js
class PaperBroker {
  constructor() { this.orders = []; }
  async placeBet({ market, side, odds, stake }) {
    const id = `ord_${Date.now()}`;
    this.orders.push({ id, ts: new Date().toISOString(), market, side, odds, stake, status: 'PLACED' });
    return { id, status: 'PLACED' };
  }
  list() { return this.orders.slice().reverse(); }
}
module.exports = { PaperBroker };
